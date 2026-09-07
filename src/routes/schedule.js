const express = require('express');
const dayjs = require('dayjs');
const db = require('../db');
const { requireAdmin } = require('../middleware/auth');
const scheduler = require('../scheduler');
const notify = require('../notify');
const settings = require('../settings');

const router = express.Router();

function buildGrid(slots, dates) {
  const projectIds = [...new Set(slots.map((s) => s.project_id))];
  const projectMap = {};
  for (const s of slots) {
    if (!projectMap[s.project_id]) projectMap[s.project_id] = { id: s.project_id, name: s.project_name };
  }

  const grid = {}; // project_id -> date -> [slots]
  for (const s of slots) {
    if (!grid[s.project_id]) grid[s.project_id] = {};
    if (!grid[s.project_id][s.slot_date]) grid[s.project_id][s.slot_date] = [];
    grid[s.project_id][s.slot_date].push(s);
  }

  return projectIds.map((pid) => ({
    project: projectMap[pid],
    days: dates.map((d) => grid[pid][d] || [])
  }));
}

router.get('/schedule', async (req, res) => {
  const weekStart = /^\d{4}-\d{2}-\d{2}$/.test(req.query.week || '') ? req.query.week : scheduler.weekStartFor();
  const dates = scheduler.weekDates(weekStart);
  // Egypt's weekend is Friday/Saturday — same rule used everywhere else
  // (leave-day counting, the leave board) — so the grid can tint those
  // columns and label each header with its day name.
  const dateMeta = dates.map((d) => {
    const dow = dayjs(d).day();
    return { date: d, dayName: dayjs(d).format('ddd'), isWeekend: dow === 5 || dow === 6 };
  });
  const slots = await scheduler.listWeek(weekStart);
  const gapCount = slots.filter((s) => !s.assignee_id).length;
  const hasDraft = slots.some((s) => s.status === 'draft');
  const hasPublished = slots.some((s) => s.status === 'published');
  const kindCounts = { day: 0, oncall: 0, night: 0 };
  for (const s of slots) kindCounts[s.kind]++;

  const isAdmin = req.session.user.role === 'admin';
  const [allMembers, activeProjects, holidayMap, cfg] = await Promise.all([
    isAdmin ? db.query('SELECT * FROM members WHERE active = true ORDER BY name').then((r) => r.rows) : Promise.resolve([]),
    isAdmin ? db.query('SELECT * FROM projects WHERE active = true ORDER BY name').then((r) => r.rows) : Promise.resolve([]),
    scheduler.loadHolidayMap(dates[0], dates[6]),
    isAdmin ? settings.getAll() : Promise.resolve(null)
  ]);

  res.render('schedule', {
    title: 'Schedule',
    active: 'schedule',
    weekStart,
    dates,
    dateMeta,
    holidayMap,
    prevWeek: scheduler.addDays(weekStart, -7),
    nextWeek: scheduler.addDays(weekStart, 7),
    grid: buildGrid(slots, dates),
    gapCount,
    hasDraft,
    hasPublished,
    isEmpty: slots.length === 0,
    totalSlots: slots.length,
    filledSlots: slots.length - gapCount,
    kindCounts,
    allMembers,
    activeProjects,
    cfg,
    KIND_LABELS: scheduler.KIND_LABELS
  });
});

router.post('/schedule/generate', requireAdmin, async (req, res) => {
  const weekStart = req.body.week;
  const { created, gaps } = await scheduler.generateWeek(weekStart);
  req.session.flash = {
    type: gaps.length > 0 ? 'error' : 'success',
    message:
      gaps.length > 0
        ? `Draft generated: ${created.length} shifts filled, ${gaps.length} slot(s) could not be filled — review and assign manually below.`
        : `Draft generated: all ${created.length} shifts filled.`
  };
  res.redirect(`/schedule?week=${weekStart}`);
});

router.post('/schedule/delete-draft', requireAdmin, async (req, res) => {
  const weekStart = req.body.week;
  const removed = await scheduler.deleteDraft(weekStart);
  req.session.flash = {
    type: 'info',
    message: removed > 0 ? `Deleted ${removed} draft shift(s) for the week of ${weekStart}.` : 'No draft shifts to delete.'
  };
  res.redirect(`/schedule?week=${weekStart}`);
});

// Wipes every shift for the week — draft AND published. Gated by a typed
// confirmation since it can remove already-communicated shifts.
router.post('/schedule/delete-week', requireAdmin, async (req, res) => {
  const weekStart = req.body.week;
  if ((req.body.confirm_text || '').trim().toUpperCase() !== 'DELETE') {
    req.session.flash = { type: 'error', message: 'Type DELETE in the confirmation box to wipe the whole week.' };
    return res.redirect(`/schedule?week=${weekStart}`);
  }
  const removed = await scheduler.deleteWeek(weekStart);
  req.session.flash = {
    type: 'info',
    message:
      removed > 0
        ? `Deleted all ${removed} shift(s) for the week of ${weekStart}, including any published ones.`
        : 'No shifts to delete for this week.'
  };
  res.redirect(`/schedule?week=${weekStart}`);
});

