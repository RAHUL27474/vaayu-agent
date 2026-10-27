/**
 * Demo data. Runs automatically on first start (empty database), or manually:
 *   npm run seed      (wipes and re-creates the database)
 */
const fs = require('fs');
const path = require('path');

if (require.main === module && process.argv.includes('--reset')) {
  const file = process.env.DB_FILE || path.join(__dirname, '..', 'data', 'vaayutrip.db');
  for (const f of [file, `${file}-wal`, `${file}-shm`]) fs.rmSync(f, { force: true });
}

const { one, run, tx, setSetting, getSettings, UPLOADS_DIR: UPLOADS } = require('./db');
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

const ACTIVITIES = require('./seed-activities');
const AGENT_PACKAGES = require('./seed-agent-packages');

const ACT_FIELDS = ['title', 'city', 'country', 'category', 'duration', 'summary', 'description', 'highlights', 'inclusions', 'exclusions', 'pickup', 'timing',
  'cancellation', 'price_basis', 'group_size', 'net_adult', 'net_child'];

function insertActivity(a) {
  const row = { country: 'India', description: null, group_size: null, net_child: null, ...a };
  return run(
    `INSERT INTO activities (${ACT_FIELDS.join(', ')}, slug, status) VALUES (${ACT_FIELDS.map(() => '?').join(', ')}, ?, 'published')`,
    ...ACT_FIELDS.map((k) => row[k] ?? null), uniqueSlug('activities', `${a.title} ${a.city}`),
  ).lastInsertRowid;
}

