// Things disappearing: inventory deleted while packages and quotes use it, customers deleted, agencies suspended.
const { start, finish, check, db, ROLES } = require('./helpers');

const one = (sql, ...p) => db.prepare(sql).get(...p);
const all = (sql, ...p) => db.prepare(sql).all(...p);

(async () => {
  const c = await start();
  const agent = await c.login(...ROLES.agent);
  const backend = await c.login(...ROLES.backend);
  const admin = await c.login(...ROLES.admin);
  const sky = await one("SELECT * FROM agencies WHERE slug = 'skyline-holidays'");

  // A product used by a package and a quote is deleted by the backend team.
  const pkg = await one("SELECT * FROM packages WHERE agency_id = ? AND status = 'published' ORDER BY id LIMIT 1", sky.id);
  const usedId = JSON.parse(pkg.details).items[0].id;
  const quotesUsing = await all('SELECT DISTINCT quote_id FROM quote_items WHERE product_id = ?', usedId);
  await c.post(`/backend/products/${usedId}/delete`, backend, {});
  check('backend deleted an item in use', !(await one('SELECT 1 FROM products WHERE id = ?', usedId)));
  const pkgPage = await c.get(`/agent/packages/${pkg.id}`, agent);
  const pkgHtml = await pkgPage.text();
  check('package page still works and warns about the missing item', pkgPage.status === 200 && /no longer offered/i.test(pkgHtml));
  check('package edit form still works', (await c.get(`/agent/packages/${pkg.id}/edit`, agent)).status === 200);
  check("agent's public package page still works", (await c.get(`/site/${sky.slug}/p/${pkg.slug}`)).status === 200);
  for (const { quote_id: qid } of quotesUsing.slice(0, 3)) {
    const q = await one('SELECT * FROM quotes WHERE id = ?', qid);
    check(`quote ${q.code} still opens (agent and customer)`, (await c.get(`/agent/quotes/${qid}`, agent)).status === 200 && (await c.get(`/q/${q.code}`)).status === 200);
  }
  const r = await c.post(`/agent/packages/${pkg.id}/quote`, agent, { adults: '2', rooms: '1' });
  check('quoting a package with a withdrawn item does not crash', r.status === 302);

  // Unpublishing (not deleting) keeps history.
  const live = await one("SELECT id FROM products WHERE status = 'published' ORDER BY id DESC LIMIT 1");
  await c.post(`/backend/products/${live.id}/status`, backend, { status: 'draft' });
  check('unpublished item disappears from the catalogue', (await c.get(`/agent/activities/${live.id}`, agent)).status !== 200 || (await (await c.get(`/agent/activities/${live.id}`, agent)).text()).includes('no longer'));

  // A customer with quotes is deleted (if the app allows it) or kept; either way pages keep working.
  const cust = await one('SELECT c.* FROM customers c JOIN quotes q ON q.customer_id = c.id WHERE c.agency_id = ? LIMIT 1', sky.id);
  if (cust) {
    await db.prepare('DELETE FROM customers WHERE id = ?').run(cust.id);
    const q = await one('SELECT id FROM quotes WHERE agency_id = ? ORDER BY id LIMIT 1', sky.id);
    check('quotes survive their customer being deleted', (await c.get(`/agent/quotes/${q.id}`, agent)).status === 200 && (await c.get('/agent/quotes', agent)).status === 200);
  }

  // Suspension: logged out, website and API off.
  await c.post('/agent/api/regenerate', agent, {});
  const key = (await one('SELECT api_key FROM agencies WHERE id = ?', sky.id)).api_key;
  await c.post(`/admin/agents/${sky.id}/status`, admin, { status: 'suspended' });
  const after = await c.get('/agent', agent);
  check('suspended agent is logged out', after.status === 302 && after.headers.get('location').startsWith('/login'));
  check('suspended agent cannot log back in to the portal', (await c.get('/agent', await c.login(...ROLES.agent))).status === 302);
  check("suspended agency's website is offline", (await c.get(`/site/${sky.slug}`)).status === 404);
  check("suspended agency's API key stops working", (await fetch(`${c.B}/api/v1/packages`, { headers: { authorization: `Bearer ${key}` } })).status === 401);
  check('admin agent page for a suspended agency works', (await c.get(`/admin/agents/${sky.id}`, admin)).status === 200);
  await c.post(`/admin/agents/${sky.id}/status`, admin, { status: 'active' });
  check('reactivated agency works again', (await c.get('/agent', await c.login(...ROLES.agent))).status === 200);

  // Switched-off staff.
  const staff = await one("SELECT id FROM users WHERE email = 'backend@vaayutrip.com'");
  await c.post(`/admin/team/${staff.id}/toggle`, admin, {});
  check('switched-off backend user is sent to login', (await c.get('/backend', backend)).status === 302);
  await c.post(`/admin/team/${staff.id}/toggle`, admin, {});

  // Long lists are paged: 60 customers → 50 on page 1, the rest on page 2.
  const ag = await c.login(...ROLES.agent);
  for (let i = 0; i < 60; i++) await db.prepare('INSERT INTO customers (agency_id, name) VALUES (?, ?)').run(sky.id, `Paging Customer ${String(i).padStart(2, '0')}`);
  const p1 = await (await c.get('/agent/customers?q=Paging', ag)).text();
  const p2 = await (await c.get('/agent/customers?q=Paging&page=2', ag)).text();
  const rowsOn = (html) => (html.match(/Paging Customer \d\d/g) || []).length;
  check('page 1 shows 50 customers and a Next link keeping the search', rowsOn(p1) === 50 && p1.includes('page=2') && p1.includes('q=Paging'), rowsOn(p1));
  check('page 2 shows the other 10 and a Previous link', rowsOn(p2) === 10 && p2.includes('rel="prev"'), rowsOn(p2));
  check('a nonsense page number falls back to page 1', (await c.get('/agent/customers?page=abc', ag)).status === 200);

  // Admin pages after all of the above.
  for (const p of ['/admin', '/admin/agents', '/admin/bookings', '/admin/invoices', '/admin/log', '/backend/products']) {
    check(`${p} still renders`, (await c.get(p, p.startsWith('/backend') ? await c.login(...ROLES.backend) : admin)).status === 200);
  }
  finish(c);
})().catch((e) => { console.error(e); process.exit(1); });
