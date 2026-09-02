const express = require('express');
const dayjs = require('dayjs');
const db = require('../db');
const settings = require('../settings');
const scheduler = require('../scheduler');
const { requireApprover } = require('../middleware/auth');

const router = express.Router();

// Preset reasons shown in the "Reason" dropdown on the request form —
// covers common leave categories beyond the broad vacation/sick/personal
// Type field. "Other" reveals a free-text field so nothing is unrepresentable.
const LEAVE_REASONS = [
  'Annual Vacation',
  'Sick Leave',
  'Casual / Personal Leave',
  'Emergency Leave',
  'Medical Appointment',
  'Maternity Leave',
  'Paternity Leave',
  'Marriage Leave',
  'Bereavement Leave',
  'Hajj / Umrah Leave',
  'Study Leave',
  'Unpaid Leave'
];

function daysInMonth(monthStr) {
  const start = dayjs(monthStr + '-01');
  const count = start.daysInMonth();
  return Array.from({ length: count }, (_, i) => start.date(i + 1).format('YYYY-MM-DD'));
}

const WITH_MEMBER_NAME = `SELECT l.*, m.name AS member_name FROM leave_requests l JOIN members m ON m.id = l.member_id`;

router.get('/leave', async (req, res) => {
  const user = req.session.user;
  const canApprove = user.role === 'admin' || user.role === 'lead';
  const month = /^\d{4}-\d{2}$/.test(req.query.month || '') ? req.query.month : dayjs().format('YYYY-MM');
  const monthDates = daysInMonth(month);
  const monthStart = monthDates[0];
  const monthEnd = monthDates[monthDates.length - 1];

  const [members, requestsInMonth, holidayMap] = await Promise.all([
    db.query('SELECT * FROM members WHERE active = true ORDER BY name').then((r) => r.rows),
    db
      .query(
        `${WITH_MEMBER_NAME} WHERE (l.status = 'approved' OR l.status = 'pending') AND l.start_date <= $2 AND l.end_date >= $1
         ORDER BY l.start_date`,
        [monthStart, monthEnd]
      )
      .then((r) => r.rows),
    scheduler.loadHolidayMap(monthStart, monthEnd)
  ]);

  // Day-of-month header metadata (weekend/holiday shading) and today's
  // position, for the timeline board below.
  const dayMeta = monthDates.map((d) => ({
    day: Number(d.slice(8, 10)),
    isWeekend: [5, 6].includes(dayjs(d).day()),
    holiday: holidayMap[d] || null
  }));
  const todayStr = dayjs().format('YYYY-MM-DD');
  const todayDay = monthDates.includes(todayStr) ? Number(todayStr.slice(8, 10)) : null;

  // One row per member, each with one bar per request that overlaps this
  // month — clipped to the visible range, with a flag when the real request
  // extends past what's shown so the bar can indicate it continues.
  const timelineRows = members.map((m) => {
    const bars = requestsInMonth
      .filter((r) => r.member_id === m.id)
      .map((r) => {
        const clipStart = r.start_date < monthStart ? monthStart : r.start_date;
        const clipEnd = r.end_date > monthEnd ? monthEnd : r.end_date;
        return {
          type: r.type,
          status: r.status,
          startDay: Number(clipStart.slice(8, 10)),
          endDay: Number(clipEnd.slice(8, 10)),
          continuesBefore: r.start_date < monthStart,
          continuesAfter: r.end_date > monthEnd,
          rangeLabel: `${dayjs(r.start_date).format('D MMM')} – ${dayjs(r.end_date).format('D MMM')}`
        };
      });
    const total = bars.reduce((sum, b) => sum + (b.endDay - b.startDay + 1), 0);
    return { member: m, bars, total };
  });

  const [myRequests, pending, vacationPlanRows] = await Promise.all([
    db
      .query(`${WITH_MEMBER_NAME} WHERE l.member_id = $1 ORDER BY l.created_at DESC LIMIT 20`, [user.member_id || 0])
      .then((r) => r.rows),
    canApprove
      ? db.query(`${WITH_MEMBER_NAME} WHERE l.status = 'pending' ORDER BY l.created_at ASC`).then((r) => r.rows)
      : Promise.resolve([]),
    db
      .query(
        `${WITH_MEMBER_NAME} WHERE (l.status = 'approved' OR l.status = 'pending') AND l.end_date >= $1
         ORDER BY l.start_date LIMIT 100`,
        [dayjs().format('YYYY-MM-DD')]
      )
      .then((r) => r.rows)
  ]);
  const vacationPlan = vacationPlanRows.map((r) => ({ ...r, days: scheduler.countBusinessDays(r.start_date, r.end_date) }));

  res.render('leave', {
    title: 'Vacation & leave',
    active: 'leave',
    canApprove,
    members,
    monthDates,
    month,
    prevMonth: dayjs(monthStart).subtract(1, 'month').format('YYYY-MM'),
    nextMonth: dayjs(monthStart).add(1, 'month').format('YYYY-MM'),
    dayMeta,
    todayDay,
    timelineRows,
    myRequests,
    pending,
    vacationPlan,
    leaveReasons: LEAVE_REASONS
  });
});

