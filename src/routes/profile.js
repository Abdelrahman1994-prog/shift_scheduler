const express = require('express');
const db = require('../db');
const { requireLogin } = require('../middleware/auth');

const router = express.Router();

function canEditProfile(user, memberId) {
  return user.role === 'admin' || user.member_id === memberId;
}
function canViewProfile(user, memberId) {
  return user.role === 'admin' || user.role === 'lead' || user.member_id === memberId;
}

// Reshapes a flattened member row (+ its history rows) back into the
// `.profile.*` / `.profile.history[]` shape the views expect.
function withProfile(member, history) {
  return {
    ...member,
    profile: {
      headline: member.profile_headline,
      phone: member.profile_phone,
      location: member.profile_location,
      linkedin: member.profile_linkedin,
      summary: member.profile_summary,
      skills: member.profile_skills || [],
      history: history || []
    }
  };
}

async function loadMemberWithProfile(memberId) {
  const { rows } = await db.query('SELECT * FROM members WHERE id = $1', [memberId]);
  if (!rows.length) return null;
  const { rows: history } = await db.query(
    'SELECT * FROM member_history WHERE member_id = $1 ORDER BY start_label DESC NULLS LAST',
    [memberId]
  );
  return withProfile(rows[0], history.map((h) => ({ ...h, start: h.start_label, end: h.end_label })));
}

// Own (or, for admins, any) editable profile form.
router.get('/profile', requireLogin, async (req, res) => {
  const user = req.session.user;
  const isAdmin = user.role === 'admin';
  const activeMembers = isAdmin
    ? await db.query('SELECT * FROM members WHERE active = true ORDER BY name').then((r) => r.rows)
    : [];

  let memberId = user.member_id;
  if (isAdmin && req.query.member_id) memberId = Number(req.query.member_id);
  if (isAdmin && !memberId && activeMembers.length) memberId = activeMembers[0].id;

  const member = memberId ? await loadMemberWithProfile(memberId) : null;

  if (member && !canEditProfile(user, member.id)) {
    return res.status(403).render('error', { message: 'You can only edit your own profile.' });
  }

  res.render('profile_edit', {
    title: member ? `${member.name} — Profile` : 'My profile',
    active: 'profile',
    member,
    isAdmin,
    members: activeMembers
  });
});

router.post('/profile', requireLogin, async (req, res) => {
  const user = req.session.user;
  const isAdmin = user.role === 'admin';
  const memberId = isAdmin && req.body.member_id ? Number(req.body.member_id) : user.member_id;

  if (!memberId || !canEditProfile(user, memberId)) {
    return res.status(403).render('error', { message: 'You can only edit your own profile.' });
  }

  const skills = (req.body.skills || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const { rowCount } = await db.query(
    `UPDATE members SET
       profile_headline = $2, profile_phone = $3, profile_location = $4,
       profile_linkedin = $5, profile_summary = $6, profile_skills = $7
     WHERE id = $1`,
    [
      memberId,
      (req.body.headline || '').trim(),
      (req.body.phone || '').trim(),
      (req.body.location || '').trim(),
      (req.body.linkedin || '').trim(),
      (req.body.summary || '').trim(),
      skills
    ]
  );
  if (rowCount === 0) return res.redirect('/profile');

  req.session.flash = { type: 'success', message: 'Profile updated.' };
  res.redirect(`/profile${isAdmin ? `?member_id=${memberId}` : ''}`);
});

router.post('/profile/history', requireLogin, async (req, res) => {
  const user = req.session.user;
  const isAdmin = user.role === 'admin';
  const memberId = isAdmin && req.body.member_id ? Number(req.body.member_id) : user.member_id;

  if (!memberId || !canEditProfile(user, memberId)) {
    return res.status(403).render('error', { message: 'You can only edit your own profile.' });
  }

  const title = (req.body.title || '').trim();
  const organization = (req.body.organization || '').trim();
  if (!title || !organization) {
    req.session.flash = { type: 'error', message: 'Enter a title and organization for this entry.' };
    return res.redirect(`/profile${isAdmin ? `?member_id=${memberId}` : ''}`);
  }

  await db.query(
    `INSERT INTO member_history (member_id, title, organization, start_label, end_label, description)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [memberId, title, organization, (req.body.start || '').trim() || null, (req.body.end || '').trim() || null, (req.body.description || '').trim() || null]
  );

  req.session.flash = { type: 'success', message: 'Experience added.' };
  res.redirect(`/profile${isAdmin ? `?member_id=${memberId}` : ''}`);
});

router.post('/profile/history/:entryId/delete', requireLogin, async (req, res) => {
  const user = req.session.user;
  const isAdmin = user.role === 'admin';
  const memberId = isAdmin && req.body.member_id ? Number(req.body.member_id) : user.member_id;

  if (!memberId || !canEditProfile(user, memberId)) {
    return res.status(403).render('error', { message: 'You can only edit your own profile.' });
  }

  await db.query('DELETE FROM member_history WHERE id = $1 AND member_id = $2', [Number(req.params.entryId), memberId]);

  req.session.flash = { type: 'info', message: 'Experience removed.' };
  res.redirect(`/profile${isAdmin ? `?member_id=${memberId}` : ''}`);
});

// Read-only, CV-styled view — printable/exportable via the browser's own
// print-to-PDF, so no PDF-generation dependency is needed.
router.get('/profile/view/:memberId', requireLogin, async (req, res) => {
  const user = req.session.user;
  const memberId = Number(req.params.memberId);

  if (!canViewProfile(user, memberId)) {
    return res.status(403).render('error', { message: 'You can only view your own profile.' });
  }
  const member = await loadMemberWithProfile(memberId);
  if (!member) return res.status(404).render('error', { message: 'Member not found.' });

  res.render('profile_view', {
    title: `${member.name} — CV`,
    active: 'profile',
    member,
    canEdit: canEditProfile(user, memberId)
  });
});

module.exports = router;
