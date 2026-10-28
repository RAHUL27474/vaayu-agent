// SQLite via Node's built-in driver (no native modules to compile).
const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');

// Vercel's filesystem is read-only except /tmp, which is wiped on cold start (demo use only).
const ON_VERCEL = Boolean(process.env.VERCEL);
const DATA_DIR = process.env.DATA_DIR || (ON_VERCEL ? '/tmp/vaayutrip/data' : path.join(__dirname, '..', 'data'));
const UPLOADS_DIR = process.env.UPLOADS_DIR || (ON_VERCEL ? '/tmp/vaayutrip/uploads' : path.join(__dirname, '..', 'public', 'uploads'));
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOADS_DIR, { recursive: true });
const DB_FILE = process.env.DB_FILE || path.join(DATA_DIR, 'vaayutrip.db');

const db = new DatabaseSync(DB_FILE);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
const hasTable = (name) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
if (hasTable('activities') && !hasTable('products')) db.exec('ALTER TABLE activities RENAME TO products');

db.exec(`
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS agencies (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  legal_name TEXT,
  gstin TEXT,
  pan TEXT,
  phone TEXT,
  email TEXT,
  address TEXT,
  city TEXT,
  logo_path TEXT,
  brand_color TEXT DEFAULT '#0e7490',
  status TEXT NOT NULL DEFAULT 'pending',          -- pending | active | suspended
  kyc_status TEXT NOT NULL DEFAULT 'pending',      -- pending | verified | rejected
  wallet_balance REAL NOT NULL DEFAULT 0,
  credit_limit REAL NOT NULL DEFAULT 0,
  credit_used REAL NOT NULL DEFAULT 0,
  markup_type TEXT NOT NULL DEFAULT 'percent',     -- percent | flat
  markup_value REAL NOT NULL DEFAULT 10,
  website_enabled INTEGER NOT NULL DEFAULT 1,
  website_tagline TEXT,
  website_about TEXT,
  api_key TEXT UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  role TEXT NOT NULL,                              -- admin | backend | agent
  agency_id INTEGER REFERENCES agencies(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  phone TEXT,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS packages (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  destination TEXT NOT NULL,
  nights INTEGER NOT NULL DEFAULT 3,
  theme TEXT,
  summary TEXT,
  itinerary TEXT,                                  -- one day per line
  inclusions TEXT,
  exclusions TEXT,
  image_url TEXT,
  status TEXT NOT NULL DEFAULT 'draft',            -- draft | published
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS package_items (
  id INTEGER PRIMARY KEY,
  package_id INTEGER NOT NULL REFERENCES packages(id) ON DELETE CASCADE,
  type TEXT NOT NULL,                              -- hotel | flight | transfer | activity | insurance | visa | meal | other
  title TEXT NOT NULL,
  description TEXT,
  net_price REAL NOT NULL,                         -- what the agent pays VaayuTrip, per booking
  sort INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY,
  agency_id INTEGER NOT NULL REFERENCES agencies(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  email TEXT,
  phone TEXT,
  city TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS leads (
  id INTEGER PRIMARY KEY,
  agency_id INTEGER NOT NULL REFERENCES agencies(id) ON DELETE CASCADE,
  customer_id INTEGER REFERENCES customers(id) ON DELETE SET NULL,
  package_id INTEGER REFERENCES packages(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  phone TEXT,
  email TEXT,
  destination TEXT,
  travel_date TEXT,
  pax INTEGER,
  budget REAL,
  source TEXT NOT NULL DEFAULT 'manual',           -- manual | website | api
  status TEXT NOT NULL DEFAULT 'new',              -- new | contacted | quoted | won | lost
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS quotes (
  id INTEGER PRIMARY KEY,
  agency_id INTEGER NOT NULL REFERENCES agencies(id) ON DELETE CASCADE,
  customer_id INTEGER REFERENCES customers(id) ON DELETE SET NULL,
  lead_id INTEGER REFERENCES leads(id) ON DELETE SET NULL,
  package_id INTEGER REFERENCES packages(id) ON DELETE SET NULL,
  code TEXT UNIQUE NOT NULL,
  title TEXT NOT NULL,
  travel_date TEXT,
  adults INTEGER NOT NULL DEFAULT 2,
  children INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'draft',            -- draft | sent | accepted | booked | cancelled
  markup_type TEXT NOT NULL DEFAULT 'percent',
  markup_value REAL NOT NULL DEFAULT 10,
  invoice_mode TEXT NOT NULL DEFAULT 'vaayu',      -- agent (agent-branded) | vaayu (VaayuTrip-branded)
  show_service_fee INTEGER NOT NULL DEFAULT 0,     -- vaayu mode: show agent commission as its own line
  notes TEXT,
  emi_enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS quote_items (
  id INTEGER PRIMARY KEY,
  quote_id INTEGER NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  supplier TEXT NOT NULL DEFAULT 'vaayu',          -- vaayu (bought from VaayuTrip) | agent (agent's own service)
  net_price REAL NOT NULL DEFAULT 0,               -- unit cost from VaayuTrip (0 for agent's own items)
  sell_price REAL,                                 -- unit price override; NULL = net + quote markup
  qty INTEGER NOT NULL DEFAULT 1,
  sort INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS bookings (
  id INTEGER PRIMARY KEY,
  agency_id INTEGER NOT NULL REFERENCES agencies(id) ON DELETE CASCADE,
  quote_id INTEGER REFERENCES quotes(id) ON DELETE SET NULL,
  customer_id INTEGER REFERENCES customers(id) ON DELETE SET NULL,
  code TEXT UNIQUE NOT NULL,
  title TEXT NOT NULL,
  travel_date TEXT,
  status TEXT NOT NULL DEFAULT 'confirmed',        -- confirmed | cancel_requested | cancelled
  total_net REAL NOT NULL,                         -- VaayuTrip net, before tax
  total_sell REAL NOT NULL,                        -- agent's selling price, before tax
  paid_wallet REAL NOT NULL DEFAULT 0,
  paid_credit REAL NOT NULL DEFAULT 0,
  cancel_reason TEXT,
  refund_amount REAL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS invoices (
  id INTEGER PRIMARY KEY,
  agency_id INTEGER NOT NULL REFERENCES agencies(id) ON DELETE CASCADE,
  quote_id INTEGER REFERENCES quotes(id) ON DELETE SET NULL,
  booking_id INTEGER REFERENCES bookings(id) ON DELETE SET NULL,
  number TEXT UNIQUE NOT NULL,
  kind TEXT NOT NULL,                              -- customer_agent | customer_vaayu | b2b (VaayuTrip -> agent)
  data TEXT NOT NULL,                              -- JSON snapshot: seller, buyer, lines, totals
  total REAL NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS wallet_txns (
  id INTEGER PRIMARY KEY,
  agency_id INTEGER NOT NULL REFERENCES agencies(id) ON DELETE CASCADE,
  type TEXT NOT NULL,                              -- topup | booking | refund | adjustment | credit_repay
  amount REAL NOT NULL,                            -- + credit to wallet, - debit
  balance_after REAL NOT NULL,
  ref TEXT,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS topup_requests (
  id INTEGER PRIMARY KEY,
  agency_id INTEGER NOT NULL REFERENCES agencies(id) ON DELETE CASCADE,
  amount REAL NOT NULL,
  utr TEXT,
  status TEXT NOT NULL DEFAULT 'pending',          -- pending | approved | rejected
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS payment_links (
  id INTEGER PRIMARY KEY,
  agency_id INTEGER NOT NULL REFERENCES agencies(id) ON DELETE CASCADE,
  quote_id INTEGER REFERENCES quotes(id) ON DELETE SET NULL,
  code TEXT UNIQUE NOT NULL,
  purpose TEXT NOT NULL,
  amount REAL NOT NULL,
  customer_name TEXT,
  status TEXT NOT NULL DEFAULT 'pending',          -- pending | paid | expired
  paid_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY,
  agency_id INTEGER REFERENCES agencies(id) ON DELETE CASCADE,  -- NULL = for VaayuTrip admins
  title TEXT NOT NULL,
  body TEXT,
  link TEXT,
  is_read INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Deals VaayuTrip promotes to all agents (shown on the dashboard and the Offers page).
CREATE TABLE IF NOT EXISTS offers (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  body TEXT,
  code TEXT,                                       -- optional promo code agents quote to customers
  link TEXT,                                       -- optional in-portal link, e.g. /agent/packages/goa-beach-escape
  valid_until TEXT,                                -- YYYY-MM-DD, inclusive; NULL = no end date
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS tickets (
  id INTEGER PRIMARY KEY,
  agency_id INTEGER NOT NULL REFERENCES agencies(id) ON DELETE CASCADE,
  code TEXT UNIQUE NOT NULL,
  subject TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'general',        -- booking | payment | technical | general
  booking_id INTEGER REFERENCES bookings(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'open',             -- open | answered | closed
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS ticket_messages (
  id INTEGER PRIMARY KEY,
  ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  from_admin INTEGER NOT NULL DEFAULT 0,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Inventory VaayuTrip supplies (activities, hotels, airfares, transfers, visas, insurance), entered by the
-- backend team. VaayuTrip sells no packages: agents build their own from these. See src/products.js.
CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL DEFAULT 'activity',           -- activity | hotel | flight | transfer | visa | insurance
  title TEXT NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  city TEXT NOT NULL,                              -- where it is used (flights: arrival city)
  country TEXT NOT NULL,
  category TEXT,                                   -- activity category, hotel type, transfer type…
  duration TEXT,                                   -- e.g. "4 hours", "Full day"
  summary TEXT,
  description TEXT,
  highlights TEXT,                                 -- one per line
  inclusions TEXT,
  exclusions TEXT,
  pickup TEXT,                                     -- pickup or meeting point
  timing TEXT,                                     -- start times, days of operation
  cancellation TEXT,
  image_url TEXT,
  price_basis TEXT NOT NULL DEFAULT 'per_person',  -- per_person | per_group | per_room_night
  group_size INTEGER,                              -- per_group: guests per group/vehicle
  net_adult REAL NOT NULL DEFAULT 0,               -- net per adult, per group, or per room per night
  net_child REAL,                                  -- per_person: net per child (2-11); NULL = adult price
  net_infant REAL,                                 -- per_person: net per infant (under 2); NULL = free
  details TEXT,                                    -- JSON, kind-specific (hotel room, flight schedule…)
  status TEXT NOT NULL DEFAULT 'draft',            -- draft | published
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Who did what: backend team, agents and admins. Shown to admins under Activity log.
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  role TEXT,
  agency_id INTEGER REFERENCES agencies(id) ON DELETE SET NULL,
  action TEXT NOT NULL,                            -- e.g. product.published, package.created, booking.created
  entity TEXT,
  entity_id INTEGER,
  summary TEXT,
  link TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS audit_log_created ON audit_log (created_at);
`);

