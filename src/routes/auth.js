const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { requireLogin } = require('../middleware/auth');

const router = express.Router();

router.get('/login', (req, res) => {
  if (req.session.user) return res.redirect('/');
  res.render('login', {
    error: null,
    notice: req.query.restored === '1' ? 'Data restored from backup — please sign in again.' : null
  });
});

router.post('/login', async (req, res) => {
  const { username, password } = req.body;
  const usernameNorm = (username || '').trim().toLowerCase();
  const { rows } = await db.query('SELECT * FROM users WHERE username = $1', [usernameNorm]);
  const user = rows[0];

  if (!user || !bcrypt.compareSync(password || '', user.password_hash)) {
    return res.status(401).render('login', { error: 'Incorrect email or password.', notice: null });
  }

  let memberName = 'Admin';
  if (user.member_id != null) {
    const { rows: memberRows } = await db.query('SELECT name FROM members WHERE id = $1', [user.member_id]);
    if (memberRows[0]) memberName = memberRows[0].name;
  }

  req.session.user = {
    id: user.id,
    member_id: user.member_id,
    name: memberName,
    username: user.username,
    role: user.role,
    must_change_password: !!user.must_change_password
  };
  res.redirect('/');
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

router.get('/account/password', requireLogin, (req, res) => {
  res.render('change_password', { error: null, forced: req.session.user.must_change_password });
});

router.post('/account/password', requireLogin, async (req, res) => {
  const { current_password, new_password, confirm_password } = req.body;
  const { rows } = await db.query('SELECT * FROM users WHERE id = $1', [req.session.user.id]);
  const user = rows[0];

  if (!bcrypt.compareSync(current_password || '', user.password_hash)) {
    return res.status(400).render('change_password', {
      error: 'Current password is incorrect.',
      forced: req.session.user.must_change_password
    });
  }
  if (!new_password || new_password.length < 8) {
    return res.status(400).render('change_password', {
      error: 'New password must be at least 8 characters.',
      forced: req.session.user.must_change_password
    });
  }
  if (new_password !== confirm_password) {
    return res.status(400).render('change_password', {
      error: 'New password and confirmation do not match.',
      forced: req.session.user.must_change_password
    });
  }

  await db.query('UPDATE users SET password_hash = $2, must_change_password = false WHERE id = $1', [
    user.id,
    bcrypt.hashSync(new_password, 10)
  ]);
  req.session.user.must_change_password = false;
  res.redirect('/');
});

module.exports = router;
