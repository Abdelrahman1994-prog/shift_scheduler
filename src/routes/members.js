const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const db = require('../db');
const settings = require('../settings');
const { requireAdmin } = require('../middleware/auth');

const router = express.Router();

const ROLES = ['member', 'lead', 'admin'];

function genPassword() {
  return crypto.randomBytes(6).toString('base64').replace(/[^a-zA-Z0-9]/g, '').slice(0, 8) || 'temp1234';
}

async function loadMembersWithProjects() {
  const { rows: members } = await db.query(`
    SELECT m.*, u.role
    FROM members m
    LEFT JOIN users u ON u.member_id = m.id
    ORDER BY m.active DESC, m.name
  `);
  const { rows: links } = await db.query(`
    SELECT mp.member_id, p.id, p.name
    FROM member_projects mp JOIN projects p ON p.id = mp.project_id
  `);
  const byMember = {};
  for (const l of links) {
    if (!byMember[l.member_id]) byMember[l.member_id] = [];
    byMember[l.member_id].push({ id: l.id, name: l.name });
  }
  return members.map((m) => ({ ...m, projects: byMember[m.id] || [] }));
}

router.get('/members', requireAdmin, async (req, res) => {
  const [members, allProjects, defaultAnnualLeaveDays] = await Promise.all([
    loadMembersWithProjects(),
    db.query('SELECT * FROM projects ORDER BY name').then((r) => r.rows),
    settings.get('default_annual_leave_days', '21')
  ]);

  res.render('members', {
    title: 'Members',
    active: 'members',
    members,
    allProjects,
    ROLES,
    defaultAnnualLeaveDays
  });
});

router.post('/members', requireAdmin, async (req, res) => {
  const { name, email, slack_id, can_oncall, can_overnight } = req.body;
  const role = ROLES.includes(req.body.role) ? req.body.role : 'member';
  const projectIds = [].concat(req.body.project_ids || []).map(Number);
  const annualLeaveDays =
    req.body.annual_leave_days !== '' && req.body.annual_leave_days != null
      ? Math.max(0, Number(req.body.annual_leave_days)) || 0
      : null;

  if (!name || !email) {
    req.session.flash = { type: 'error', message: 'Name and email are required.' };
    return res.redirect('/members');
  }

  const emailNorm = email.trim().toLowerCase();
  const { rows: existing } = await db.query('SELECT 1 FROM members WHERE email = $1', [emailNorm]);
  if (existing.length > 0) {
    req.session.flash = { type: 'error', message: 'A member with that email already exists.' };
    return res.redirect('/members');
  }

  const tempPassword = genPassword();
  const hash = bcrypt.hashSync(tempPassword, 10);

  await db.withTransaction(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO members (name, email, slack_id, can_oncall, can_overnight, active, created_at, annual_leave_days)
       VALUES ($1, $2, $3, $4, $5, true, $6, $7) RETURNING id`,
      [name.trim(), emailNorm, (slack_id || '').trim() || null, !!can_oncall, !!can_overnight, new Date().toISOString(), annualLeaveDays]
    );
    const memberId = rows[0].id;

    for (const pid of projectIds) {
      await client.query('INSERT INTO member_projects (member_id, project_id) VALUES ($1, $2)', [memberId, pid]);
    }

    await client.query(
      `INSERT INTO users (member_id, username, password_hash, role, must_change_password) VALUES ($1, $2, $3, $4, true)`,
      [memberId, emailNorm, hash, role]
    );
  });

  req.session.flash = {
    type: 'success',
    message: `${name} added. Login: ${emailNorm} — temporary password: ${tempPassword} (share this with them; they'll be asked to change it on first login).`
  };
  res.redirect('/members');
});

router.post('/members/:id/edit', requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const { name, email, slack_id, can_oncall, can_overnight, active } = req.body;
  const role = ROLES.includes(req.body.role) ? req.body.role : 'member';
  const projectIds = [].concat(req.body.project_ids || []).map(Number);
  const annualLeaveDays =
    req.body.annual_leave_days !== '' && req.body.annual_leave_days != null
      ? Math.max(0, Number(req.body.annual_leave_days)) || 0
      : null;

  await db.withTransaction(async (client) => {
    const { rows } = await client.query('SELECT id, email FROM members WHERE id = $1', [id]);
    if (rows.length === 0) return;

    const emailNorm = email.trim().toLowerCase();
    await client.query(
      `UPDATE members SET name = $2, email = $3, slack_id = $4, can_oncall = $5, can_overnight = $6, active = $7, annual_leave_days = $8
       WHERE id = $1`,
      [id, name.trim(), emailNorm, (slack_id || '').trim() || null, !!can_oncall, !!can_overnight, !!active, annualLeaveDays]
    );

    await client.query('DELETE FROM member_projects WHERE member_id = $1', [id]);
    for (const pid of projectIds) {
      await client.query('INSERT INTO member_projects (member_id, project_id) VALUES ($1, $2)', [id, pid]);
    }

    await client.query('UPDATE users SET username = $2, role = $3 WHERE member_id = $1', [id, emailNorm, role]);
  });

  req.session.flash = { type: 'success', message: 'Member updated.' };
  res.redirect('/members');
});

router.post('/members/:id/reset-password', requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const { rows } = await db.query('SELECT * FROM members WHERE id = $1', [id]);
  const member = rows[0];
  if (!member) return res.redirect('/members');

  const tempPassword = genPassword();
  const hash = bcrypt.hashSync(tempPassword, 10);

  await db.query('UPDATE users SET password_hash = $2, must_change_password = true WHERE member_id = $1', [id, hash]);

  req.session.flash = {
    type: 'success',
    message: `Password reset for ${member.name}. New temporary password: ${tempPassword}`
  };
  res.redirect('/members');
});

module.exports = router;
