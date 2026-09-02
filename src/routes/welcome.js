const express = require('express');
const { requireLogin } = require('../middleware/auth');

const router = express.Router();

// Mounted after requireLogin/requirePasswordCurrent in server.js (not in
// auth.js) so someone who still has a forced password change pending gets
// sent to /account/password first, same as any other page.
router.get('/welcome', requireLogin, (req, res) => {
  res.render('welcome');
});

module.exports = router;
