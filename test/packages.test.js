// VaayuTrip packages (ready-made, sold or copied by agents), fixed departures with seats, agency rate tiers,
// travellers' documents, invoice numbers and parties, and the TCS reports.
const { start, finish, check, db, ROLES } = require('./helpers');

const one = (sql, ...p) => db.prepare(sql).get(...p);

(async () => {
  const c = await start();
  const agent = await c.login(...ROLES.agent);
  const other = await c.login(...ROLES.agent2);
  const admin = await c.login(...ROLES.admin);
  const backend = await c.login(...ROLES.backend);
  const page = async (p, cookie) => (await c.get(p, cookie)).text();
  const agencyId = (await one('SELECT agency_id FROM users WHERE email = ?', ROLES.agent[0])).agency_id;
  const quoteIdOf = (r) => Number(((r.headers.get('location') || '').match(/quotes\/(\d+)/) || [])[1]);

  // ---------- VaayuTrip packages ----------
  const vp = await one("SELECT * FROM packages WHERE agency_id IS NULL AND status = 'published' ORDER BY id LIMIT 1");
  check('backend lists VaayuTrip packages', vp && (await page('/backend/packages', backend)).includes(vp.title));
  check('backend can open the builder for one', (await c.get(`/backend/packages/${vp.id}/edit`, backend)).status === 200);
  check('agents can not open the backend packages', (await c.get('/backend/packages', agent)).status === 302);
  const list = await page('/agent/vaayutrip-packages', agent);
  check('agents see VaayuTrip packages with net and selling price', list.includes(vp.title) && list.includes('Net pp'));
  const detail = await page(`/agent/vaayutrip-packages/${vp.id}?adults=2&rooms=1`, agent);
  check('package page prices the trip for the group', detail.includes('Your earning') && detail.includes('Quote it to your customer'));
  const q1 = quoteIdOf(await c.post(`/agent/vaayutrip-packages/${vp.id}/quote`, agent, { adults: '2', children: '0', infants: '0', rooms: '1', date: '' }));
  const quote1 = q1 && await one('SELECT * FROM quotes WHERE id = ?', q1);
  check('a quote is made from a VaayuTrip package, with its itinerary', quote1 && quote1.agency_id === agencyId && quote1.package_id === vp.id && quote1.package_snapshot);
  const copyLoc = (await c.post(`/agent/vaayutrip-packages/${vp.id}/copy`, agent, {})).headers.get('location') || '';
  const copy = await one('SELECT * FROM packages WHERE agency_id = ? AND copied_from = ? ORDER BY id DESC LIMIT 1', agencyId, vp.id);
  check('copy to My packages makes an editable draft', copy && copy.status === 'draft' && copyLoc.endsWith(`/agent/packages/${copy.id}/edit`));
  await c.post(`/agent/vaayutrip-packages/${vp.id}/copy`, agent, { publish: '1' });
  check('add to my website copies and publishes', Boolean(await one("SELECT 1 FROM packages WHERE agency_id = ? AND copied_from = ? AND status = 'published'", agencyId, vp.id)));
  await c.post(`/backend/packages/${vp.id}/status`, backend, { status: 'draft' });
  check('unpublished VaayuTrip packages are hidden from agents', (await c.get(`/agent/vaayutrip-packages/${vp.id}`, agent)).status === 404);
  await c.post(`/backend/packages/${vp.id}/status`, backend, { status: 'published' });
  check('publishing tells agents', Boolean(await one("SELECT 1 FROM notifications WHERE agency_id = ? AND title = 'New VaayuTrip package'", agencyId)));

  // ---------- fixed departures ----------
  const dep = new Date(Date.now() + 60 * 864e5).toISOString().slice(0, 10);
  await c.post(`/backend/packages/${vp.id}/departures`, backend, { dates: dep, seats: '3', note: 'Group' });
  check('backend adds a departure with seats', (await page(`/backend/packages/${vp.id}/departures`, backend)).includes('Group'));
  check('agents see seats left', (await page(`/agent/vaayutrip-packages/${vp.id}`, agent)).includes('3 of 3 seats left'));
  const tooMany = await c.post(`/agent/vaayutrip-packages/${vp.id}/quote`, agent, { adults: '4', rooms: '2', date: dep });
  check('more travellers than seats is refused', !quoteIdOf(tooMany));
  const otherDate = await c.post(`/agent/vaayutrip-packages/${vp.id}/quote`, agent, { adults: '2', rooms: '1', date: new Date(Date.now() + 61 * 864e5).toISOString().slice(0, 10) });
  check('a date without a departure is refused', !quoteIdOf(otherDate));
  const q2 = quoteIdOf(await c.post(`/agent/vaayutrip-packages/${vp.id}/quote`, agent, { adults: '2', rooms: '1', date: dep }));
  check('a quote within the seats is made', Boolean(q2));
  await c.post(`/agent/quotes/${q2}/book`, agent, {});
  check('booking takes the seats', (await page(`/agent/vaayutrip-packages/${vp.id}`, agent)).includes('1 of 3 seats left'));
  const q3 = quoteIdOf(await c.post(`/agent/vaayutrip-packages/${vp.id}/quote`, other, { adults: '1', rooms: '1', date: dep }));
  const q4 = quoteIdOf(await c.post(`/agent/vaayutrip-packages/${vp.id}/quote`, agent, { adults: '1', rooms: '1', date: dep }));
  await c.post(`/agent/quotes/${q3}/book`, other, {});
  await c.post(`/agent/quotes/${q4}/book`, agent, {});
  check('the last seat goes to one booking only', (await one("SELECT COUNT(*) AS n FROM bookings b JOIN quotes q ON q.id = b.quote_id WHERE q.package_id = ? AND b.travel_date = ? AND b.status != 'cancelled'", vp.id, dep)).n === 2);

  // ---------- rate tiers ----------
  const act = await one("SELECT * FROM products WHERE kind = 'activity' AND status = 'published' AND cost_adult > 1000 ORDER BY id LIMIT 1");
  const netShown = async () => {
    const html = await page(`/agent/activities/${act.id}?adults=1`, agent);
    return Number((html.match(/Net to VaayuTrip<\/td><td class="num"><b>₹([\d,]+)/) || [])[1]?.replace(/,/g, ''));
  };
  const standard = await netShown();
  await c.post(`/admin/agents/${agencyId}/tier`, admin, { rate_tier: 'gold' });
  const gold = await netShown();
  check('Gold agencies get a lower net rate', standard > 0 && gold > 0 && gold < standard, `${standard} → ${gold}`);
  check('the agency is told about its tier', Boolean(await one("SELECT 1 FROM notifications WHERE agency_id = ? AND title LIKE '%Gold partner%'", agencyId)));
  const otherNet = Number(((await page(`/agent/activities/${act.id}?adults=1`, other)).match(/Net to VaayuTrip<\/td><td class="num"><b>₹([\d,]+)/) || [])[1]?.replace(/,/g, ''));
  check("other agencies keep the standard rate", otherNet === standard);
  await c.post(`/admin/agents/${agencyId}/tier`, admin, { rate_tier: 'standard' });

  // ---------- travellers' documents ----------
  const cust = await one('SELECT * FROM customers WHERE agency_id = ? ORDER BY id LIMIT 1', agencyId);
  const fd = new FormData();
  for (const [k, v] of Object.entries({ traveller: 'Ananya Kapoor', doc_type: 'passport', doc_number: 'Z1234567', expires_on: '2027-01-10' })) fd.append(k, v);
  fd.append('file', new Blob(['%PDF-1.4\n%passport\n'], { type: 'application/pdf' }), 'passport.pdf');
  await c.post(`/agent/customers/${cust.id}/docs`, agent, fd);
  const doc = await one('SELECT * FROM traveller_docs WHERE customer_id = ?', cust.id);
  const custPage = await page(`/agent/customers/${cust.id}`, agent);
  check('a passport is uploaded and listed (number masked)', doc && custPage.includes('Ananya Kapoor') && custPage.includes('••4567') && !custPage.includes('Z1234567'));
  const file = await c.get(`/agent/customers/${cust.id}/docs/${doc.id}`, agent);
  check('the agency can open it', file.status === 200 && (await file.text()).includes('%passport'));
  check('another agency can not', (await c.get(`/agent/customers/${cust.id}/docs/${doc.id}`, other)).status === 404);
  const exe = new FormData();
  exe.append('traveller', 'X');
  exe.append('file', new Blob(['MZ'], { type: 'application/x-msdownload' }), 'bad.exe');
  await c.post(`/agent/customers/${cust.id}/docs`, agent, exe);
  check('only PDFs and photos are accepted', (await one('SELECT COUNT(*) AS n FROM traveller_docs WHERE customer_id = ?', cust.id)).n === 1);
  await c.post(`/agent/customers/${cust.id}/docs/${doc.id}/delete`, agent, {});
  check('a document can be deleted', !(await one('SELECT 1 FROM traveller_docs WHERE id = ?', doc.id)));

  // ---------- invoices: number, customer state/PAN, agency bank ----------
  await c.post(`/agent/customers/${cust.id}`, agent, { name: cust.name, phone: cust.phone || '', email: cust.email || '', city: 'Mumbai', address: '12 Marine Drive', state: 'Maharashtra', pan: 'abcde1234f' });
  check('customer address, state and PAN are saved', (await one('SELECT state, pan FROM customers WHERE id = ?', cust.id)).pan === 'ABCDE1234F');
  await db.prepare('UPDATE agencies SET bank_details = ? WHERE id = ?').run('HDFC Bank · A/c 123456 · IFSC HDFC0000001', agencyId);
  await db.prepare("UPDATE quotes SET customer_id = ?, invoice_mode = 'agent' WHERE id = ?").run(cust.id, q1);
  const invLoc = (await c.post(`/agent/quotes/${q1}/invoice`, agent, {})).headers.get('location') || '';
  const inv = await one('SELECT * FROM invoices WHERE id = ?', Number((invLoc.match(/invoices\/(\d+)/) || [])[1]));
  check('invoice numbers are at most 16 characters', inv && inv.number.length <= 16 && /^[A-Z]{1,3}\/\d{2}-\d{2}\/\d{5}$/.test(inv.number), inv && inv.number);
  const invPage = await page(invLoc, agent);
  check('invoice shows the customer state, PAN and address', invPage.includes('State: Maharashtra (27)') && invPage.includes('ABCDE1234F') && invPage.includes('12 Marine Drive'));
  check("the agency's bank details are on its invoice", invPage.includes('HDFC Bank · A/c 123456'));
  const otherAgencyQ = await one("SELECT q.id FROM quotes q JOIN users u ON u.agency_id = q.agency_id WHERE u.email = ? AND EXISTS (SELECT 1 FROM quote_items i WHERE i.quote_id = q.id) ORDER BY q.id LIMIT 1", ROLES.agent2[0]);
  await db.prepare("UPDATE agencies SET name = 'Skyline Holidays Two', logo_path = '/img/favicon.png' WHERE id = (SELECT agency_id FROM users WHERE email = ?)").run(ROLES.agent2[0]);
  await db.prepare("UPDATE quotes SET invoice_mode = 'agent' WHERE id = ?").run(otherAgencyQ.id);
  const sameInitials = (await c.post(`/agent/quotes/${otherAgencyQ.id}/invoice`, other, {})).headers.get('location') || '';
  check('two agencies with the same initials can both invoice', /invoices\/\d+/.test(sameInitials));

  // ---------- TCS reports ----------
  const today = new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
  const agentCsv = await page(`/agent/reports/tcs.csv?from=2000-01-01&to=${today}`, agent);
  check("agency TCS report lists its invoices with TCS", agentCsv.includes('Customer PAN') && agentCsv.includes(inv.number) && agentCsv.includes('ABCDE1234F'));
  await db.prepare("UPDATE quotes SET invoice_mode = 'vaayu' WHERE id = ?").run(q1);
  await c.post(`/agent/quotes/${q1}/invoice`, agent, {});
  const adminCsv = await (await c.get(`/admin/reports/tcs.csv?from=2000-01-01&to=${today}`, admin)).text();
  check('VaayuTrip TCS report lists its customer invoices with totals', adminCsv.includes('Invoice no.') && /VT\/\d{2}-\d{2}\/\d{6}/.test(adminCsv) && adminCsv.includes('Total'));
  check('agents can not download VaayuTrip\'s TCS report', (await c.get('/admin/reports/tcs.csv', agent)).status === 302);

  finish(c);
})().catch((e) => { console.error(e); process.exit(1); });
