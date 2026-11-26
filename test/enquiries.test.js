// Website enquiries: the home-page form saves an enquiry for the VaayuTrip backend team, who see and work it in
// the backend portal. Checked: validation, the bot trap, the hourly limit, who can see enquiries, and updates.
(async () => {
  const { start, finish, check, db, ROLES } = require('./helpers');
  const one = (sql, ...p) => db.prepare(sql).get(...p);
  const c = await start();
  const count = async () => (await one('SELECT COUNT(*)::int AS n FROM enquiries')).n;

  const home = await (await c.get('/')).text();
  check('home page has the enquiry form', home.includes('action="/enquiry"') && home.includes('name="phone"'));

  let r = await c.post('/enquiry', '', { topic: 'partner', name: 'Ravi Mehta', phone: '+91 98111 22233', email: 'ravi@sunroutes.in', company: 'Sun Routes', city: 'Pune', destination: 'Dubai', pax: '4', message: 'We sell Dubai a lot' });
  check('enquiry is accepted and sends the visitor back to the form', r.status === 303 && r.headers.get('location') === '/#enquiry');
  const e = await one("SELECT * FROM enquiries WHERE phone = '+91 98111 22233'");
  check('enquiry is saved with its details, status new', e && e.name === 'Ravi Mehta' && e.company === 'Sun Routes' && e.destination === 'Dubai' && e.pax === 4 && e.status === 'new');
  check('VaayuTrip HQ gets a notification', !!(await one("SELECT id FROM notifications WHERE agency_id IS NULL AND title = 'New website enquiry' AND link = ?", `/backend/enquiries/${e.id}`)));
  const thanks = await c.follow(r, '');
  check('visitor sees a thank-you message once', (thanks.match(/Our team will call you within one working day/g) || []).length === 1);

  const n0 = await count();
  await c.post('/enquiry', '', { name: 'No Phone', phone: 'abc' });
  check('a bad phone number is refused', await count() === n0);
  await c.post('/enquiry', '', { name: '', phone: '+91 98111 00000' });
  check('a missing name is refused', await count() === n0);
  await c.post('/enquiry', '', { name: 'Bot', phone: '+91 98111 00001', website: 'http://spam.example' });
  check('the hidden bot field drops the enquiry quietly', await count() === n0);
  for (let i = 0; i < 6; i++) await c.post('/enquiry', '', { name: `Flood ${i}`, phone: `+91 98111 1000${i}` });
  check('one connection can send at most 5 an hour', (await one("SELECT COUNT(*)::int AS n FROM enquiries WHERE name LIKE 'Flood %'")).n <= 4);

  const backend = await c.login(...ROLES.backend);
  const admin = await c.login(...ROLES.admin);
  const agent = await c.login(...ROLES.agent);
  const list = await (await c.get('/backend/enquiries', backend)).text();
  check('backend team sees the enquiry in its list', list.includes('Ravi Mehta') && list.includes('Partner agency'));
  check('menu shows a count of new enquiries', /Enquiries<\/span><b class="count">\d+<\/b>/.test(list));
  check('admin can open enquiries too', (await c.get(`/backend/enquiries/${e.id}`, admin)).status === 200);
  check('agents cannot see enquiries', (await c.get('/backend/enquiries', agent)).status !== 200);
  check('logged-out visitors cannot see enquiries', (await c.get('/backend/enquiries')).status !== 200);

  const page = await (await c.get(`/backend/enquiries/${e.id}`, backend)).text();
  check('enquiry page has call and WhatsApp buttons', page.includes('href="tel:+919811122233"') && page.includes('wa.me/919811122233'));

  const me = await one('SELECT id FROM users WHERE email = ?', ROLES.backend[0]);
  r = await c.post(`/backend/enquiries/${e.id}`, backend, { status: 'contacted', assigned_to: String(me.id), follow_up_on: '2030-01-15', team_note: 'Called, sending sign-up link' });
  const e2 = await one('SELECT * FROM enquiries WHERE id = ?', e.id);
  check('team can set status, owner, follow-up and note', e2.status === 'contacted' && e2.assigned_to === me.id && e2.follow_up_on === '2030-01-15' && e2.team_note === 'Called, sending sign-up link');
  check('the change is recorded in the activity log', !!(await one("SELECT id FROM audit_log WHERE action = 'enquiry.updated' AND entity_id = ?", e.id)));
  check('"assigned to me" filter finds it', (await (await c.get('/backend/enquiries?mine=1', backend)).text()).includes('Ravi Mehta'));
  check('search finds it by agency name', (await (await c.get('/backend/enquiries?q=Sun+Routes', backend)).text()).includes('Ravi Mehta'));

  finish(c);
})().catch((e) => { console.error(e); process.exit(1); });
