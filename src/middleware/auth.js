function requireLogin(req, res, next) {
  if (!req.session.user) return res.redirect('/login');
  res.locals.currentUser = req.session.user;
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session.user) return res.redirect('/login');
  if (req.session.user.role !== 'admin') {
    return res.status(403).render('error', { message: 'Admins only.' });
  }
  next();
}

// Admins and team leads can both act on approvals (leave, swaps). Structural
// changes (members, projects, settings, scheduling, data reset) stay admin-only.
function requireApprover(req, res, next) {
  if (!req.session.user) return res.redirect('/login');
  if (req.session.user.role !== 'admin' && req.session.user.role !== 'lead') {
    return res.status(403).render('error', { message: 'Only admins and team leads can do that.' });
  }
  next();
}

function requirePasswordCurrent(req, res, next) {
  if (req.session.user && req.session.user.must_change_password && req.path !== '/account/password') {
    return res.redirect('/account/password');
  }
  next();
}

module.exports = { requireLogin, requireAdmin, requireApprover, requirePasswordCurrent };
