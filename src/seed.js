/**
 * Demo data. Runs automatically on first start (empty database), or manually:
 *   npm run seed      (wipes and re-creates the local database; refused for the live Supabase database)
 */
const fs = require('fs');
const path = require('path');

if (require.main === module && process.argv.includes('--reset')) {
  if (process.env.DATABASE_URL) {
    console.error('Refusing to reset: DATABASE_URL points at the live database.');
    process.exit(1);
  }
  const dataDir = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
  fs.rmSync(process.env.PG_DIR || path.join(dataDir, 'pg'), { recursive: true, force: true });
}

const { one, all, run, tx, setSetting, getSettings, UPLOADS_DIR: UPLOADS } = require('./db');
const { writePersisted } = require('./files');
const { hashPassword, code, round2, uniqueSlug } = require('./util');
const { taxRate } = require('./pricing');
const { KYC_DIR } = require('./kyc');

// One-page PDF showing a line of text, so the demo agency has a certificate to review.
function samplePdf(text) {
  const stream = `BT /F1 14 Tf 60 760 Td (${text.replace(/[()\\]/g, '\\$&')}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = objects.map((body, i) => {
    const at = pdf.length;
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
    return at;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  return `${pdf}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
}

// Placeholder "photo" (a person silhouette on a tinted background) as a PNG, for demo KYC.
function samplePhoto([r, g, b]) {
  const zlib = require('zlib');
  const size = 160;
  const raw = Buffer.alloc((size * 3 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 3 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const head = (x - 80) ** 2 + (y - 62) ** 2 < 30 ** 2;
      const body = y > 100 && ((x - 80) / 56) ** 2 + ((y - 168) / 66) ** 2 < 1;
      const px = head || body ? [r, g, b] : [226, 232, 240];
      raw.set(px, y * (size * 3 + 1) + 1 + x * 3);
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(Buffer.concat([Buffer.from(type), data])));
    return Buffer.concat([len, Buffer.from(type), data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

// Demo KYC files for an agency: GST certificate, PAN card and the applicant's photo.
async function seedKyc(agencyId, slug, name, gstin, colour) {
  const pan = gstin.slice(2, 12);
  const files = { tax_doc: `demo-${slug}-gst.pdf`, pan_doc: `demo-${slug}-pan.pdf`, photo: `demo-${slug}-photo.png` };
  await writePersisted(path.join(KYC_DIR, files.tax_doc), samplePdf(`SAMPLE GST certificate - ${name}, GSTIN ${gstin} (demo data)`));
  await writePersisted(path.join(KYC_DIR, files.pan_doc), samplePdf(`SAMPLE PAN card - ${name}, PAN ${pan} (demo data)`));
  await writePersisted(path.join(KYC_DIR, files.photo), samplePhoto(colour));
  await run('UPDATE agencies SET gstin = ?, pan = ?, tax_doc = ?, pan_doc = ?, photo = ? WHERE id = ?', gstin, pan, files.tax_doc, files.pan_doc, files.photo, agencyId);
}

const INVENTORY = require('./seed-inventory');
const AGENT_PACKAGES = require('./seed-agent-packages');

const PRODUCT_FIELDS = ['kind', 'title', 'city', 'country', 'category', 'duration', 'summary', 'description', 'highlights', 'inclusions', 'exclusions', 'pickup',
  'timing', 'cancellation', 'price_basis', 'group_size', 'net_adult', 'net_child', 'net_infant', 'details'];

// Inventory as if entered and published by the backend team.
async function insertProduct(p, userId) {
  return (await run(
    `INSERT INTO products (${PRODUCT_FIELDS.join(', ')}, slug, status, created_by, updated_by) VALUES (${PRODUCT_FIELDS.map(() => '?').join(', ')}, ?, 'published', ?, ?)`,
    ...PRODUCT_FIELDS.map((k) => p[k] ?? null), await uniqueSlug('products', `${p.title} ${p.city}`), userId, userId,
  )).lastInsertRowid;
}

async function insertAgentPackage(p) {
  const agency = await one('SELECT id FROM agencies WHERE slug = ?', p.agency);
  const product = async (title) => {
    const found = await one('SELECT id, kind FROM products WHERE title = ?', title);
    if (!found) throw new Error(`Demo package ${p.title} uses unknown inventory "${title}"`);
    return found;
  };
  const details = {
    route: p.route.map(([city, nights]) => ({ city, nights })),
    highlights: p.highlights,
    days: p.days.map(([title, description, meals, overnight]) => ({ title, description, meals: { b: meals.includes('B'), l: meals.includes('L'), d: meals.includes('D') }, overnight })),
    items: await Promise.all(p.items.map(async ([day, title, nights]) => {
      const x = await product(title);
      return { day, id: x.id, kind: x.kind, title, ...(x.kind === 'hotel' ? { nights: nights || 1 } : {}) };
    })),
    stays: p.stays.map(([city, hotel, type, stars, room, mealPlan, nights, price, cost]) => ({ city, hotel, type, stars, room, mealPlan, nights, cost, price })),
    extras: p.extras.map(([type, title, description, basis, price, cost]) => ({ type, title, description, basis, cost, price })),
    policies: p.policies,
  };
  return (await run(
    `INSERT INTO packages (agency_id, title, slug, destination, nights, theme, summary, inclusions, exclusions, is_international, departure_city, details, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    agency.id, p.title, await uniqueSlug('packages', p.title), p.destination, p.nights, p.theme, p.summary, p.inclusions, p.exclusions,
    1, p.departure_city, JSON.stringify(details), p.status,
  )).lastInsertRowid;
}

const SKYLINE_LOGO = `<svg xmlns="http://www.w3.org/2000/svg" width="240" height="64" viewBox="0 0 240 64">
<rect x="4" y="8" width="48" height="48" rx="12" fill="#7c3aed"/>
<path d="M14 42 L24 26 L31 35 L36 29 L44 42 Z" fill="#fff"/>
<circle cx="38" cy="20" r="4" fill="#fde68a"/>
<text x="62" y="32" font-family="Segoe UI, Arial, sans-serif" font-size="22" font-weight="700" fill="#1f2937">Skyline</text>
<text x="62" y="52" font-family="Segoe UI, Arial, sans-serif" font-size="14" fill="#6b7280" letter-spacing="2">HOLIDAYS</text>
</svg>`;

// Everything happens in one transaction holding a lock, so two servers starting together seed only once.
async function seed() {
  if (await one('SELECT 1 FROM users LIMIT 1')) return false; // usual case: nothing to do, no lock
  return tx(async () => {
    await run('SELECT pg_advisory_xact_lock(731002)');
    if (await one('SELECT 1 FROM users LIMIT 1')) return false;
    await seedAll();
    return true;
  });
}

async function seedAll() {
  await writePersisted(path.join(UPLOADS, 'skyline-holidays-logo.svg'), SKYLINE_LOGO);

  await tx(async () => {
    await setSetting('company_name', 'VaayuTrip');
    await setSetting('legal_name', 'VaayuTrip Travel Pvt. Ltd.');
    await setSetting('gstin', '07AABCV1234F1Z5');
    await setSetting('address', '2nd Floor, Aerocity Business Park, New Delhi 110037');
    await setSetting('phone', '+91 98100 00000');
    await setSetting('email', 'support@vaayutrip.com');
    await setSetting('tax_rate', '5');
    await setSetting('emi_rate', '14');
    await setSetting('tcs_rate', '5');
    await setSetting('gst_enabled', '0');
    await setSetting('tier_silver_pct', '1');
    await setSetting('tier_gold_pct', '2');

    await run('INSERT INTO users (role, name, email, password_hash) VALUES (?, ?, ?, ?)', 'admin', 'VaayuTrip Admin', 'admin@vaayutrip.com', hashPassword('admin123'));
    const backendUser = (await run('INSERT INTO users (role, name, email, password_hash) VALUES (?, ?, ?, ?)', 'backend', 'Meera Iyer (Backend team)', 'backend@vaayutrip.com', hashPassword('backend123'))).lastInsertRowid;

    const skyline = (await run(
      `INSERT INTO agencies (name, slug, legal_name, gstin, phone, email, address, city, logo_path, brand_color, status, kyc_status,
         wallet_balance, credit_limit, markup_type, markup_value, website_tagline, website_about, api_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', 'verified', ?, ?, 'percent', 12, ?, ?, ?)`,
      'Skyline Holidays', 'skyline-holidays', 'Skyline Holidays LLP', '27AAKFS5678K1Z2', '+91 98200 11111', 'hello@skylineholidays.in',
      '14 Linking Road, Bandra West', 'Mumbai', '/uploads/skyline-holidays-logo.svg', '#7c3aed', 500000, 300000,
      'Handpicked holidays from Mumbai since 2012', 'We design stress-free holidays to Dubai, Bali, Vietnam, Cambodia, the UK and Europe, with 24x7 support on every trip.',
      `vt_live_${code('K', 24).slice(2).toLowerCase()}`,
    )).lastInsertRowid;
    await seedKyc(skyline, 'skyline', 'Skyline Holidays LLP', '27AAKFS5678K1Z2', [124, 58, 237]);
    await run('INSERT INTO users (role, agency_id, name, email, phone, password_hash) VALUES (?, ?, ?, ?, ?, ?)', 'agent', skyline, 'Priya Sharma', 'agent@skyline.com', '+91 98200 11111', hashPassword('agent123'));
    await run("INSERT INTO wallet_txns (agency_id, type, amount, balance_after, ref, note, created_at) VALUES (?, 'topup', 500000, 500000, 'UTR8812004411', 'Opening top-up', datetime('now', '-6 months', '-12 days'))", skyline);

    const ravi = (await run(
      `INSERT INTO agencies (name, slug, phone, email, city, status, kyc_status, wallet_balance, credit_limit, markup_type, markup_value)
       VALUES (?, ?, ?, ?, ?, 'active', 'verified', ?, 0, 'flat', 3000)`,
      'Ravi Tours & Travels', 'ravi-tours', '+91 99100 22222', 'ravi.tours@gmail.com', 'Lucknow', 60000,
    )).lastInsertRowid;
    await seedKyc(ravi, 'ravi', 'Ravi Tours & Travels', '09AAHFR4321P1Z7', [30, 64, 175]);
    await run('INSERT INTO users (role, agency_id, name, email, phone, password_hash) VALUES (?, ?, ?, ?, ?, ?)', 'agent', ravi, 'Ravi Verma', 'agent@ravitours.com', '+91 99100 22222', hashPassword('agent123'));
    await run("INSERT INTO wallet_txns (agency_id, type, amount, balance_after, ref, note) VALUES (?, 'topup', 60000, 60000, 'UTR5521009922', 'Opening top-up')", ravi);

    const pending = (await run(
      "INSERT INTO agencies (name, slug, phone, email, city, gstin, pan, tax_doc) VALUES ('Wanderlust Trips', 'wanderlust-trips', '+91 90000 33333', 'contact@wanderlust.in', 'Pune', '27AABCW1234M1Z9', 'AABCW1234M', 'demo-wanderlust-gst.pdf')",
    )).lastInsertRowid;
    await seedKyc(pending, 'wanderlust', 'Wanderlust Trips', '27AABCW1234M1Z9', [234, 88, 12]);
    await run('INSERT INTO users (role, agency_id, name, email, password_hash) VALUES (?, ?, ?, ?, ?)', 'agent', pending, 'Arjun Mehta', 'agent@wanderlust.in', hashPassword('agent123'));
    await run("INSERT INTO notifications (agency_id, title, body, link) VALUES (NULL, 'New agent signup', 'Wanderlust Trips (Pune) is waiting for approval.', '/admin/agents')");

    for (const p of INVENTORY) await insertProduct(p, backendUser);
    await run("INSERT INTO audit_log (user_id, role, action, entity, summary, link, created_at) VALUES (?, 'backend', 'product.imported', 'product', ?, '/backend/products', datetime('now', '-7 months'))",
      backendUser, `Imported ${INVENTORY.length} products and published them`);
    for (const p of AGENT_PACKAGES) await insertAgentPackage(p);
    // VaayuTrip's own ready-made packages: the demo agency's published ones, without the agency's own hotels and services.
    for (const p of await all("SELECT * FROM packages WHERE agency_id = ? AND status = 'published'", skyline)) {
      const d = JSON.parse(p.details);
      d.stays = [];
      d.extras = [];
      await run(
        `INSERT INTO packages (agency_id, title, slug, destination, nights, theme, summary, inclusions, exclusions, is_international, departure_city, details, status)
         VALUES (NULL, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, 'published')`,
        p.title, await uniqueSlug('packages', `vaayutrip ${p.title}`), p.destination, p.nights, p.theme, p.summary, p.inclusions, p.exclusions, p.departure_city, JSON.stringify(d),
      );
    }

    const c1 = (await run("INSERT INTO customers (agency_id, name, email, phone, city) VALUES (?, 'Ananya & Rohit Kapoor', 'ananya.k@example.com', '+91 98765 43210', 'Mumbai')", skyline)).lastInsertRowid;
    await run("INSERT INTO customers (agency_id, name, email, phone, city) VALUES (?, 'Mehta Family', 'vikram.mehta@example.com', '+91 98111 22334', 'Thane')", skyline);
    await run("INSERT INTO customers (agency_id, name, phone, city) VALUES (?, 'Sunil Yadav', '+91 94150 55667', 'Lucknow')", ravi);

    await run("INSERT INTO leads (agency_id, name, phone, destination, travel_date, pax, budget, source, status, notes) VALUES (?, 'Neha Joshi', '+91 99887 76655', 'Vietnam', '2026-12-18', 4, 400000, 'website', 'new', 'Family of 4, wants Ha Long Bay and Hoi An')", skyline);
    await run("INSERT INTO leads (agency_id, customer_id, name, phone, destination, travel_date, pax, budget, status) VALUES (?, ?, 'Ananya & Rohit Kapoor', '+91 98765 43210', 'Bali', '2026-11-20', 2, 250000, 'quoted')", skyline, c1);

  });

  // A ready-made quote so the quote editor and invoices can be tried immediately.
  const svc = require('./services');
  const skylineAgency = await one("SELECT * FROM agencies WHERE slug = 'skyline-holidays'");
  const customer = await one("SELECT id FROM customers WHERE name = 'Ananya & Rohit Kapoor'");
  const bali = await one("SELECT id FROM packages WHERE slug = 'bali-honeymoon-escape'");
  const quoteId = await svc.createQuoteFromPackage(skylineAgency, bali.id, {
    title: 'Bali Honeymoon Escape — Kapoor honeymoon', customerId: customer.id, date: '2026-11-20', rooms: 1, adults: 2,
  });
  await run("UPDATE quotes SET status = 'sent', invoice_mode = 'agent' WHERE id = ?", quoteId);
  await seedBookingHistory(svc, skylineAgency);
  await seedOffersAndSupport(skylineAgency);
  return true;
}

async function seedOffersAndSupport(agency) {
  const offers = [
    ['Dubai hotels: 4th night free', 'Stay 4 nights at Al Barsha Grand Hotel, pay for 3. Applied to the net rate at booking, for travel until 15 December.', 'DXB4FOR3', '/agent/hotels?dest=Dubai', "sqldate('now', '+45 days')"],
    ['Extra 2% commission on Europe bookings', 'Book any Europe airfare, hotel or activity this month and earn 2% over your usual markup, credited to your wallet after travel.', null, '/agent/hotels?dest=Europe', "sqldate('now', 'start of month', '+1 month', '-1 day')"],
    ['Vietnam e-visa at ₹1,800', 'Special net rate on the 30-day Vietnam e-visa for bookings this month.', 'VNVISA', '/agent/visas?dest=Vietnam', "sqldate('now', '+30 days')"],
  ];
  for (const [title, body, promo, link, until] of offers) await run(`INSERT INTO offers (title, body, code, link, valid_until) VALUES (?, ?, ?, ?, ${until})`, title, body, promo, link);

  const user = await one('SELECT id FROM users WHERE agency_id = ?', agency.id);
  const booking = await one('SELECT id, code FROM bookings WHERE agency_id = ? ORDER BY id LIMIT 1', agency.id);
  const ticket = (await run(
    "INSERT INTO tickets (agency_id, code, subject, category, booking_id, status, created_at, updated_at) VALUES (?, ?, 'Senior guests on the Abu Dhabi day trip', 'booking', ?, 'answered', datetime('now', '-2 days'), datetime('now', '-1 day'))",
    agency.id, code('T'), booking ? booking.id : null,
  )).lastInsertRowid;
  await run("INSERT INTO ticket_messages (ticket_id, user_id, body, created_at) VALUES (?, ?, ?, datetime('now', '-2 days'))", ticket, user.id,
    'Two of the guests on this booking are above 70. Can the Abu Dhabi tour keep the walking short and arrange a wheelchair at the Grand Mosque?');
  await run("INSERT INTO ticket_messages (ticket_id, from_admin, body, created_at) VALUES (?, 1, ?, datetime('now', '-1 day'))", ticket,
    "Done. The guide will use the drop-off point closest to the mosque entrance and a wheelchair will be waiting. We've added a note to the voucher.");
}

// Past bookings for Skyline, made through the normal booking flow and then backdated,
// so the dashboard chart and reports have something to show.
async function seedBookingHistory(svc, agency) {
  const mehta = await one("SELECT id FROM customers WHERE name = 'Mehta Family'");
  const kapoor = await one("SELECT id FROM customers WHERE name = 'Ananya & Rohit Kapoor'");
  const agentUser = await one('SELECT id FROM users WHERE agency_id = ?', agency.id);
  for (const p of await all('SELECT id, title FROM packages WHERE agency_id = ?', agency.id)) {
    await run("INSERT INTO audit_log (user_id, role, agency_id, action, entity, entity_id, summary, created_at) VALUES (?, 'agent', ?, 'package.created', 'package', ?, ?, datetime('now', '-6 months'))", agentUser.id, agency.id, p.id, p.title);
  }
  const history = [
    { monthsAgo: 5, slug: 'dubai-family-fun', date: '2026-11-08', title: 'Dubai Family Fun — Mehta family', customerId: mehta.id, adults: 2, children: 2 },
    { monthsAgo: 4, slug: 'vietnam-highlights', date: '2026-12-12', title: 'Vietnam Highlights — Iyer anniversary', adults: 2 },
    { monthsAgo: 3, slug: 'angkor-and-phnom-penh', date: '2027-01-15', title: 'Angkor and Phnom Penh — Sharma friends', adults: 3 },
    { monthsAgo: 2, slug: 'bali-honeymoon-escape', date: '2026-12-27', title: 'Bali Honeymoon — Nair couple', adults: 2 },
    { monthsAgo: 1, slug: 'paris-and-the-swiss-alps', date: '2027-04-06', title: 'Paris and the Swiss Alps — Kapoor parents', customerId: kapoor.id, adults: 2 },
    { monthsAgo: 0, slug: 'london-and-edinburgh', date: '2027-05-09', title: 'London and Edinburgh — Rao family', adults: 2, children: 1 },
  ];
  for (const h of history) {
    const pkg = await one('SELECT id FROM packages WHERE slug = ?', h.slug);
    if (!pkg) continue;
    const quoteId = await svc.createQuoteFromPackage(agency, pkg.id, { title: h.title, customerId: h.customerId || null, date: h.date, adults: h.adults, children: h.children || 0 });
    // Top up exactly what the booking will cost so the demo wallet keeps its opening balance.
    const net = (await svc.getQuote(quoteId, agency.id)).priced.net;
    const utr = `UTR${String(7700000000 + quoteId * 7919).slice(0, 10)}`;
    await svc.moveWallet(agency.id, 'topup', round2(net * (1 + taxRate(await getSettings()) / 100)), utr, 'Bank transfer');
    const bookingId = await svc.bookQuote(agency.id, quoteId);
    const when = `datetime('now', '-${h.monthsAgo} months', '-${3 + h.monthsAgo * 2} days')`;
    const b = await one('SELECT code FROM bookings WHERE id = ?', bookingId);
    await run(`UPDATE bookings SET created_at = ${when} WHERE id = ?`, bookingId);
    await run(`UPDATE quotes SET created_at = ${when}, updated_at = ${when} WHERE id = ?`, quoteId);
    await run(`UPDATE invoices SET created_at = ${when} WHERE booking_id = ?`, bookingId);
    await run(`UPDATE wallet_txns SET created_at = ${when} WHERE ref IN (?, ?)`, b.code, utr);
    await run(`INSERT INTO audit_log (user_id, role, agency_id, action, entity, entity_id, summary, link, created_at) VALUES (?, 'agent', ?, 'booking.created', 'booking', ?, ?, ?, ${when})`,
      agentUser.id, agency.id, bookingId, `${h.title} (${b.code})`, `/admin/bookings/${bookingId}`);
  }
  await run("DELETE FROM notifications WHERE title IN ('New booking', 'Booking confirmed')");
}

module.exports = { seed };

if (require.main === module) {
  seed().then((created) => {
    console.log(created ? 'Seeded demo data.' : 'Database already has data; run "npm run seed" to reset.');
    process.exit(0);
  }, (e) => { console.error(e); process.exit(1); });
}
