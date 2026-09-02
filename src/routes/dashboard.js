const express = require('express');
const dayjs = require('dayjs');
const db = require('../db');
const { weekStartFor, KIND_LABELS } = require('../scheduler');

const router = express.Router();

router.get('/', async (req, res) => {
  const user = req.session.user;
  const weekStart = weekStartFor();
  const canApprove = user.role === 'admin' || user.role === 'lead';
  const today = dayjs().format('YYYY-MM-DD');

  if (canApprove) {
    const [activeMembers, activeProjects, pendingLeave, pendingSwaps, gaps, published, upcomingLeave] = await Promise.all([
      db.query('SELECT COUNT(*)::int AS n FROM members WHERE active = true').then((r) => r.rows[0].n),
      db.query('SELECT COUNT(*)::int AS n FROM projects WHERE active = true').then((r) => r.rows[0].n),
      db.query(`SELECT COUNT(*)::int AS n FROM leave_requests WHERE status = 'pending'`).then((r) => r.rows[0].n),
      db.query(`SELECT COUNT(*)::int AS n FROM swap_requests WHERE status = 'pending'`).then((r) => r.rows[0].n),
      db
        .query('SELECT COUNT(*)::int AS n FROM shift_slots WHERE week_start = $1 AND assignee_id IS NULL', [weekStart])
        .then((r) => r.rows[0].n),
      db
        .query(`SELECT COUNT(*)::int AS n FROM shift_slots WHERE week_start = $1 AND status = 'published'`, [weekStart])
        .then((r) => r.rows[0].n),
      db
        .query(
          `SELECT l.*, m.name AS member_name FROM leave_requests l
           JOIN members m ON m.id = l.member_id
           WHERE l.status = 'approved' AND l.end_date >= $1
           ORDER BY l.start_date LIMIT 8`,
          [today]
        )
        .then((r) => r.rows)
    ]);

    return res.render('dashboard', {
      title: 'Dashboard',
      active: 'dashboard',
      canApprove: true,
      isAdmin: user.role === 'admin',
      weekStart,
      stats: { activeMembers, activeProjects, pendingLeave, pendingSwaps, gaps, published },
      upcomingLeave
    });
  }

  const [myShifts, myLeave, incomingSwaps] = await Promise.all([
    db
      .query(
        `SELECT s.*, p.name AS project_name FROM shift_slots s
         LEFT JOIN projects p ON p.id = s.project_id
         WHERE s.assignee_id = $1 AND s.status = 'published' AND s.slot_date >= $2
         ORDER BY s.slot_date, s.start_time LIMIT 10`,
        [user.member_id, today]
      )
      .then((r) => r.rows),
    db
      .query('SELECT * FROM leave_requests WHERE member_id = $1 ORDER BY start_date DESC LIMIT 6', [user.member_id])
      .then((r) => r.rows),
    db
      .query(
        `SELECT sw.*, s.slot_date, s.kind, p.name AS project_name, fm.name AS from_name
         FROM swap_requests sw
         LEFT JOIN shift_slots s ON s.id = sw.shift_slot_id
         LEFT JOIN projects p ON p.id = s.project_id
         LEFT JOIN members fm ON fm.id = sw.from_member_id
         WHERE sw.status = 'pending' AND (sw.to_member_id = $1 OR sw.to_member_id IS NULL) AND sw.from_member_id != $1
         ORDER BY sw.created_at DESC`,
        [user.member_id]
      )
      .then((r) => r.rows)
  ]);

  res.render('dashboard', {
    title: 'Dashboard',
    active: 'dashboard',
    canApprove: false,
    weekStart,
    myShifts,
    myLeave,
    incomingSwaps,
    KIND_LABELS
  });
});

module.exports = router;
