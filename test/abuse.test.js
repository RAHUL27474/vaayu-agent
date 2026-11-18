// Hostile and nonsense input: bad amounts, other agencies' records, script tags, SQL-looking text, guessing passwords.
const { start, finish, check, db, ROLES } = require('./helpers');

const one = (sql, ...p) => db.prepare(sql).get(...p);
const count = async (sql, ...p) => (await one(sql, ...p)).n;

(async () => {
  const c = await start();
  const agent = await c.login(...ROLES.agent);
  const other = await c.login(...ROLES.agent2);
  const admin = await c.login(...ROLES.admin);
  const sky = await one("SELECT * FROM agencies WHERE slug = 'skyline-holidays'");

  // ---------- amounts ----------
  for (const amount of ['-500', '0', 'abc', '1e12', '']) {
    const before = await count('SELECT COUNT(*) AS n FROM topup_requests');
    await c.post('/agent/wallet/topup', agent, { amount, utr: `UTR${amount}X` });
    check(`top-up of "${amount}" is refused`, (await count('SELECT COUNT(*) AS n FROM topup_requests')) === before);
  }
  const w0 = (await one('SELECT wallet_balance, credit_limit FROM agencies WHERE id = ?', sky.id));
  await c.post(`/admin/agents/${sky.id}/wallet`, admin, { amount: 'abc', ref: 'x' });
  await c.post(`/admin/agents/${sky.id}/credit`, admin, { credit_limit: '-5000' });
  const w1 = (await one('SELECT wallet_balance, credit_limit FROM agencies WHERE id = ?', sky.id));
  check('wallet adjustment of "abc" changes nothing', w1.wallet_balance === w0.wallet_balance);
  check('negative credit limit is refused', w1.credit_limit >= 0, w1.credit_limit);

  const q = (await c.post('/agent/quotes', agent, { title: 'Abuse quote' })).headers.get('location');
  const qid = Number(q.match(/(\d+)$/)[1]);
  await c.post(`/agent/quotes/${qid}/items/custom`, agent, { title: 'Weird', type: 'other', price: '-100', cost: '-50', qty: '-3' });
  const it = await one('SELECT * FROM quote_items WHERE quote_id = ?', qid);
  check('custom item with negative price/qty is refused or clamped', !it || (it.sell_price >= 0 && it.cost >= 0 && it.qty >= 1), it && JSON.stringify({ sell: it.sell_price, cost: it.cost, qty: it.qty }));
  await c.post(`/agent/quotes/${qid}`, agent, { title: 'Abuse quote', adults: '-4', children: '-1', markup_type: 'percent', markup_value: '-50' });
  const qq = await one('SELECT adults, children, markup_value FROM quotes WHERE id = ?', qid);
  check('quote party and markup are clamped', qq.adults >= 1 && qq.children >= 0 && qq.markup_value >= 0, JSON.stringify(qq));

  // ---------- other agencies' records ----------
  const ravi = await one("SELECT * FROM agencies WHERE slug = 'ravi-tours-travels'") || await one("SELECT * FROM agencies WHERE id <> ? AND status = 'active' LIMIT 1", sky.id);
  const theirs = {
    quote: await one('SELECT id FROM quotes WHERE agency_id = ? LIMIT 1', ravi.id),
    customer: await one('SELECT id FROM customers WHERE agency_id = ? LIMIT 1', ravi.id),
    booking: await one('SELECT id FROM bookings WHERE agency_id = ? LIMIT 1', ravi.id),
    invoice: await one('SELECT id FROM invoices WHERE agency_id = ? LIMIT 1', ravi.id),
    package: await one('SELECT id FROM packages WHERE agency_id = ? LIMIT 1', ravi.id),
  };
  for (const [kind, row] of Object.entries(theirs)) {
    if (!row) continue;
    const r = await c.get(`/agent/${kind === 'package' ? 'packages' : `${kind}s`}/${row.id}`, agent);
    check(`agent cannot open another agency's ${kind}`, r.status === 404 || r.status === 302, r.status);
  }
  if (theirs.quote) {
    const before = await one('SELECT status FROM quotes WHERE id = ?', theirs.quote.id);
    await c.post(`/agent/quotes/${theirs.quote.id}/book`, agent, {});
    await c.post(`/agent/quotes/${theirs.quote.id}/delete`, agent, {});
    const after = await one('SELECT status FROM quotes WHERE id = ?', theirs.quote.id);
    check("agent cannot book or delete another agency's quote", after && after.status === before.status);
  }
  check('agent cannot open KYC documents', (await c.get(`/admin/agents/${ravi.id}/kyc/photo`, agent)).status !== 200);
  check('agent2 cannot see skyline customers in search', !(await (await c.get('/agent/customers?q=a', other)).text()).includes('Ananya'));

  // ---------- script tags and SQL-looking text ----------
  await c.post('/agent/customers', agent, { name: '<script>alert(1)</script>', email: 'x@x.in' });
  const page = await (await c.get('/agent/customers', agent)).text();
  check('script tags in names are shown as text', !page.includes('<script>alert(1)</script>') && page.includes('&lt;script&gt;'));
  for (const qs of ["'; DROP TABLE agencies; --", '%', '\\', '_', "' OR 1=1 --"]) {
    const r = await c.get(`/agent/activities?q=${encodeURIComponent(qs)}`, agent);
    check(`search for ${JSON.stringify(qs)} is safe`, r.status === 200);
  }
  check('agencies table still there', (await count('SELECT COUNT(*) AS n FROM agencies')) > 0);
  check('nonsense ids are 404, not errors', (await c.get('/agent/quotes/abc', agent)).status === 404 && (await c.get('/agent/packages/99999999999', agent)).status === 404);

  // ---------- sign-up and login ----------
  const fd = new FormData();
  for (const [k, v] of Object.entries({ agency: 'Dup', name: 'Dup', email: 'agent@skyline.com', country: 'India', gstin: '27AABCT1234M1Z5', password: 'secret123' })) fd.append(k, v);
  const dup = await c.post('/signup', '', fd);
  check('sign-up with an existing email is refused', dup.status === 200 && (await dup.text()).includes('already exists'));
  let blocked = false;
  for (let i = 0; i < 12; i++) {
    const r = await fetch(`${c.B}/login`, { method: 'POST', body: new URLSearchParams({ email: 'admin@vaayutrip.com', password: `wrong${i}` }), redirect: 'manual' });
    const t = await r.text();
    if (/too many/i.test(t)) { blocked = true; break; }
  }
  check('repeated wrong passwords get blocked for a while', blocked);
  const okAfter = await c.login('agent@skyline.com', 'agent123');
  check('other accounts can still log in', Boolean(okAfter) && (await c.get('/agent', okAfter)).status === 200);

  finish(c);
})().catch((e) => { console.error(e); process.exit(1); });