// Per-employee annual leave balance — a flat month-by-month record of
// approved leave against a starting entitlement, similar in shape to the
// spreadsheet balance sheets HR teams already keep.
router.get('/leave/balance', async (req, res) => {
  const user = req.session.user;
  const canApprove = user.role === 'admin' || user.role === 'lead';

  const members = await db.query('SELECT * FROM members WHERE active = true ORDER BY name').then((r) => r.rows);

  let memberId = user.member_id;
  if (canApprove && req.query.member_id) memberId = Number(req.query.member_id);
  const member = memberId ? members.find((m) => m.id === memberId) || (await db.query('SELECT * FROM members WHERE id = $1', [memberId]).then((r) => r.rows[0])) : null;

  if (!member) {
    req.session.flash = { type: 'error', message: 'Select a member to view their leave balance.' };
    return res.redirect('/leave');
  }
  if (!canApprove && memberId !== user.member_id) {
    return res.status(403).render('error', { message: 'You can only view your own leave balance.' });
  }

  const year = /^\d{4}$/.test(req.query.year || '') ? Number(req.query.year) : dayjs().year();
  const yearStr = String(year);

  const { rows: requests } = await db.query(
    `SELECT * FROM leave_requests WHERE member_id = $1 AND status = 'approved' AND start_date LIKE $2 ORDER BY start_date`,
    [memberId, `${yearStr}-%`]
  );

  const months = Array.from({ length: 12 }, (_, i) => {
    const monthNum = i + 1;
    const periods = requests
      .filter((r) => dayjs(r.start_date).month() + 1 === monthNum)
      .map((r) => ({
        ...r,
        days: scheduler.countBusinessDays(r.start_date, r.end_date),
        fromLabel: dayjs(r.start_date).format('D-MMM'),
        toLabel: dayjs(r.end_date).format('D-MMM')
      }));
    return {
      label: dayjs(`${year}-${String(monthNum).padStart(2, '0')}-01`).format('MMMM YYYY'),
      periods,
      total: periods.reduce((sum, p) => sum + p.days, 0)
    };
  });

  const grandTotal = months.reduce((sum, m) => sum + m.total, 0);
  const startingBalance =
    member.annual_leave_days != null ? member.annual_leave_days : Number(await settings.get('default_annual_leave_days', '21'));

  res.render('leave_balance', {
    title: 'Leave balance',
    active: 'leave',
    canApprove,
    members,
    member,
    year,
    prevYear: year - 1,
    nextYear: year + 1,
    months,
    grandTotal,
    startingBalance,
    remaining: startingBalance - grandTotal
  });
});

router.post('/leave', async (req, res) => {
  const user = req.session.user;
  const canApprove = user.role === 'admin' || user.role === 'lead';
  const { start_date, end_date, type, reason } = req.body;
  const memberId = canApprove && req.body.member_id ? Number(req.body.member_id) : user.member_id;
  const resolvedReason = reason === 'Other' ? (req.body.reason_other || '').trim() || 'Other' : reason;

  if (!memberId) {
    req.session.flash = { type: 'error', message: 'Select which member this request is for.' };
    return res.redirect('/leave');
  }
  if (!start_date || !end_date || end_date < start_date) {
    req.session.flash = { type: 'error', message: 'Enter a valid date range.' };
    return res.redirect('/leave');
  }

  await db.query(
    `INSERT INTO leave_requests (member_id, start_date, end_date, type, reason, status, created_at, decided_by, decided_at)
     VALUES ($1, $2, $3, $4, $5, 'pending', $6, NULL, NULL)`,
    [
      memberId,
      start_date,
      end_date,
      ['vacation', 'sick', 'personal'].includes(type) ? type : 'vacation',
      (resolvedReason || '').trim() || null,
      new Date().toISOString()
    ]
  );

  req.session.flash = { type: 'success', message: 'Leave request submitted for approval.' };
  res.redirect('/leave');
});

router.post('/leave/:id/approve', requireApprover, async (req, res) => {
  await db.query(
    `UPDATE leave_requests SET status = 'approved', decided_by = $2, decided_at = $3 WHERE id = $1`,
    [Number(req.params.id), req.session.user.id, new Date().toISOString()]
  );
  req.session.flash = { type: 'success', message: 'Leave request approved.' };
  res.redirect('/leave');
});

router.post('/leave/:id/reject', requireApprover, async (req, res) => {
  await db.query(
    `UPDATE leave_requests SET status = 'rejected', decided_by = $2, decided_at = $3 WHERE id = $1`,
    [Number(req.params.id), req.session.user.id, new Date().toISOString()]
  );
  req.session.flash = { type: 'info', message: 'Leave request rejected.' };
  res.redirect('/leave');
});

router.post('/leave/:id/cancel', async (req, res) => {
  const user = req.session.user;
  const { rows } = await db.query('SELECT * FROM leave_requests WHERE id = $1', [Number(req.params.id)]);
  const request = rows[0];
  if (!request) return res.redirect('/leave');
  const owns = request.member_id === user.member_id;
  if (!owns && user.role !== 'admin' && user.role !== 'lead') {
    return res.status(403).render('error', { message: 'You can only cancel your own leave requests.' });
  }
  await db.query(`UPDATE leave_requests SET status = 'cancelled' WHERE id = $1`, [request.id]);
  req.session.flash = { type: 'info', message: 'Leave request cancelled.' };
  res.redirect('/leave');
});

module.exports = router;