const one = (sql, ...params) => db.prepare(sql).get(...params);
const all = (sql, ...params) => db.prepare(sql).all(...params);
const run = (sql, ...params) => db.prepare(sql).run(...params);

// Additive migrations: new columns are added to existing databases on start-up.
function addColumn(table, column, definition) {
  if (!all(`PRAGMA table_info(${table})`).some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
addColumn('packages', 'package_type', "TEXT NOT NULL DEFAULT 'customizable'");  // customizable | fixed
addColumn('packages', 'is_international', 'INTEGER NOT NULL DEFAULT 0');
addColumn('packages', 'departure_city', 'TEXT');
addColumn('packages', 'details', 'TEXT');                                         // JSON, see src/packages.js
addColumn('agencies', 'country', "TEXT NOT NULL DEFAULT 'India'");
addColumn('agencies', 'tax_id', 'TEXT');                                           // foreign agencies' tax registration number
addColumn('agencies', 'tax_doc', 'TEXT');                                          // file name under <data>/kyc, see src/kyc.js
addColumn('agencies', 'pan_doc', 'TEXT');                                          // PAN card (Indian agencies), same folder
addColumn('agencies', 'photo', 'TEXT');
addColumn('agencies', 'kyc_note', 'TEXT');                                         // why VaayuTrip sent the KYC back (shown to the agency)                                            // photo of the person who applied, same folder
addColumn('quotes', 'package_snapshot', 'TEXT');                                 // JSON frozen at quote time
addColumn('quotes', 'is_international', 'INTEGER NOT NULL DEFAULT 0');
addColumn('quotes', 'infants', 'INTEGER NOT NULL DEFAULT 0');
addColumn('packages', 'agency_id', 'INTEGER REFERENCES agencies(id) ON DELETE CASCADE');  // the agency that built it
if (all('PRAGMA table_info(quote_items)').some((c) => c.name === 'activity_id')) db.exec('ALTER TABLE quote_items RENAME COLUMN activity_id TO product_id');
addColumn('quote_items', 'product_id', 'INTEGER REFERENCES products(id) ON DELETE SET NULL');
for (const [col, def] of [['kind', "TEXT NOT NULL DEFAULT 'activity'"], ['net_infant', 'REAL'], ['details', 'TEXT'],
  ['created_by', 'INTEGER REFERENCES users(id) ON DELETE SET NULL'], ['updated_by', 'INTEGER REFERENCES users(id) ON DELETE SET NULL']]) addColumn('products', col, def);
addColumn('users', 'is_active', 'INTEGER NOT NULL DEFAULT 1');                     // staff accounts can be switched off
addColumn('quote_items', 'cost', 'REAL NOT NULL DEFAULT 0');                      // agent's own services: what they cost the agent, per unit
addColumn('bookings', 'total_cost', 'REAL NOT NULL DEFAULT 0');                    // agent's own costs for their services on the booking

function tx(fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

function getSettings() {
  return Object.fromEntries(all('SELECT key, value FROM settings').map((r) => [r.key, r.value]));
}

function setSetting(key, value) {
  run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, value);
}

/** Records an action for the admin's activity log. user: the acting user (or null for the system). */
function audit(user, action, { entity = null, id = null, summary = null, link = null, agencyId } = {}) {
  run(
    'INSERT INTO audit_log (user_id, role, agency_id, action, entity, entity_id, summary, link) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    user ? user.id : null, user ? user.role : 'system', agencyId !== undefined ? agencyId : user ? user.agency_id || null : null,
    action, entity, id, summary, link,
  );
}

function notify(agencyId, title, body, link) {
  run('INSERT INTO notifications (agency_id, title, body, link) VALUES (?, ?, ?, ?)', agencyId ?? null, title, body || null, link || null);
}

module.exports = { db, one, all, run, tx, getSettings, setSetting, notify, audit, DB_FILE, DATA_DIR, UPLOADS_DIR };
