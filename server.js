const path = require('path');
const express = require('express');
require('./src/async-routes');
const cookieSession = require('cookie-session');

const { one, getSettings, sessionSecret, UPLOADS_DIR } = require('./src/db');
const { restoreFile } = require('./src/files');
const { seed } = require('./src/seed');
const { ensureProductCosts } = require('./src/products');
const { inr, fmtDate } = require('./src/util');
const { icon } = require('./src/icons');
const { AppError } = require('./src/services');

// Database start-up (schema check, demo data on an empty database) runs once; requests wait for it.
const started = (async () => {
  if (await seed()) console.log('First run: demo data created.');
  // Inventory from before VaayuTrip's margin existed: its prices become costs (runs once).
  const moved = await ensureProductCosts();
  if (moved) console.log(`Margins applied to ${moved} existing inventory items.`);
})();

const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.disable('x-powered-by');
// Behind Vercel's proxy, so share links get the real https:// scheme and host.
if (process.env.VERCEL) app.set('trust proxy', true);

app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1h' }));
app.use((req, res, next) => started.then(() => next(), next));
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
  sessions ||= cookieSession({ name: 'vt_sess', secret: await sessionSecret(), sameSite: 'lax', httpOnly: true, maxAge: 7 * 24 * 3600 * 1000 });
  sessions(req, res, next);
});

app.use(async (req, res, next) => {
  res.locals.inr = inr;
  res.locals.fmtDate = fmtDate;
  res.locals.icon = icon;
  // Package image, or a generated cover card with the destination name when none is uploaded.
  res.locals.cover = (p) => p.image_url || `/cover/${encodeURIComponent(p.destination || p.title || 'Holiday')}.svg`;
  res.locals.path = req.path;
  res.locals.settings = await getSettings();
  res.locals.flash = req.session.flash || [];
  req.session.flash = [];
  req.flash = (type, message) => req.session.flash.push({ type, message });

  res.locals.user = null;
  res.locals.agency = null;
  if (req.session.userId) {
    const user = await one('SELECT id, role, agency_id, name, email FROM users WHERE id = ? AND is_active = 1', req.session.userId);
    if (user) {
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

app.use((req, res) => {
  res.status(404);
  res.page('public/message', { title: 'Page not found', heading: 'Page not found', message: "The page you're looking for doesn't exist." }, 'public');
});

app.use((err, req, res, next) => {
  if (err instanceof AppError) {
    req.flash('error', err.message);
    return res.redirect(req.get('referer') || '/');
  }
  console.error(err);
  res.status(500);
  res.page('public/message', { title: 'Something went wrong', heading: 'Something went wrong', message: 'Please try again. If it keeps happening, contact support.' }, 'public');
});

// On Vercel the platform invokes the exported app; locally we listen ourselves.
if (!process.env.VERCEL) {
  const PORT = Number(process.env.PORT) || 3000;
  app.listen(PORT, () => console.log(`VaayuTrip Agent running at http://localhost:${PORT}`));
}

module.exports = app;