function insertAgentPackage(p) {
  const agency = one('SELECT id FROM agencies WHERE slug = ?', p.agency);
  const activityId = (title) => {
    const a = one('SELECT id FROM activities WHERE title = ?', title);
    if (!a) throw new Error(`Demo package ${p.title} uses unknown activity "${title}"`);
    return a.id;
  };
  const details = {
    route: p.route.map(([city, nights]) => ({ city, nights })),
    highlights: p.highlights,
    days: p.days.map(([title, description, meals, overnight]) => ({ title, description, meals: { b: meals.includes('B'), l: meals.includes('L'), d: meals.includes('D') }, overnight })),
    activities: p.activities.map(([day, title]) => ({ day, id: activityId(title), title })),
    stays: p.stays.map(([city, hotel, type, stars, room, mealPlan, nights, price, cost]) => ({ city, hotel, type, stars, room, mealPlan, nights, cost, price })),
    extras: p.extras.map(([type, title, description, basis, price, cost]) => ({ type, title, description, basis, cost, price })),
    policies: p.policies,
  };
  return run(
    `INSERT INTO packages (agency_id, title, slug, destination, nights, theme, summary, inclusions, exclusions, is_international, departure_city, details, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    agency.id, p.title, uniqueSlug('packages', p.title), p.destination, p.nights, p.theme, p.summary, p.inclusions, p.exclusions,
    p.is_international || 0, p.departure_city, JSON.stringify(details), p.status,
  ).lastInsertRowid;
}

const SKYLINE_LOGO = `<svg xmlns="http://www.w3.org/2000/svg" width="240" height="64" viewBox="0 0 240 64">
<rect x="4" y="8" width="48" height="48" rx="12" fill="#7c3aed"/>
<path d="M14 42 L24 26 L31 35 L36 29 L44 42 Z" fill="#fff"/>
<circle cx="38" cy="20" r="4" fill="#fde68a"/>
<text x="62" y="32" font-family="Segoe UI, Arial, sans-serif" font-size="22" font-weight="700" fill="#1f2937">Skyline</text>
<text x="62" y="52" font-family="Segoe UI, Arial, sans-serif" font-size="14" fill="#6b7280" letter-spacing="2">HOLIDAYS</text>
</svg>`;

function seed() {
  if (one('SELECT 1 FROM users LIMIT 1')) return false;
  fs.mkdirSync(UPLOADS, { recursive: true });
  fs.writeFileSync(path.join(UPLOADS, 'skyline-holidays-logo.svg'), SKYLINE_LOGO);

  tx(() => {
    setSetting('company_name', 'VaayuTrip');
    setSetting('legal_name', 'VaayuTrip Travel Pvt. Ltd.');
    setSetting('gstin', '07AABCV1234F1Z5');
    setSetting('address', '2nd Floor, Aerocity Business Park, New Delhi 110037');
    setSetting('phone', '+91 98100 00000');
    setSetting('email', 'support@vaayutrip.com');
    setSetting('tax_rate', '5');
    setSetting('emi_rate', '14');
    setSetting('tcs_rate', '2');

    run('INSERT INTO users (role, name, email, password_hash) VALUES (?, ?, ?, ?)', 'admin', 'VaayuTrip Admin', 'admin@vaayutrip.com', hashPassword('admin123'));

    const skyline = run(
      `INSERT INTO agencies (name, slug, legal_name, gstin, phone, email, address, city, logo_path, brand_color, status, kyc_status,
         wallet_balance, credit_limit, markup_type, markup_value, website_tagline, website_about, api_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', 'verified', ?, ?, 'percent', 12, ?, ?, ?)`,
      'Skyline Holidays', 'skyline-holidays', 'Skyline Holidays LLP', '27AAKFS5678K1Z2', '+91 98200 11111', 'hello@skylineholidays.in',
      '14 Linking Road, Bandra West', 'Mumbai', '/uploads/skyline-holidays-logo.svg', '#7c3aed', 150000, 100000,
      'Handpicked holidays from Mumbai since 2012', 'We design stress-free family holidays across India and abroad, with 24x7 support on every trip.',
      `vt_live_${code('K', 24).slice(2).toLowerCase()}`,
    ).lastInsertRowid;
    run("UPDATE agencies SET pan = 'AAKFS5678K', tax_doc = 'demo-skyline-gst.pdf' WHERE id = ?", skyline);
    fs.writeFileSync(path.join(KYC_DIR, 'demo-skyline-gst.pdf'), samplePdf('SAMPLE GST certificate - Skyline Holidays LLP, GSTIN 27AAKFS5678K1Z2 (demo data)'));
    run('INSERT INTO users (role, agency_id, name, email, phone, password_hash) VALUES (?, ?, ?, ?, ?, ?)', 'agent', skyline, 'Priya Sharma', 'agent@skyline.com', '+91 98200 11111', hashPassword('agent123'));
    run("INSERT INTO wallet_txns (agency_id, type, amount, balance_after, ref, note, created_at) VALUES (?, 'topup', 150000, 150000, 'UTR8812004411', 'Opening top-up', datetime('now', '-6 months', '-12 days'))", skyline);

    const ravi = run(
      `INSERT INTO agencies (name, slug, phone, email, city, status, kyc_status, wallet_balance, credit_limit, markup_type, markup_value)
       VALUES (?, ?, ?, ?, ?, 'active', 'verified', ?, 0, 'flat', 3000)`,
      'Ravi Tours & Travels', 'ravi-tours', '+91 99100 22222', 'ravi.tours@gmail.com', 'Lucknow', 60000,
    ).lastInsertRowid;
    run('INSERT INTO users (role, agency_id, name, email, phone, password_hash) VALUES (?, ?, ?, ?, ?, ?)', 'agent', ravi, 'Ravi Verma', 'agent@ravitours.com', '+91 99100 22222', hashPassword('agent123'));
    run("INSERT INTO wallet_txns (agency_id, type, amount, balance_after, ref, note) VALUES (?, 'topup', 60000, 60000, 'UTR5521009922', 'Opening top-up')", ravi);

    const pending = run(
      "INSERT INTO agencies (name, slug, phone, email, city, gstin, pan, tax_doc) VALUES ('Wanderlust Trips', 'wanderlust-trips', '+91 90000 33333', 'contact@wanderlust.in', 'Pune', '27AABCW1234M1Z9', 'AABCW1234M', 'demo-wanderlust-gst.pdf')",
    ).lastInsertRowid;
    fs.writeFileSync(path.join(KYC_DIR, 'demo-wanderlust-gst.pdf'), samplePdf('SAMPLE GST certificate - Wanderlust Trips, GSTIN 27AABCW1234M1Z9 (demo data)'));
    run('INSERT INTO users (role, agency_id, name, email, password_hash) VALUES (?, ?, ?, ?, ?)', 'agent', pending, 'Arjun Mehta', 'agent@wanderlust.in', hashPassword('agent123'));
    run("INSERT INTO notifications (agency_id, title, body, link) VALUES (NULL, 'New agent signup', 'Wanderlust Trips (Pune) is waiting for approval.', '/admin/agents')");

    for (const a of ACTIVITIES) insertActivity(a);
    for (const p of AGENT_PACKAGES) insertAgentPackage(p);

    const c1 = run("INSERT INTO customers (agency_id, name, email, phone, city) VALUES (?, 'Ananya & Rohit Kapoor', 'ananya.k@example.com', '+91 98765 43210', 'Mumbai')", skyline).lastInsertRowid;
    run("INSERT INTO customers (agency_id, name, email, phone, city) VALUES (?, 'Mehta Family', 'vikram.mehta@example.com', '+91 98111 22334', 'Thane')", skyline);
    run("INSERT INTO customers (agency_id, name, phone, city) VALUES (?, 'Sunil Yadav', '+91 94150 55667', 'Lucknow')", ravi);

    run("INSERT INTO leads (agency_id, name, phone, destination, travel_date, pax, budget, source, status, notes) VALUES (?, 'Neha Joshi', '+91 99887 76655', 'Kashmir', '2026-12-18', 4, 120000, 'website', 'new', 'Family of 4, wants houseboat stay')", skyline);
    run("INSERT INTO leads (agency_id, customer_id, name, phone, destination, travel_date, pax, budget, status) VALUES (?, ?, 'Ananya & Rohit Kapoor', '+91 98765 43210', 'Goa', '2026-11-20', 2, 40000, 'quoted')", skyline, c1);

  });

  // A ready-made quote so the quote editor and invoices can be tried immediately.
  const svc = require('./services');
  const skylineAgency = one("SELECT * FROM agencies WHERE slug = 'skyline-holidays'");
  const customer = one("SELECT id FROM customers WHERE name = 'Ananya & Rohit Kapoor'");
  const goa = one("SELECT id FROM packages WHERE slug = 'goa-beach-escape'");
  const quoteId = svc.createQuoteFromPackage(skylineAgency, goa.id, {
    title: 'Goa Beach Escape — Kapoor honeymoon', customerId: customer.id, date: '2026-11-20', rooms: 1, adults: 2,
  });
  svc.addQuoteItem(quoteId, { type: 'other', title: 'Honeymoon cake & room decoration', description: 'Arranged by Skyline Holidays', supplier: 'agent', net: 0, sell: 2500 });
  run("UPDATE quotes SET status = 'sent', invoice_mode = 'agent' WHERE id = ?", quoteId);
  seedBookingHistory(svc, skylineAgency);
  seedOffersAndSupport(skylineAgency);
  return true;
}

