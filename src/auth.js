// Route guards.

function requireAgent(req, res, next) {
  if (!req.user) return res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
  if (req.user.role !== 'agent' || !req.agency) return res.redirect('/admin');
  if (req.agency.status === 'suspended') {
    req.session.userId = null;
    req.flash('error', 'Your agency account is suspended. Contact VaayuTrip support.');
    return res.redirect('/login');
  }
  next();
}

// Pending agencies can explore the portal and set up their profile, but not transact.
function requireActiveAgency(req, res, next) {
  if (req.agency.status !== 'active') {
    req.flash('error', 'Your account is awaiting approval by VaayuTrip. You can complete your profile meanwhile.');
    return res.redirect(req.get('referer') || '/agent');
  }
  next();
}

function requireAdmin(req, res, next) {
  if (!req.user) return res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
  if (req.user.role !== 'admin') return res.redirect('/agent');
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

module.exports = { requireAgent, requireActiveAgency, requireAdmin, h };