router.post('/schedule/publish', requireAdmin, async (req, res) => {
  const weekStart = req.body.week;
  const changed = await scheduler.publishWeek(weekStart);
  const slots = await scheduler.listWeek(weekStart);
  const result = await notify.postWeeklySchedule(weekStart, slots).catch((err) => ({
    sent: false,
    reason: err.message
  }));

  const parts = [`Published ${changed} shift(s) for the week of ${weekStart}.`];
  if (result.sent) parts.push('Posted to Slack.');
  else if (result.reason) parts.push(`Slack post skipped: ${result.reason}`);

  req.session.flash = { type: 'success', message: parts.join(' ') };
  res.redirect(`/schedule?week=${weekStart}`);
});

router.post('/schedule/slot/:id/assign', requireAdmin, async (req, res) => {
  const slotId = Number(req.params.id);
  const weekStart = req.body.week;
  const assigneeId = req.body.assignee_id ? Number(req.body.assignee_id) : null;

  if (assigneeId) {
    const check = await scheduler.checkAssignmentValidity(assigneeId, slotId);
    if (!check.ok) {
      req.session.flash = { type: 'error', message: `Could not assign: ${check.reason}` };
      return res.redirect(`/schedule?week=${weekStart}`);
    }
  }

  const { rows } = await db.query('SELECT status FROM shift_slots WHERE id = $1', [slotId]);
  const wasPublished = rows[0] && rows[0].status === 'published';
  await db.query('UPDATE shift_slots SET assignee_id = $2, note = NULL WHERE id = $1', [slotId, assigneeId]);

  req.session.flash = {
    type: 'success',
    message: wasPublished ? 'Published shift reassigned.' : 'Shift updated.'
  };
  res.redirect(`/schedule?week=${weekStart}`);
});

router.post('/schedule/slot/create', requireAdmin, async (req, res) => {
  const weekStart = req.body.week;
  const projectId = Number(req.body.project_id);
  const kind = ['day', 'oncall', 'night'].includes(req.body.kind) ? req.body.kind : null;
  const slotDate = req.body.slot_date;
  const assigneeId = req.body.assignee_id ? Number(req.body.assignee_id) : null;

  const { rows: projectRows } = projectId
    ? await db.query('SELECT * FROM projects WHERE id = $1 AND active = true', [projectId])
    : { rows: [] };
  const project = projectRows[0] || null;
  const validDate = scheduler.weekDates(weekStart).includes(slotDate);

  if (!project || !kind || !validDate) {
    req.session.flash = { type: 'error', message: 'Pick a project, shift type, and a date within this week.' };
    return res.redirect(`/schedule?week=${weekStart}`);
  }

  const { warning } = await scheduler.createManualSlot({
    project_id: projectId,
    kind,
    slot_date: slotDate,
    start_time: (req.body.start_time || '').trim(),
    end_time: (req.body.end_time || '').trim(),
    assignee_id: assigneeId,
    week_start: weekStart
  });

  req.session.flash = warning
    ? { type: 'error', message: `Shift added, but left unfilled: ${warning}` }
    : { type: 'success', message: 'Shift added.' };
  res.redirect(`/schedule?week=${weekStart}`);
});

// Copies one slot's project/kind/times/assignee onto every other weekday
// (Sun–Thu) this week — a quick way to staff the rest of the week after
// adding or eyeballing one day by hand.
router.post('/schedule/slot/:id/copy-weekdays', requireAdmin, async (req, res) => {
  const weekStart = req.body.week;
  const slotId = Number(req.params.id);
  const { copied, skipped, warnings } = await scheduler.copySlotToWeekdays(slotId);

  const parts = [];
  if (copied === 0 && skipped === 0) {
    parts.push('Shift not found.');
  } else {
    parts.push(`Copied to ${copied} weekday${copied === 1 ? '' : 's'}.`);
    if (skipped > 0) parts.push(`${skipped} already had this assignee on this project/type and were left as-is.`);
    if (warnings.length > 0) parts.push(`${warnings.length} left unfilled — ${warnings.join('; ')}.`);
  }

  req.session.flash = { type: warnings.length > 0 ? 'error' : 'success', message: parts.join(' ') };
  res.redirect(`/schedule?week=${weekStart}`);
});

router.post('/schedule/slot/:id/delete', requireAdmin, async (req, res) => {
  const weekStart = req.body.week;
  const slotId = Number(req.params.id);
  const { rows } = await db.query('SELECT status FROM shift_slots WHERE id = $1', [slotId]);
  const wasPublished = rows[0] && rows[0].status === 'published';
  await scheduler.deleteSlot(slotId);
  req.session.flash = {
    type: 'info',
    message: wasPublished ? 'Published shift removed.' : 'Shift removed.'
  };
  res.redirect(`/schedule?week=${weekStart}`);
});

router.get('/schedule/export.csv', async (req, res) => {
  const weekStart = /^\d{4}-\d{2}-\d{2}$/.test(req.query.week || '') ? req.query.week : scheduler.weekStartFor();
  const slots = await scheduler.listWeek(weekStart);

  const header = 'Date,Project,Shift,Start,End,Assignee,Status\n';
  const rows = slots
    .map((s) =>
      [s.slot_date, s.project_name, scheduler.KIND_LABELS[s.kind], s.start_time, s.end_time, s.assignee_name || 'UNFILLED', s.status]
        .map((v) => `"${String(v).replace(/"/g, '""')}"`)
        .join(',')
    )
    .join('\n');

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="schedule-${weekStart}.csv"`);
  res.send(header + rows);
});

module.exports = router;