function seedOffersAndSupport(agency) {
  const offers = [
    ['Gulmarg gondola winter special: ₹300 off per guest', 'On Gulmarg gondola phase 1 and 2 tickets for travel between 1 Dec and 28 Feb. Applied to the net rate at booking.', 'SNOW300', '/agent/activities?city=Gulmarg', "date('now', '+45 days')"],
    ['Extra 2% commission on international activities', 'Book any activity outside India this month and earn 2% over your usual markup, credited to your wallet after travel.', null, '/agent/activities?region=abroad', "date('now', 'start of month', '+1 month', '-1 day')"],
    ['Kids go free on Goa water sports', 'One child free per paying adult on the Calangute water sports combo.', 'GOAKIDS', '/agent/activities?city=Goa', "date('now', '+30 days')"],
  ];
  for (const [title, body, promo, link, until] of offers) run(`INSERT INTO offers (title, body, code, link, valid_until) VALUES (?, ?, ?, ?, ${until})`, title, body, promo, link);

  const user = one('SELECT id FROM users WHERE agency_id = ?', agency.id);
  const booking = one('SELECT id, code FROM bookings WHERE agency_id = ? ORDER BY id LIMIT 1', agency.id);
  const ticket = run(
    "INSERT INTO tickets (agency_id, code, subject, category, booking_id, status, created_at, updated_at) VALUES (?, ?, 'Senior guests on the Jaipur tour', 'booking', ?, 'answered', datetime('now', '-2 days'), datetime('now', '-1 day'))",
    agency.id, code('T'), booking ? booking.id : null,
  ).lastInsertRowid;
  run("INSERT INTO ticket_messages (ticket_id, user_id, body, created_at) VALUES (?, ?, ?, datetime('now', '-2 days'))", ticket, user.id,
    'Two of the Mehta family guests are above 70. Can the Amber Fort tour use the jeep route up to the fort and keep the walking short?');
  run("INSERT INTO ticket_messages (ticket_id, from_admin, body, created_at) VALUES (?, 1, ?, datetime('now', '-1 day'))", ticket,
    "Done. The guide will take the jeep route up to Amber Fort and skip the long walk at Jantar Mantar. We've added a note to the voucher. A wheelchair is available at the fort on request.");
}

