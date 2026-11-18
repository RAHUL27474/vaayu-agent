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

// Agency staff roles. Paths are inside /agent; owners can open everything.
const STAFF_ROLES = {
  owner: { label: 'Owner', hint: 'Everything, including wallet, company settings, website, API and team.' },
  sales: { label: 'Sales', hint: 'Inventory, packages, leads, customers, quotes and bookings. No wallet, settings or team.' },
  accounts: { label: 'Accounts', hint: 'Wallet, invoices, bookings, quotes (view), customers and reports. No inventory or settings.' },
};
const SALES_DENY = /^\/(wallet|settings|api|team|reports|website)(\/|$)/;
const ACCOUNTS_ALLOW = /^\/($|wallet|invoices|bookings|reports|customers|quotes|notifications|support|search|offers)(\/|$)?/;
function staffCan(role, p) {
  if (!role || role === 'owner') return true;
  if (role === 'sales') return !SALES_DENY.test(p);
  if (role === 'accounts') return p === '/' || p === '' || ACCOUNTS_ALLOW.test(p);
  return false;
}
function limitStaffRole(req, res, next) {
  if (staffCan(req.user.agency_role, req.path)) return next();
  req.flash('warn', `Your role (${(STAFF_ROLES[req.user.agency_role] || {}).label || req.user.agency_role}) can't open that page. Ask your agency owner if you need it.`);
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

// Record ids in URLs: anything that isn't a sensible number is a 404, not a database error.
const idParam = (req, res, next, value) => (/^\d{1,9}$/.test(value) ? next() : next('router'));

// Upper bound for any single money amount typed into a form (₹1 crore).
const MAX_AMOUNT = 10000000;

module.exports = { STAFF_ROLES, staffCan, limitStaffRole, requireAgent, requireActiveAgency, limitPendingAgency, requireAdmin, requireBackend, homeFor, h, idParam, MAX_AMOUNT };
