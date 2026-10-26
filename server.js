const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const cookieSession = require('cookie-session');

const { one, getSettings, DATA_DIR, UPLOADS_DIR } = require('./src/db');
const { seed } = require('./src/seed');
const { inr, fmtDate } = require('./src/util');
const { AppError } = require('./src/services');

if (seed()) console.log('First run: demo data created.');

// Session secret persisted so logins survive restarts; override with SESSION_SECRET in production.
function sessionSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  const file = path.join(DATA_DIR, '.session-secret');
  if (!fs.existsSync(file)) fs.writeFileSync(file, crypto.randomBytes(32).toString('hex'));
  return fs.readFileSync(file, 'utf8');
}

const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.disable('x-powered-by');

app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1h' }));
app.use('/uploads', express.static(UPLOADS_DIR, { maxAge: '1h' }));
// Package forms can have hundreds of fields (itinerary, hotels, rates…).
app.use(express.urlencoded({ extended: true, limit: '2mb', parameterLimit: 10000 }));
app.use(express.json({ limit: '1mb' }));
app.use(cookieSession({ name: 'vt_sess', secret: sessionSecret(), sameSite: 'lax', httpOnly: true, maxAge: 7 * 24 * 3600 * 1000 }));

app.use((req, res, next) => {
  res.locals.inr = inr;
  res.locals.fmtDate = fmtDate;
  // Package image, or a generated cover card with the destination name when none is uploaded.
  res.locals.cover = (p) => p.image_url || `/cover/${encodeURIComponent(p.destination || p.title || 'Holiday')}.svg`;
  res.locals.path = req.path;
  res.locals.settings = getSettings();
  res.locals.flash = req.session.flash || [];
  req.session.flash = [];
  req.flash = (type, message) => req.session.flash.push({ type, message });

  res.locals.user = null;
  res.locals.agency = null;
  if (req.session.userId) {
    const user = one('SELECT id, role, agency_id, name, email FROM users WHERE id = ?', req.session.userId);
    if (user) {
      req.user = user;
      res.locals.user = user;
      if (user.agency_id) {
        req.agency = one('SELECT * FROM agencies WHERE id = ?', user.agency_id);
        res.locals.agency = req.agency;
      }
      res.locals.unread = one(
        user.role === 'admin'
          ? 'SELECT COUNT(*) AS n FROM notifications WHERE agency_id IS NULL AND is_read = 0'
          : 'SELECT COUNT(*) AS n FROM notifications WHERE agency_id = ? AND is_read = 0',
        ...(user.role === 'admin' ? [] : [user.agency_id]),
      ).n;
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