// Past bookings for Skyline, made through the normal booking flow and then backdated,
// so the dashboard chart and reports have something to show.
function seedBookingHistory(svc, agency) {
  const mehta = one("SELECT id FROM customers WHERE name = 'Mehta Family'");
  const kapoor = one("SELECT id FROM customers WHERE name = 'Ananya & Rohit Kapoor'");
  const history = [
    { monthsAgo: 5, slug: 'rajasthan-royal-trail', date: '2026-11-08', title: 'Rajasthan Royal Trail — Mehta family', customerId: mehta.id, adults: 4 },
    { monthsAgo: 4, slug: 'kerala-backwaters-hills', date: '2026-12-12', title: 'Kerala Backwaters — Iyer anniversary', adults: 2 },
    { monthsAgo: 3, slug: 'dubai-family-fun', date: '2027-01-15', title: 'Dubai Family Fun — Sharma family', adults: 2, children: 2 },
    { monthsAgo: 2, slug: 'goa-beach-escape', date: '2026-12-27', title: 'Goa New Year — college group', adults: 2 },
    { monthsAgo: 1, slug: 'kerala-backwaters-hills', date: '2027-02-06', title: 'Kerala Backwaters — Kapoor parents', customerId: kapoor.id, adults: 2 },
    { monthsAgo: 0, slug: 'goa-beach-escape', date: '2027-01-09', title: 'Goa Beach Escape — Nair family', adults: 2 },
  ];
  for (const h of history) {
    const pkg = one('SELECT id FROM packages WHERE slug = ?', h.slug);
    if (!pkg) continue;
    const quoteId = svc.createQuoteFromPackage(agency, pkg.id, { title: h.title, customerId: h.customerId || null, date: h.date, adults: h.adults, children: h.children || 0 });
    // Top up exactly what the booking will cost so the demo wallet keeps its opening balance.
    const net = svc.getQuote(quoteId, agency.id).priced.net;
    const utr = `UTR${String(7700000000 + quoteId * 7919).slice(0, 10)}`;
    svc.moveWallet(agency.id, 'topup', round2(net * (1 + taxRate(getSettings()) / 100)), utr, 'Bank transfer');
    const bookingId = svc.bookQuote(agency.id, quoteId);
    const when = `datetime('now', '-${h.monthsAgo} months', '-${3 + h.monthsAgo * 2} days')`;
    const b = one('SELECT code FROM bookings WHERE id = ?', bookingId);
    run(`UPDATE bookings SET created_at = ${when} WHERE id = ?`, bookingId);
    run(`UPDATE quotes SET created_at = ${when}, updated_at = ${when} WHERE id = ?`, quoteId);
    run(`UPDATE invoices SET created_at = ${when} WHERE booking_id = ?`, bookingId);
    run(`UPDATE wallet_txns SET created_at = ${when} WHERE ref IN (?, ?)`, b.code, utr);
  }
  run("DELETE FROM notifications WHERE title IN ('New booking', 'Booking confirmed')");
}

module.exports = { seed };

if (require.main === module) {
  console.log(seed() ? 'Seeded demo data.' : 'Database already has data; run "npm run seed" to reset.');
}
