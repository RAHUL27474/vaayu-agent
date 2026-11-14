// Logs in as every role and follows every internal link it finds, checking each page for server errors,
// leaked placeholders ([object Promise], NaN, undefined, Invalid Date), slow responses, too many database
// queries (N+1) and basic accessibility (labelled fields, image alt text, named buttons).
const { start, finish, check, stats, ROLES } = require('./helpers');

const MAX_PAGES = 400;
const SLOW_MS = 1500;
// Pages making more queries than this probably query once per row (N+1).
const MAX_QUERIES = 25;
// Links that change state or leave the site; everything else is fair game for a GET.
const SKIP = [/^\/logout/, /^\/uploads\//, /^\/img\//, /^\/css\//, /^\/js\//, /\.csv$/, /^\/cover\//];
const LEAKS = [/\[object (Promise|Object)\]/, />\s*NaN\s*</, /₹NaN/, />\s*undefined\s*</, /Invalid Date/, /\bnull\s*(nights?|rooms?|guests?)\b/];

const heavy = [];
const top = [];
const a11y = new Map();

// Accessibility basics: every visible form field has a label, images have alt text, icon buttons have a name.
function accessibility(html, page) {
  const body = html.replace(/<template[\s\S]*?<\/template>/g, '');
  const labelled = new Set([...body.matchAll(/<label[^>]*\bfor="([^"]+)"/g)].map((m) => m[1]));
  const out = [];
  for (const m of body.matchAll(/<(input|select|textarea)\b([^>]*)>/g)) {
    const attrs = m[2];
    if (/type="(hidden|submit|button|checkbox|radio)"/.test(attrs) || /\shidden(\s|$|=)/.test(attrs)) continue;
    const id = (attrs.match(/\bid="([^"]+)"/) || [])[1];
    if (/aria-label(ledby)?="/.test(attrs) || (id && labelled.has(id))) continue;
    // A field wrapped in its own <label> is fine.
    const before = body.slice(Math.max(0, m.index - 400), m.index);
    const lastOpen = before.lastIndexOf('<label');
    if (lastOpen >= 0 && before.indexOf('</label>', lastOpen) < 0) continue;
    out.push(`${m[1]} ${(attrs.match(/\bname="([^"]+)"/) || [, '?'])[1]}`);
  }
  for (const m of body.matchAll(/<img\b([^>]*)>/g)) if (!/\balt=/.test(m[1])) out.push(`img ${(m[1].match(/src="([^"]+)"/) || [, '?'])[1]}`);
  for (const m of body.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)) {
    const text = m[2].replace(/<svg[\s\S]*?<\/svg>/g, '').replace(/<[^>]+>/g, '').trim();
    if (!text && !/aria-label="/.test(m[1]) && !/title="/.test(m[1])) out.push('button without a name');
  }
  for (const issue of out) {
    const key = `${issue} on ${page.replace(/\/\d+/g, '/:id')}`;
    a11y.set(key, (a11y.get(key) || 0) + 1);
  }
}

async function crawl(client, role, cookie, startAt) {
  const seen = new Set();
  const queue = [startAt];
  const problems = [];
  while (queue.length && seen.size < MAX_PAGES) {
    const p = queue.shift();
    if (seen.has(p)) continue;
    seen.add(p);
    const t = Date.now();
    const q0 = stats.queries;
    const r = await client.get(p, cookie);
    const ms = Date.now() - t;
    const queries = stats.queries - q0;
    if (queries > MAX_QUERIES) heavy.push(`${queries} queries: ${role} ${p}`);
    top.push([queries, `${role} ${p.split('?')[0]}`]);
    if (ms > SLOW_MS) problems.push(`slow ${ms} ms: ${p}`);
    if (r.status >= 500) { problems.push(`${r.status}: ${p}`); continue; }
    if (r.status >= 300 && r.status < 400) {
      const loc = r.headers.get('location');
      if (loc && loc.startsWith('/') && !seen.has(loc)) queue.push(loc);
      continue;
    }
    if (r.status === 404) { problems.push(`404 from an internal link: ${p}`); continue; }
    const type = r.headers.get('content-type') || '';
    if (!type.includes('text/html')) { await r.arrayBuffer(); continue; }
    const html = await r.text();
    accessibility(html, p.split('?')[0]);
    for (const re of LEAKS) {
      const m = html.match(re);
      if (m) problems.push(`leak "${m[0].trim()}" on ${p}`);
    }
    for (const m of html.matchAll(/href="(\/[^"#]*)"/g)) {
      const href = m[1].replace(/&amp;/g, '&');
      if (SKIP.some((re) => re.test(href)) || seen.has(href)) continue;
      queue.push(href);
    }
  }
  check(`${role}: crawled ${seen.size} pages without errors`, problems.length === 0, problems.slice(0, 15).join(' | ') + (problems.length > 15 ? ` … +${problems.length - 15}` : ''));
  return seen.size;
}

(async () => {
  const client = await start();
  const t0 = Date.now();
  let total = await crawl(client, 'public', '', '/');
  for (const [role, [email, pw]] of Object.entries(ROLES)) {
    const cookie = await client.login(email, pw);
    check(`${role} can log in`, Boolean(cookie));
    total += await crawl(client, role, cookie, { admin: '/admin', backend: '/backend' }[role] || '/agent');
  }
  // Agent websites are reached from the agent portal, but crawl one directly too.
  total += await crawl(client, 'agent website', '', '/site/skyline-holidays');
  // Search engines and link previews: public pages listed, private ones kept out.
  const robots = await (await client.get('/robots.txt')).text();
  check('robots.txt keeps portals and shared quotes out', /Disallow: \/agent/.test(robots) && /Disallow: \/q\//.test(robots) && /Sitemap: /.test(robots));
  const sitemap = await (await client.get('/sitemap.xml')).text();
  check('sitemap lists public pages and agency packages', sitemap.includes('/terms</loc>') && /\/site\/skyline-holidays\/p\//.test(sitemap));
  const pkgPage = await (await client.get(sitemap.match(/\/site\/skyline-holidays\/p\/[^<]+/)[0])).text();
  check('agency package page has its own link preview, no VaayuTrip branding', /og:site_name" content="Skyline Holidays"/.test(pkgPage) && !pkgPage.includes('VaayuTrip for Travel Agents'));
  check('portal pages are noindex', /name="robots" content="noindex/.test(await (await client.get('/agent', await client.login(...ROLES.agent))).text()));
  console.log(`crawled ${total} pages in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  if (process.env.VERBOSE) console.log('heaviest pages:', [...new Map(top.sort((a, b) => b[0] - a[0]).map(([n, k]) => [k, n])).entries()].slice(0, 10).map(([k, n]) => `${n} ${k}`).join(' | '));
  check('form fields are labelled, images have alt text, buttons have names', a11y.size === 0, [...a11y.keys()].filter((k) => !/(sell|qty)_d+ on /.test(k) || /(sell|qty)_1 on/.test(k)).slice(0, 25).join(' | ') + (a11y.size > 25 ? ` … +${a11y.size - 25}` : ''));
  const worst = [...new Set(heavy)].sort((a, b) => parseInt(b, 10) - parseInt(a, 10));
  check(`no page makes more than ${MAX_QUERIES} database queries`, worst.length === 0, worst.slice(0, 12).join(' | '));
  finish(client);
})().catch((e) => { console.error(e); process.exit(1); });
