// Route guards.

// Where each role lands after logging in.
const homeFor = (role) => ({ admin: '/admin', backend: '/backend' }[role] || '/agent');

function requireAgent(req, res, next) {
  if (!req.user) return res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
  if (req.user.role !== 'agent' || !req.agency) return res.redirect(homeFor(req.user.role));
  if (req.agency.status === 'suspended') {
    req.session.userId = null;
    req.flash('error', 'Your agency account is suspended. Contact VaayuTrip support.');
    return res.redirect('/login');
  }
  next();
}

// Until VaayuTrip approves an agency, its portal shows only the application: its status (/agent),
// company details and documents, notifications and support. Everything else waits for approval.
const PENDING_PATHS = /^\/(settings|notifications|support)(\/|$)/;
function limitPendingAgency(req, res, next) {
  if (req.agency.status === 'active' || req.path === '/' || PENDING_PATHS.test(req.path)) return next();
  req.flash('warn', 'This opens once VaayuTrip approves your agency. Here is where your application stands.');
  return res.redirect('/agent');
}

// Defence in depth for actions that move money or create bookings.
function requireActiveAgency(req, res, next) {
  if (req.agency.status !== 'active') {
    req.flash('error', 'Your account is awaiting approval by VaayuTrip. You can complete your profile meanwhile.');
    return res.redirect(req.get('referer') || '/agent');
  }
  next();
}

function requireAdmin(req, res, next) {
  if (!req.user) return res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
  if (req.user.role !== 'admin') return res.redirect(homeFor(req.user.role));
  next();
}

// The backend portal is for the backend team, who enter VaayuTrip's inventory; admins can use it too.
function requireBackend(req, res, next) {
  if (!req.user) return res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
  if (!['backend', 'admin'].includes(req.user.role)) return res.redirect(homeFor(req.user.role));
  next();
}

// Wraps async/sync handlers so thrown errors reach the error middleware.
const h = (fn) => (req, res, next) => {
  try {
    const out = fn(req, res, next);
    if (out && typeof out.catch === 'function') out.catch(next);
  } catch (e) {
    next(e);
  }
};

module.exports = { requireAgent, requireActiveAgency, limitPendingAgency, requireAdmin, requireBackend, homeFor, h };
