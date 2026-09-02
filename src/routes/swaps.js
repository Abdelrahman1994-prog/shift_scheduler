const express = require('express');
const db = require('../db');
const scheduler = require('../scheduler');

const router = express.Router();

const SWAP_JOIN = `
  SELECT sw.*,
    s.slot_date, s.kind, s.start_time, s.end_time, s.week_start, s.status AS slot_status,
    p.name AS project_name,
    fm.name AS from_name, tm.name AS to_name
  FROM swap_requests sw
  LEFT JOIN shift_slots s ON s.id = sw.shift_slot_id
  LEFT JOIN projects p ON p.id = s.project_id
  LEFT JOIN members fm ON fm.id = sw.from_member_id
  LEFT JOIN members tm ON tm.id = sw.to_member_id
`;

async function loadSwap(id) {
  const { rows } = await db.query(`${SWAP_JOIN} WHERE sw.id = $1`, [Number(id)]);
  return rows[0] || null;
}

router.get('/swaps', async (req, res) => {
  const user = req.session.user;
  const canApprove = user.role === 'admin' || user.role === 'lead';

  const [openToAccept, mine, all] = await Promise.all([
    canApprove
      ? Promise.resolve([])
      : db
          .query(
            `${SWAP_JOIN} WHERE sw.status = 'pending' AND sw.from_member_id != $1 AND (sw.to_member_id = $1 OR sw.to_member_id IS NULL)`,
            [user.member_id]
          )
          .then((r) => r.rows),
    canApprove
      ? Promise.resolve([])
      : db
          .query(`${SWAP_JOIN} WHERE sw.from_member_id = $1 ORDER BY sw.created_at DESC LIMIT 20`, [user.member_id])
          .then((r) => r.rows),
    canApprove ? db.query(`${SWAP_JOIN} ORDER BY sw.created_at DESC LIMIT 50`).then((r) => r.rows) : Promise.resolve([])
  ]);

  res.render('swaps', {
    title: 'Swap requests',
    active: 'swaps',
    canApprove,
    openToAccept,
    mine,
    all,
    KIND_LABELS: scheduler.KIND_LABELS
  });
});

router.post('/swaps', async (req, res) => {
  const user = req.session.user;
  const slotId = Number(req.body.shift_slot_id);
  const { rows } = await db.query('SELECT * FROM shift_slots WHERE id = $1', [slotId]);
  const slot = rows[0];

  if (!slot || slot.assignee_id !== user.member_id) {
    req.session.flash = { type: 'error', message: 'You can only request a swap on your own shift.' };
    return res.redirect('back');
  }
  if (slot.status !== 'published') {
    req.session.flash = { type: 'error', message: 'Only published shifts can be swapped.' };
    return res.redirect('back');
  }

  await db.query(
    `INSERT INTO swap_requests (shift_slot_id, from_member_id, to_member_id, status, created_at, decided_at)
     VALUES ($1, $2, NULL, 'pending', $3, NULL)`,
    [slotId, user.member_id, new Date().toISOString()]
  );

  req.session.flash = { type: 'success', message: 'Swap request posted — any eligible teammate can accept it.' };
  res.redirect(`/schedule?week=${slot.week_start}`);
});

router.post('/swaps/:id/accept', async (req, res) => {
  const user = req.session.user;
  const swap = await loadSwap(req.params.id);
  if (!swap || swap.status !== 'pending') {
    req.session.flash = { type: 'error', message: 'This swap request is no longer available.' };
    return res.redirect('/swaps');
  }
  if (swap.from_member_id === user.member_id) {
    req.session.flash = { type: 'error', message: "You can't accept your own swap request." };
    return res.redirect('/swaps');
  }
  if (swap.to_member_id && swap.to_member_id !== user.member_id) {
    req.session.flash = { type: 'error', message: 'This swap was addressed to someone else.' };
    return res.redirect('/swaps');
  }

  const check = await scheduler.checkAssignmentValidity(user.member_id, swap.shift_slot_id);
  if (!check.ok) {
    req.session.flash = { type: 'error', message: `Can't accept: ${check.reason}` };
    return res.redirect('/swaps');
  }

  await db.withTransaction(async (client) => {
    await client.query('UPDATE shift_slots SET assignee_id = $2 WHERE id = $1', [swap.shift_slot_id, user.member_id]);
    await client.query(
      `UPDATE swap_requests SET status = 'accepted', to_member_id = $2, decided_at = $3 WHERE id = $1`,
      [swap.id, user.member_id, new Date().toISOString()]
    );
  });

  req.session.flash = { type: 'success', message: 'Swap accepted — the shift is now yours.' };
  res.redirect('/swaps');
});

router.post('/swaps/:id/cancel', async (req, res) => {
  const user = req.session.user;
  const swap = await loadSwap(req.params.id);
  if (!swap) return res.redirect('/swaps');
  if (swap.from_member_id !== user.member_id && user.role !== 'admin' && user.role !== 'lead') {
    return res.status(403).render('error', { message: 'You can only cancel your own swap requests.' });
  }

  await db.query(`UPDATE swap_requests SET status = 'cancelled', decided_at = $2 WHERE id = $1`, [
    swap.id,
    new Date().toISOString()
  ]);

  req.session.flash = { type: 'info', message: 'Swap request cancelled.' };
  res.redirect('/swaps');
});

module.exports = router;
