const path = require('path');
const express = require('express');
require('./src/async-routes');
const cookieSession = require('cookie-session');

const { one, getSettings, sessionSecret, UPLOADS_DIR } = require('./src/db');
const { restoreFile } = require('./src/files');
const { homeFor } = require('./src/auth');
const { seed } = require('./src/seed');
const { ensureProductCosts } = require('./src/products');
const { inr, fmtDate } = require('./src/util');
const { icon, SPRITE } = require('./src/icons');
const { AppError } = require('./src/services');

// Database start-up (schema check, demo data on an empty database) runs once; requests wait for it.
// Retried on the next request if it fails (e.g. the database was briefly unreachable).
let started = null;
const start = () => (started ||= (async () => {
  if (await seed()) console.log('First run: demo data created.');
  // Inventory from before VaayuTrip's margin existed: its prices become costs (runs once).
  const moved = await ensureProductCosts();
  if (moved) console.log(`Margins applied to ${moved} existing inventory items.`);
})().catch((e) => { started = null; throw e; }));
start().catch((e) => console.error('Start-up failed; retrying on the next request:', e.message));

const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
// Compiled templates are reused between requests on the live site (Express only does this when NODE_ENV=production).
if (process.env.NODE_ENV === 'production' || process.env.VERCEL_ENV) app.set('view cache', true);
app.disable('x-powered-by');
// Behind Vercel's proxy, so share links get the real https:// scheme and host.
if (process.env.VERCEL) app.set('trust proxy', true);

// Basic browser protections: no framing by other sites, no MIME sniffing, no full URLs leaked to other sites.
app.use((req, res, next) => {
  res.set({
    'X-Frame-Options': 'SAMEORIGIN',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'geolocation=(), microphone=(), camera=(self)',
  });
  if (process.env.VERCEL_ENV) res.set('Strict-Transport-Security', 'max-age=31536000');
  next();
});
// Stylesheet and script URLs carry a fingerprint of their contents (?v=…), so browsers can cache them for a
// year and still pick up a new deploy at once.
const fingerprint = (rel) => require('crypto').createHash('sha1').update(require('fs').readFileSync(path.join(__dirname, 'public', rel))).digest('hex').slice(0, 10);
const ASSET_VERSIONS = { '/css/app.css': fingerprint('css/app.css'), '/js/app.js': fingerprint('js/app.js') };
// "1 booking", "3 bookings": <%= plural(n, 'booking') %>
app.locals.plural = (n, one, many = `${one}s`) => `${Number(n).toLocaleString('en-IN')} ${Number(n) === 1 ? one : many}`;
app.locals.asset = (p) => (ASSET_VERSIONS[p] ? `${p}?v=${ASSET_VERSIONS[p]}` : p);
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: '1h',
  setHeaders: (res, file) => { if (/[\\/](css|js|fonts)[\\/]/.test(file)) res.set('Cache-Control', 'public, max-age=31536000, immutable'); },
}));
// Search engines: public pages only; the portals, shared quotes and payment links stay out.
app.get('/robots.txt', (req, res) => res.type('text/plain').send([
  'User-agent: *', 'Disallow: /agent', 'Disallow: /admin', 'Disallow: /backend', 'Disallow: /q/', 'Disallow: /pay/', 'Disallow: /api/',
  `Sitemap: ${req.protocol}://${req.get('host')}/sitemap.xml`, '',
].join('\n')));

