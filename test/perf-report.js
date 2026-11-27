// Not a test suite (no .test.js): `node test/perf-report.js` prints database queries and time per page for every role.
// Production talks to Supabase over the network, so each query adds a round trip; keep the count low.
const { start, stats, ROLES } = require('./helpers');

const PAGES = {
  guest: ['/', '/login', '/signup', '/terms'],
  agent: ['/agent', '/agent/activities', '/agent/hotels', '/agent/flights', '/agent/transfers', '/agent/visas', '/agent/insurance', '/agent/vaayutrip-packages', '/agent/vaayutrip-packages/8',
    '/agent/packages', '/agent/packages/new', '/agent/leads', '/agent/customers', '/agent/quotes', '/agent/quotes/1', '/agent/bookings', '/agent/bookings/6', '/agent/wallet', '/agent/wallet/statement',
    '/agent/invoices', '/agent/reports', '/agent/website', '/agent/api', '/agent/offers', '/agent/notifications', '/agent/support', '/agent/settings', '/agent/team', '/agent/hotels/46', '/agent/search?q=bali', '/account'],
  admin: ['/admin', '/admin/log', '/admin/team', '/admin/agents', '/admin/agents/1', '/admin/tiers', '/admin/topups', '/admin/ledger', '/admin/bookings', '/admin/invoices', '/admin/tickets', '/admin/offers', '/admin/notifications', '/admin/settings', '/admin/bookings/6'],
  backend: ['/backend', '/backend/products', '/backend/products?kind=hotel', '/backend/products/new?kind=activity', '/backend/packages', '/backend/import', '/backend/packages/8/edit', '/backend/products/46', '/backend/enquiries', '/backend/booking-requests'],
};

(async () => {
  const c = await start();
  const cookies = { guest: '', agent: await c.login(...ROLES.agent), admin: await c.login(...ROLES.admin), backend: await c.login(...ROLES.backend) };
  const rows = [];
  for (const [role, pages] of Object.entries(PAGES)) {
    for (const p of pages) {
      await c.get(p, cookies[role]); // warm caches
      const q0 = stats.queries; const w0 = stats.waves; const t0 = process.hrtime.bigint();
      const r = await c.get(p, cookies[role]); await r.text();
      rows.push({ role, p, status: r.status, queries: stats.queries - q0, waves: stats.waves - w0, ms: Number(process.hrtime.bigint() - t0) / 1e6 });
    }
  }
  rows.sort((a, b) => b.waves - a.waves || b.queries - a.queries);
  for (const r of rows) console.log(`${String(r.waves).padStart(3)} trips ${String(r.queries).padStart(4)} q ${r.ms.toFixed(0).padStart(5)} ms  ${r.status}  ${r.role.padEnd(7)} ${r.p}`);
  const total = rows.reduce((s, r) => s + r.queries, 0);
  const trips = rows.reduce((s, r) => s + r.waves, 0);
  console.log(`\n${rows.length} pages: ${total} queries (${(total / rows.length).toFixed(1)} a page), ${trips} round trips (${(trips / rows.length).toFixed(1)} a page)`);
  c.server.close();
  process.exit(0);
})();
