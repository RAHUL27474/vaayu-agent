// Agency staff roles, lead follow-ups, quote views, wallet and credit alerts, the admin business dashboard,
// seasonal prices and sold-out dates, and email (against a stand-in Resend).
const http = require('http');

const mails = [];
const resend = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const m = JSON.parse(body);
    // An unverified recipient domain stands in for Resend refusing the sender.
    if (m.to.some((t) => t.endsWith('@unverified.test'))) { res.writeHead(403, { 'Content-Type': 'application/json' }); return res.end('{"message":"domain not verified"}'); }
    if (req.headers.authorization === 'Bearer re_test') mails.push(m);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"id":"x"}');
  });
});

(async () => {
  await new Promise((r) => resend.listen(0, r));
  Object.assign(process.env, { RESEND_API_KEY: 're_test', MAIL_FROM: 'VaayuTrip <noreply@test.in>', RESEND_API_URL: `http://localhost:${resend.address().port}` });
  const { start, finish, check, db, ROLES } = require('./helpers');
  const one = (sql, ...p) => db.prepare(sql).get(...p);
  const c = await start();
  const owner = await c.login(...ROLES.agent);
  const admin = await c.login(...ROLES.admin);
  const agencyId = (await one('SELECT agency_id FROM users WHERE email = ?', ROLES.agent[0])).agency_id;
  const page = async (p, cookie) => (await c.get(p, cookie)).text();
  const loginOk = async (email, password) => (await c.post('/login', '', { email, password })).status === 302;

  // ---------- staff roles ----------
  check('owner sees Team', (await page('/agent/team', owner)).includes('Add a staff member'));
  await c.post('/agent/team', owner, { name: 'Sunil Sales', email: 'sunil@skyline.com', role: 'sales', password: 'sales1234' });
  await c.post('/agent/team', owner, { name: 'Anita Accounts', email: 'anita@skyline.com', role: 'accounts', password: 'accts1234' });
  const sales = await c.login('sunil@skyline.com', 'sales1234');
  const accounts = await c.login('anita@skyline.com', 'accts1234');
  check('staff can log in with their own logins', Boolean(sales) && Boolean(accounts) && (await c.get('/agent', sales)).status === 200);
  check('sales can open quotes and inventory', (await c.get('/agent/quotes', sales)).status === 200 && (await c.get('/agent/hotels', sales)).status === 200);
  check('sales cannot open wallet, settings or team', (await c.get('/agent/wallet', sales)).status === 302 && (await c.get('/agent/settings', sales)).status === 302 && (await c.get('/agent/team', sales)).status === 302);
  check('sales cannot top up', (await c.post('/agent/wallet/topup', sales, { amount: '500', utr: 'X1' })).headers.get('location') === '/agent' && !(await one("SELECT 1 FROM topup_requests WHERE utr = 'X1'")));
  check('accounts can open wallet and invoices, not inventory or leads', (await c.get('/agent/wallet', accounts)).status === 200 && (await c.get('/agent/invoices', accounts)).status === 200
    && (await c.get('/agent/hotels', accounts)).status === 302 && (await c.get('/agent/leads', accounts)).status === 302);
  const salesNav = await page('/agent', sales);
  check('menu hides what the role cannot open', !salesNav.includes('href="/agent/wallet" class') && !salesNav.includes('href="/agent/team"') && salesNav.includes('Agent · Sales'));
  const ownerCount = () => one("SELECT COUNT(*) AS n FROM users WHERE agency_id = ? AND agency_role = 'owner'", agencyId).then((r) => r.n);
  const ownerId = (await one('SELECT id FROM users WHERE email = ?', ROLES.agent[0])).id;
  const sunil = await one("SELECT id FROM users WHERE email = 'sunil@skyline.com'");
  await c.post(`/agent/team/${sunil.id}/toggle`, owner, {});
  check('owner can switch a staff login off', !(await loginOk('sunil@skyline.com', 'sales1234')));
  await c.post(`/agent/team/${sunil.id}/toggle`, owner, {});
  await c.post(`/agent/team/${ownerId}/role`, owner, { role: 'sales' });
  check('the last owner cannot be demoted', await ownerCount() === 1);
  const other = await c.login(...ROLES.agent2);
  check("another agency can't manage this agency's staff", (await c.post(`/agent/team/${sunil.id}/toggle`, other, {})).status === 404);

  // ---------- lead follow-ups ----------
  const today = new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() + 330 * 60000 - 864e5).toISOString().slice(0, 10);
  await c.post('/agent/leads', sales, { name: 'Follow Me', phone: '+91 90000 11111', destination: 'Bali', follow_up_on: today });
  const lead = await one("SELECT * FROM leads WHERE name = 'Follow Me'");
  check('a lead can be added with a follow-up date', lead.follow_up_on === today && lead.assigned_to === sunil.id);
  await c.post(`/agent/leads/${lead.id}/follow-up`, owner, { follow_up_on: yesterday, follow_up_note: 'Send Bali quote', assigned_to: String(sunil.id) });
  const dash = await page('/agent', owner);
  check('dashboard lists follow-ups due, overdue first', dash.includes('Follow-ups due') && dash.includes('Follow Me') && dash.includes('overdue'));
  check('leads page has a due tab', (await page('/agent/leads?due=1', owner)).includes('Send Bali quote'));

  // ---------- customers have no links; agents send PDFs ----------
  const q = await one("SELECT * FROM quotes WHERE agency_id = ? AND status IN ('sent', 'draft') ORDER BY id LIMIT 1", agencyId);
  check('customer links are gone', (await c.get(`/q/${q.code}`)).status === 404 && (await c.get(`/q/${q.code}/voucher`)).status === 404);
  const pdfPage = await page(`/agent/quotes/${q.id}/pdf`, owner);
  check('agent opens the quote as a PDF page with its branding', pdfPage.includes('QUOTATION') && pdfPage.includes('Download PDF') && pdfPage.includes('Skyline'));
  const otherPdf = await c.get(`/agent/quotes/${q.id}/pdf`, await c.login(...ROLES.agent2));
  check("another agency can't open it", otherPdf.status !== 200 && !(await otherPdf.text()).includes('QUOTATION'));
  await c.post(`/agent/quotes/${q.id}/accepted`, owner, {});
  check('agent marks the quote accepted', (await one('SELECT status FROM quotes WHERE id = ?', q.id)).status === 'accepted');

  // ---------- wallet alert, credit due and repayment ----------
  await db.prepare('UPDATE agencies SET wallet_balance = 12000, low_balance_alert = 10000, credit_used = 0, credit_since = NULL WHERE id = ?').run(agencyId);
  await c.post(`/admin/agents/${agencyId}/wallet`, admin, { amount: '-3000', note: 'test debit' });
  check('crossing the low-balance level notifies the agency', Boolean(await one("SELECT 1 FROM notifications WHERE agency_id = ? AND title = 'Low wallet balance'", agencyId)));
  check('dashboard warns about the low wallet', (await page('/agent', owner)).includes('Low wallet balance'));
  await db.prepare("UPDATE agencies SET credit_used = 5000, credit_days = 15, credit_since = to_char(CURRENT_DATE - 20, 'YYYY-MM-DD') WHERE id = ?").run(agencyId);
  const wallet = await page('/agent/wallet', owner);
  check('wallet shows overdue credit with a repay button', wallet.includes('Credit overdue') && wallet.includes('Repay from wallet'));
  const { creditReminders } = require('../src/services');
  await db.prepare("UPDATE agencies SET credit_since = to_char(CURRENT_DATE - 16, 'YYYY-MM-DD'), credit_reminded_on = NULL WHERE id = ?").run(agencyId);
  await creditReminders();
  await creditReminders();
  check('overdue reminder sent once a day', (await one("SELECT COUNT(*) AS n FROM notifications WHERE agency_id = ? AND title = 'Credit overdue'", agencyId)).n === 1);
  const bookable = await one("SELECT q.id FROM quotes q WHERE q.agency_id = ? AND q.status IN ('draft', 'sent', 'accepted') AND EXISTS (SELECT 1 FROM quote_items i WHERE i.quote_id = q.id AND i.supplier = 'vaayu') ORDER BY q.id LIMIT 1", agencyId);
  await db.prepare('UPDATE agencies SET wallet_balance = 1 WHERE id = ?').run(agencyId);
  const blocked = await c.follow(await c.post(`/agent/quotes/${bookable.id}/book`, owner, {}), owner);
  check('overdue credit cannot be drawn for new bookings', blocked.includes('overdue') && !(await one("SELECT 1 FROM bookings WHERE quote_id = ? AND status = 'confirmed'", bookable.id)));
  await db.prepare('UPDATE agencies SET wallet_balance = 8000 WHERE id = ?').run(agencyId);
  await c.post('/agent/wallet/repay', owner, { amount: '5000' });
  const after = await one('SELECT wallet_balance, credit_used, credit_since FROM agencies WHERE id = ?', agencyId);
  check('repaying from the wallet clears the credit', after.wallet_balance === 3000 && after.credit_used === 0 && after.credit_since === null);
  check('accounts staff can repay; sales cannot', (await c.post('/agent/wallet/repay', sales, { amount: '1' })).headers.get('location') === '/agent');

  // ---------- admin business dashboard ----------
  const adminDash = await page('/admin', admin);
  check('admin dashboard shows revenue, margin and top lists', ['Business, last 12 months', 'Revenue by month', 'Estimated VaayuTrip margin', 'Top destinations', 'Sales by service'].every((t) => adminDash.includes(t)) && /class="hbars"/.test(adminDash));

  // ---------- seasons and sold-out dates ----------
  const backend = await c.login(...ROLES.backend);
  const act = await one("SELECT * FROM products WHERE kind = 'activity' AND status = 'published' AND price_basis = 'per_person' ORDER BY id LIMIT 1");
  const form = Object.fromEntries(['title', 'city', 'country', 'category', 'duration', 'summary', 'price_basis'].map((k) => [k, act[k] ?? '']));
  Object.assign(form, { net_adult: String(act.cost_adult), net_child: act.cost_child == null ? '' : String(act.cost_child), net_infant: '', s_from_0: '2027-12-20', s_to_0: '2028-01-05', s_pct_0: '25', s_label_0: 'New Year', b_from_0: '2027-12-31', b_to_0: '2027-12-31', b_label_0: 'Fully booked' });
  await c.post(`/backend/products/${act.id}`, backend, form);
  const saved = await one('SELECT seasons, blackouts, net_adult FROM products WHERE id = ?', act.id);
  check('backend saves seasons and sold-out dates', JSON.parse(saved.seasons)[0].pct === 25 && JSON.parse(saved.blackouts)[0].from === '2027-12-31');
  const peak = await page(`/agent/activities/${act.id}?adults=2&date=2027-12-24`, owner);
  check('product page shows the season price for the date', peak.includes('New Year') && peak.includes(`₹${(2 * Math.round(saved.net_adult * 1.25)).toLocaleString('en-IN')}`));
  check('product page warns on a sold-out date', (await page(`/agent/activities/${act.id}?adults=2&date=2027-12-31`, owner)).includes('Sold out on'));
  const addPeak = await c.post(`/agent/activities/${act.id}/quote`, owner, { quote_id: 'new', new_title: 'Peak test', adults: '2', children: '0', date: '2027-12-24', use_default: '1' });
  const peakQ = Number((addPeak.headers.get('location') || '').match(/quotes\/(\d+)/)?.[1]);
  const peakItem = peakQ && await one('SELECT net_price FROM quote_items WHERE quote_id = ?', peakQ);
  check('adding on a peak date prices at the season rate', peakItem && peakItem.net_price === Math.round(saved.net_adult * 1.25));
  const addClosed = await c.post(`/agent/activities/${act.id}/quote`, owner, { quote_id: 'new', new_title: 'Closed test', adults: '2', children: '0', date: '2027-12-31', use_default: '1' });
  check('a sold-out date cannot be added to a quote', !(await one("SELECT 1 FROM quote_items qi JOIN quotes q ON q.id = qi.quote_id WHERE q.title = 'Closed test'")), addClosed.status);

  // ---------- email ----------
  const ownerMails = mails.filter((m) => m.to.includes(ROLES.agent[0]));
  check('notifications are emailed to the agency owner', ownerMails.some((m) => m.subject === 'Low wallet balance') && ownerMails[0].html.includes('Open in VaayuTrip'));
  check('staff (non-owners) are not emailed agency notifications', !mails.some((m) => m.to.includes('sunil@skyline.com')));
  mails.length = 0;
  await c.post('/forgot-password', '', { email: 'anita@skyline.com' });
  const resetMail = mails.find((m) => m.to.includes('anita@skyline.com'));
  const link = resetMail && resetMail.text.match(/\/reset-password\/([a-f0-9]{64})/);
  check('forgot password emails a one-time link', Boolean(link));
  if (link) {
    check('reset page opens for a valid link', (await page(`/reset-password/${link[1]}`)).includes('Set new password'));
    await c.post(`/reset-password/${link[1]}`, '', { password: 'brandnew99', confirm: 'brandnew99' });
    check('reset link sets the new password', await loginOk('anita@skyline.com', 'brandnew99') && !(await loginOk('anita@skyline.com', 'accts1234')));
    check('reset link works only once', (await page(`/reset-password/${link[1]}`)).includes('expired or was already used'));
  }
  await c.post('/agent/team', owner, { name: 'Ravi Bounce', email: 'ravi@unverified.test', role: 'sales', password: 'bounce1234' });
  const bounced = await (await c.post('/forgot-password', '', { email: 'ravi@unverified.test' })).text();
  check('if the reset email cannot be sent, the request goes to support instead', bounced.includes('our support team has your request')
    && Boolean(await one("SELECT 1 FROM notifications WHERE agency_id IS NULL AND title = 'Password reset request' AND body LIKE '%ravi@unverified.test%'")));
  check('a made-up reset link is refused', (await page(`/reset-password/${'a'.repeat(64)}`)).includes('expired or was already used'));

  // ---------- login with an email code (OTP) ----------
  const codeIn = (m) => (m && m.subject.match(/^(\d{6}) is your VaayuTrip/) || [])[1];
  check('login page offers password or email code', (await page('/login?mode=otp')).includes('Email me a login code'));
  mails.length = 0;
  const otpPage = await (await c.post('/login/otp', '', { email: ROLES.agent2[0] })).text();
  const loginCode = codeIn(mails.find((m) => m.to.includes(ROLES.agent2[0])));
  check('a login code is emailed', otpPage.includes('Enter your login code') && /^\d{6}$/.test(loginCode || ''));
  const wrongCode = loginCode === '000000' ? '111111' : '000000';
  check('a wrong code is refused', (await (await c.post('/login/otp/verify', '', { email: ROLES.agent2[0], code: wrongCode })).text()).includes('That code isn'));
  const otpLogin = await c.post('/login/otp/verify', '', { email: ROLES.agent2[0], code: loginCode });
  const otpCookie = (otpLogin.headers.getSetCookie() || []).map((x) => x.split(';')[0]).join('; ');
  check('the right code logs in', otpLogin.status === 302 && otpLogin.headers.get('location') === '/agent' && (await c.get('/agent', otpCookie)).status === 200);
  check('a code works only once', (await (await c.post('/login/otp/verify', '', { email: ROLES.agent2[0], code: loginCode })).text()).includes('expired'));
  mails.length = 0;
  const ghost = await (await c.post('/login/otp', '', { email: 'nobody@nowhere.test' })).text();
  check('unknown emails get the same page and no email', ghost.includes('Enter your login code') && mails.length === 0);

  // ---------- email verified at signup ----------
  const PDF = ['%PDF-1.4\n%test\n', 'application/pdf', 'doc.pdf'];
  const PNG = [Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108020000009077053e0000000c4944415408d763f8ffff3f0005fe02fea7d6a5d50000000049454e44ae426082', 'hex'), 'image/png', 'me.png'];
  const fd = new FormData();
  for (const [k, v] of Object.entries({ agency: 'Verify Travels', name: 'Vera Fy', email: 'vera@verify.in', phone: '+91 90000 22222', city: 'Pune', country: 'India', gstin: '27AABCV1234M1Z5', password: 'secret123' })) fd.append(k, v);
  for (const [f, [data, type, name]] of Object.entries({ tax_doc: PDF, pan_doc: PDF, photo: PNG })) fd.append(f, new Blob([data], { type }), name);
  mails.length = 0;
  const signup = await c.post('/signup', '', fd);
  const vCookie = (signup.headers.getSetCookie() || []).map((x) => x.split(';')[0]).join('; ');
  const vera = await one("SELECT * FROM users WHERE email = 'vera@verify.in'");
  check('signup asks for the emailed code first', signup.headers.get('location') === '/verify-email' && vera && vera.email_verified === 0);
  check('the portal stays closed until the email is verified', (await c.get('/agent', vCookie)).headers.get('location') === '/verify-email');
  const vCode = codeIn(mails.find((m) => m.to.includes('vera@verify.in')));
  check('wrong verification code is refused', (await (await c.post('/verify-email', vCookie, { code: vCode === '000000' ? '111111' : '000000' })).text()).includes('That code isn'));
  await c.post('/verify-email', vCookie, { code: vCode });
  check('the right code verifies the email and opens the portal', (await one("SELECT email_verified FROM users WHERE email = 'vera@verify.in'")).email_verified === 1 && (await c.get('/agent', vCookie)).status === 200);

  // ---------- 2-step login (password, then an emailed code) ----------
  const run = (sql, ...p) => db.prepare(sql).run(...p);
  const { cookieOf } = require('./helpers');
  const adminId = (await one('SELECT id FROM users WHERE email = ?', ROLES.admin[0])).id;
  const unthrottle = () => run("UPDATE one_time_codes SET created_at = datetime('now', '-2 minutes') WHERE user_id = ?", adminId);
  const mailTo = (to) => [...mails].reverse().find((m) => m.to.includes(to));
  check('account page offers 2-step login', (await page('/account', admin)).includes('2-step login'));
  await c.post('/account/2step/on', admin, { current: 'wrong-password' });
  check('turning 2-step on needs the password', (await one('SELECT two_step FROM users WHERE id = ?', adminId)).two_step === 0);
  mails.length = 0;
  const onPage = await (await c.post('/account/2step/on', admin, { current: ROLES.admin[1] })).text();
  check('turning 2-step on asks for an emailed code', onPage.includes('Confirm with the emailed code'));
  await c.post('/account/2step/confirm', admin, { code: codeIn(mailTo(ROLES.admin[0])) });
  check('the right code turns 2-step login on', (await one('SELECT two_step FROM users WHERE id = ?', adminId)).two_step === 1);
  unthrottle();
  mails.length = 0;
  const step1 = await c.post('/login', '', { email: ROLES.admin[0], password: ROLES.admin[1] });
  const halfCookie = cookieOf(step1);
  check('with 2-step on, the password alone does not log in', step1.status === 200 && (await step1.text()).includes('Enter the code from your email') && (await c.get('/admin', halfCookie)).status === 302);
  const step2Code = codeIn(mailTo(ROLES.admin[0]));
  check('a wrong second-step code is refused', (await (await c.post('/login/2step', halfCookie, { code: step2Code === '000000' ? '111111' : '000000' })).text()).includes('That code isn'));
  const step2 = await c.post('/login/2step', halfCookie, { code: step2Code });
  const fullCookie = cookieOf(step2) || halfCookie;
  check('password + the emailed code logs in', step2.status === 302 && step2.headers.get('location') === '/admin' && (await c.get('/admin', fullCookie)).status === 200);
  check('a second-step code without the password step does nothing', (await c.post('/login/2step', '', { code: step2Code })).headers.get('location') === '/login');
  unthrottle();
  mails.length = 0;
  await c.post('/login/otp', '', { email: ROLES.admin[0] });
  const onlyCode = await (await c.post('/login/otp/verify', '', { email: ROLES.admin[0], code: codeIn(mailTo(ROLES.admin[0])) })).text();
  check('with 2-step on, an email code alone does not log in', onlyCode.includes('2-step login is on'));
  const acct = await page('/account', fullCookie);
  check('account page lists recent logins with where from', acct.includes('Recent logins') && /a browser|Chrome|Windows/.test(acct));
  await c.post('/account/2step/off', fullCookie, { current: ROLES.admin[1] });
  check('2-step login can be turned off with the password', (await one('SELECT two_step FROM users WHERE id = ?', adminId)).two_step === 0 && await loginOk(...ROLES.admin));

  // ---------- trip reminder 2 days before travel ----------
  const indiaDay = (plus) => new Date(Date.now() + 330 * 60000 + plus * 864e5).toISOString().slice(0, 10);
  const trip = await one("SELECT id, agency_id, title FROM bookings WHERE status = 'confirmed' ORDER BY id LIMIT 1");
  run('UPDATE bookings SET travel_date = ?, trip_reminded = 0 WHERE id = ?', indiaDay(1), trip.id);
  const tripNotes = async () => (await one("SELECT COUNT(*) AS n FROM notifications WHERE agency_id = ? AND title LIKE 'Trip tomorrow:%'", trip.agency_id)).n;
  await c.get('/healthz');
  check('the agent is reminded the day before a trip', await tripNotes() === 1 && (await one('SELECT trip_reminded FROM bookings WHERE id = ?', trip.id)).trip_reminded === 1);
  await c.get('/healthz');
  check('the trip reminder is sent once', await tripNotes() === 1);

  // ---------- admin dashboard: agents ----------
  const agentsDash = await page('/admin', admin);
  check('admin dashboard shows top agents of the last 90 days', agentsDash.includes('Top agents') && agentsDash.includes('last 90 days'));
  run("UPDATE agencies SET created_at = datetime('now', '-120 days') WHERE id = (SELECT agency_id FROM users WHERE email = ?)", ROLES.agent2[0]);
  run("UPDATE bookings SET created_at = datetime('now', '-100 days') WHERE agency_id = (SELECT agency_id FROM users WHERE email = ?)", ROLES.agent2[0]);
  check('admin dashboard lists agents gone quiet', (await page('/admin', admin)).includes('Agents gone quiet'));

  resend.close();
  finish(c);
})().catch((e) => { console.error(e); process.exit(1); });