// Icon sprite (see src/icons.js): no database needed, cached for a year (the URL changes with its content).
app.get('/icons.svg', (req, res) => res.set({ 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=31536000, immutable' }).send(SPRITE));
app.use((req, res, next) => start().then(() => next(), next));

// Uptime checks: 200 when the database answers. Vercel's daily cron calls it too (vercel.json), which also keeps a
// free Supabase project from pausing for inactivity.
app.get('/healthz', async (req, res) => {
  try {
    await one('SELECT 1 AS ok');
    res.set('Cache-Control', 'no-store').json({ ok: true, time: new Date().toISOString() });
  } catch {
    res.status(503).set('Cache-Control', 'no-store').json({ ok: false });
  }
});
// Uploaded files live in the database; after a restart the disk cache is refilled on first request.
app.use('/uploads', async (req, res, next) => {
  let abs;
  try { abs = path.resolve(UPLOADS_DIR, `.${decodeURIComponent(req.path)}`); } catch { return next(); }
  if (abs.startsWith(path.resolve(UPLOADS_DIR) + path.sep)) await restoreFile(abs);
  next();
});
app.use('/uploads', express.static(UPLOADS_DIR, { maxAge: '1h' }));
// Package forms can have hundreds of fields (itinerary, hotels, rates…).
app.use(express.urlencoded({ extended: true, limit: '2mb', parameterLimit: 10000 }));
app.use(express.json({ limit: '1mb' }));
// The signing key comes from the database, so the session middleware is created on the first request.
let sessions;
app.use(async (req, res, next) => {
  // On the live site (HTTPS) the cookie is never sent over plain HTTP.
  sessions ||= cookieSession({ name: 'vt_sess', secret: await sessionSecret(), sameSite: 'lax', httpOnly: true, secure: Boolean(process.env.VERCEL_ENV), maxAge: 7 * 24 * 3600 * 1000 });
  sessions(req, res, next);
});

app.use(async (req, res, next) => {
  res.locals.inr = inr;
  res.locals.fmtDate = fmtDate;
  res.locals.icon = icon;
  // Package image, or a generated cover card with the destination name when none is uploaded.
  res.locals.cover = (p) => p.image_url || `/cover/${encodeURIComponent(p.destination || p.title || 'Holiday')}.svg`;
  res.locals.path = req.path;
  res.locals.today = new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10); // India date, for date pickers' min
  res.locals.origin = `${req.protocol}://${req.get('host')}`;
  res.locals.query = req.query;
  res.locals.settings = await getSettings();
  res.locals.flash = req.session.flash || [];
  req.session.flash = [];
  req.flash = (type, message) => req.session.flash.push({ type, message });

  res.locals.user = null;
  res.locals.agency = null;
  if (req.session.userId) {
    const user = await one('SELECT id, role, agency_id, name, email, RIGHT(password_hash, 12) AS pw_tag FROM users WHERE id = ? AND is_active = 1', req.session.userId);
    // Logged in before the password last changed: log out (sessions from before this check get the tag now).
    if (user && req.session.pw && req.session.pw !== user.pw_tag) {
      req.session.userId = null;
      req.flash('warn', 'Your password was changed. Please log in again.');
    } else if (user) {
      req.session.pw = user.pw_tag;
      delete user.pw_tag;
      req.user = user;
      res.locals.user = user;
      const [agency, unread] = await Promise.all([
        user.agency_id ? one('SELECT * FROM agencies WHERE id = ?', user.agency_id) : null,
        one(
          user.role === 'admin'
            ? 'SELECT COUNT(*) AS n FROM notifications WHERE agency_id IS NULL AND is_read = 0'
            : 'SELECT COUNT(*) AS n FROM notifications WHERE agency_id = ? AND is_read = 0',
          ...(user.role === 'admin' ? [] : [user.agency_id]),
        ),
      ]);
      if (agency) {
        req.agency = agency;
        res.locals.agency = agency;
      }
      res.locals.unread = unread.n;
    } else {
      req.session.userId = null;
    }
  }

  // Renders a view inside a layout: res.page('agent/dashboard', { title }, 'app').
  res.page = (view, data = {}, layout = 'app') => {
    res.render(view, data, (err, body) => {
      if (err) return next(err);
      res.render(`layouts/${layout}`, { ...data, body });
    });
  };
  next();
});

app.use('/', require('./src/routes/public'));
app.use('/agent', require('./src/routes/agent'));
app.use('/admin', require('./src/routes/admin'));
app.use('/backend', require('./src/routes/backend'));
app.use('/api/v1', require('./src/routes/api'));

// Signed-in people see "not found" inside their own portal, with a link back to their dashboard.
const homeOf = (req) => (req.user ? homeFor(req.user.role) : null);
app.use((req, res) => {
  res.status(404);
  res.page('public/message', { title: 'Page not found', heading: 'Page not found', message: "This page doesn't exist, or it has been removed.", home: homeOf(req), iconName: 'search' }, req.user ? 'app' : 'public');
});

app.use((err, req, res, next) => {
  if (err instanceof AppError) {
    req.flash('error', err.message);
    return res.redirect(req.get('referer') || '/');
  }
  console.error(err);
  res.status(500);
  // Failures before the page helpers exist (e.g. the database is down) get a plain page.
  if (!res.page) return res.send('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>VaayuTrip</title><div style="font:16px system-ui;max-width:520px;margin:15vh auto;padding:0 20px;text-align:center"><h1 style="font-size:22px">We’ll be right back</h1><p style="color:#555">VaayuTrip is briefly unavailable. Please try again in a few minutes.</p></div>');
  res.page('public/message', { title: 'Something went wrong', heading: 'Something went wrong', message: 'Please try again. If it keeps happening, contact support.', home: homeOf(req), iconName: 'help' }, req.user ? 'app' : 'public');
});

// On Vercel the platform invokes the exported app; locally we listen ourselves.
if (!process.env.VERCEL) {
  const PORT = Number(process.env.PORT) || 3000;
  app.listen(PORT, () => console.log(`VaayuTrip Agent running at http://localhost:${PORT}`));
}

module.exports = app;
