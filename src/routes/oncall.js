const express = require('express');
const dayjs = require('dayjs');
const db = require('../db');
const { requireLogin } = require('../middleware/auth');
const scheduler = require('../scheduler');

const router = express.Router();

function canEditNote(user, slot) {
  if (!slot) return false;
  if (user.role === 'admin' || user.role === 'lead') return true;
  return user.member_id != null && user.member_id === slot.assignee_id;
}

router.get('/oncall', requireLogin, async (req, res) => {
  const now = dayjs();
  const user = req.session.user;

  const [statusRows, recentRows] = await Promise.all([scheduler.currentStatus(now), scheduler.recentHandoffs(now)]);
  const rows = statusRows.map((r) => ({ ...r, canEdit: canEditNote(user, r.slot) }));
  const recent = recentRows.map((s) => ({ ...s, canEdit: canEditNote(user, s) }));

  res.render('oncall', {
    title: 'On-call now',
    active: 'oncall',
    generatedAt: now.format('ddd, MMM D — HH:mm'),
    rows,
    recent
  });
});

router.post('/oncall/slot/:id/note', requireLogin, async (req, res) => {
  const slotId = Number(req.params.id);
  const { rows } = await db.query('SELECT * FROM shift_slots WHERE id = $1', [slotId]);
  const slot = rows[0];

  if (!slot || !canEditNote(req.session.user, slot)) {
    return res.status(403).render('error', { message: 'You can only edit the handover note for your own shift.' });
  }

  await scheduler.setHandoverNote(slotId, (req.body.handover_note || '').trim());
  req.session.flash = { type: 'success', message: 'Handover note saved.' };
  res.redirect('/oncall');
});

module.exports = router;
