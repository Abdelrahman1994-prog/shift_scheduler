const dayjs = require('dayjs');
const db = require('./db');
const settings = require('./settings');

const KIND_LABELS = { day: 'Day', oncall: 'On-call', night: 'Overnight' };
const AFTERHOURS_KINDS = new Set(['oncall', 'night']);

function addDays(dateStr, n) {
  return dayjs(dateStr).add(n, 'day').format('YYYY-MM-DD');
}

function weekDates(weekStart) {
  return Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
}

// Egypt's weekend is Friday/Saturday (work week runs Sun–Thu), so those two
// days don't count against a leave balance — counts inclusive of both ends.
function countBusinessDays(startDate, endDate) {
  let count = 0;
  let d = dayjs(startDate);
  const end = dayjs(endDate);
  while (!d.isAfter(end)) {
    const dow = d.day(); // 0 = Sunday .. 6 = Saturday
    if (dow !== 5 && dow !== 6) count++;
    d = d.add(1, 'day');
  }
  return count;
}

// Monday-based week start containing the given date (defaults to today).
function weekStartFor(date) {
  const d = dayjs(date);
  const dow = d.day(); // 0 = Sunday .. 6 = Saturday
  const back = dow === 0 ? 6 : dow - 1;
  return d.subtract(back, 'day').format('YYYY-MM-DD');
}

// "HH:mm" comparisons elsewhere (crosses_midnight, rest-window checks) rely
// on zero-padded, lexicographically-sortable strings — a manually-typed
// "9:00" would otherwise sort after "17:00" and look like it crosses
// midnight when it doesn't.
function normalizeTime(t) {
  const m = /^(\d{1,2}):(\d{2})$/.exec((t || '').trim());
  return m ? `${m[1].padStart(2, '0')}:${m[2]}` : t;
}

function slotTimesFor(kind, cfg) {
  if (kind === 'day') {
    return { start_time: cfg.day_start, end_time: cfg.day_end, crosses_midnight: false };
  }
  if (kind === 'oncall') {
    return { start_time: cfg.oncall_start, end_time: cfg.oncall_end, crosses_midnight: cfg.oncall_end <= cfg.oncall_start };
  }
  // night
  return { start_time: cfg.night_start, end_time: cfg.night_end, crosses_midnight: cfg.night_end <= cfg.night_start };
}

function slotWindow(slot) {
  const start = dayjs(`${slot.slot_date}T${slot.start_time}:00`);
  let end = dayjs(`${slot.slot_date}T${slot.end_time}:00`);
  if (slot.crosses_midnight) end = end.add(1, 'day');
  return { start, end };
}

function bucketFor(kind) {
  return AFTERHOURS_KINDS.has(kind) ? 'afterhours' : 'day';
}

// Two windows conflict if they overlap, or if the gap between them is
// smaller than the required rest window (checked in both directions).
function violatesRest(windowA, windowB, restHours) {
  const overlap = windowA.start.isBefore(windowB.end) && windowB.start.isBefore(windowA.end);
  if (overlap) return true;
  const gapAfterA = windowB.start.diff(windowA.end, 'hour', true);
  const gapAfterB = windowA.start.diff(windowB.end, 'hour', true);
  if (gapAfterA >= 0 && gapAfterA < restHours) return true;
  if (gapAfterB >= 0 && gapAfterB < restHours) return true;
  return false;
}

// --- data access — every helper takes an optional `executor` (the pool, or
// a checked-out transaction client) so callers that need to see their own
// uncommitted writes (e.g. createManualSlot's validity check) can thread
// the same client through instead of going via a second connection. ---

async function loadActiveMembersByProject(executor = db.pool) {
  const { rows } = await executor.query(`
    SELECT m.*, mp.project_id AS mp_project_id
    FROM member_projects mp
    JOIN members m ON m.id = mp.member_id
    WHERE m.active = true
  `);
  const map = {};
  for (const m of rows) {
    if (!map[m.mp_project_id]) map[m.mp_project_id] = [];
    map[m.mp_project_id].push(m);
  }
  return map;
}

async function loadApprovedLeave(weekStart, weekEnd, executor = db.pool) {
  const { rows } = await executor.query(
    `SELECT * FROM leave_requests WHERE status = 'approved' AND start_date <= $2 AND end_date >= $1`,
    [weekStart, weekEnd]
  );
  const map = {};
  for (const r of rows) {
    if (!map[r.member_id]) map[r.member_id] = [];
    map[r.member_id].push(r);
  }
  return map;
}

function isOnLeave(memberId, date, leaveMap) {
  const rows = leaveMap[memberId] || [];
  return rows.some((r) => date >= r.start_date && date <= r.end_date);
}

// Egyptian public holidays (see src/egypt-holidays.js). Day shifts are
// skipped on a holiday — on-call/overnight still run since support
// continuity doesn't stop for a public holiday.
async function loadHolidayMap(startDate, endDate, executor = db.pool) {
  const { rows } = await executor.query('SELECT date, name FROM holidays WHERE date >= $1 AND date <= $2', [
    startDate,
    endDate
  ]);
  const map = {};
  for (const h of rows) map[h.date] = h.name;
  return map;
}

async function loadHistory(weekStart, windowWeeks, executor = db.pool) {
  const since = addDays(weekStart, -7 * windowWeeks);
  const { rows } = await executor.query(
    `SELECT assignee_id, kind FROM shift_slots
     WHERE status = 'published' AND assignee_id IS NOT NULL AND slot_date >= $1 AND slot_date < $2`,
    [since, weekStart]
  );
  const counts = {};
  for (const row of rows) {
    const bucket = bucketFor(row.kind);
    if (!counts[row.assignee_id]) counts[row.assignee_id] = { day: 0, afterhours: 0 };
    counts[row.assignee_id][bucket]++;
  }
  return counts;
}

async function loadBoundaryWindows(weekStart, executor = db.pool) {
  // Published slots the day before the week starts, so a Sunday-night
  // shift correctly blocks a Monday-morning assignment for the same person.
  const prevDay = addDays(weekStart, -1);
  const { rows } = await executor.query(
    `SELECT * FROM shift_slots WHERE status = 'published' AND assignee_id IS NOT NULL AND slot_date = $1`,
    [prevDay]
  );
  const map = {};
  for (const row of rows) {
    if (!map[row.assignee_id]) map[row.assignee_id] = [];
    map[row.assignee_id].push(slotWindow(row));
  }
  return map;
}

function eligibleCandidates({ projectMembers, kind, date, leaveMap, assignedWindows, cfg, times }) {
  const restHours = Number(cfg.rest_hours);
  const candidateWindow = slotWindow({ slot_date: date, ...times });
  return projectMembers.filter((m) => {
    if (kind === 'oncall' && !m.can_oncall) return false;
    if (kind === 'night' && !m.can_overnight) return false;
    if (isOnLeave(m.id, date, leaveMap)) return false;
    const existing = assignedWindows[m.id] || [];
    for (const w of existing) {
      if (violatesRest(candidateWindow, w, restHours)) return false;
    }
    return true;
  });
}

function pickByFairness(candidates, historyCounts, runCounts, bucket) {
  const scored = candidates.map((m) => {
    const hist = (historyCounts[m.id] && historyCounts[m.id][bucket]) || 0;
    const run = (runCounts[m.id] && runCounts[m.id][bucket]) || 0;
    return { member: m, score: hist + run };
  });
  scored.sort((a, b) => {
    if (a.score !== b.score) return a.score - b.score;
    return a.member.name.localeCompare(b.member.name);
  });
  return scored[0].member;
}

async function insertSlot(executor, row) {
  const { rows } = await executor.query(
    `INSERT INTO shift_slots
       (project_id, kind, slot_date, start_time, end_time, crosses_midnight, assignee_id, week_start, status, note, handover_note, handover_updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'draft',$9,NULL,NULL)
     RETURNING *`,
    [
      row.project_id,
      row.kind,
      row.slot_date,
      row.start_time,
      row.end_time,
      !!row.crosses_midnight,
      row.assignee_id != null ? row.assignee_id : null,
      row.week_start,
      row.note != null ? row.note : null
    ]
  );
  return rows[0];
}

async function generateWeek(weekStart) {
  const cfg = await settings.getAll();
  const dates = weekDates(weekStart);
  const weekEnd = dates[6];
  const [membersByProject, leaveMap, holidayMap, historyCounts, assignedWindows, projects] = await Promise.all([
    loadActiveMembersByProject(),
    loadApprovedLeave(weekStart, weekEnd),
    loadHolidayMap(weekStart, weekEnd),
    loadHistory(weekStart, Number(cfg.fairness_window_weeks)),
    loadBoundaryWindows(weekStart),
    db.query('SELECT * FROM projects WHERE active = true ORDER BY id').then((r) => r.rows)
  ]);
  const runCounts = {};

  const created = [];
  const gaps = [];

  await db.withTransaction(async (client) => {
    // Clear any previous draft for this week so re-generating is idempotent.
    await client.query(`DELETE FROM shift_slots WHERE week_start = $1 AND status = 'draft'`, [weekStart]);

    for (const project of projects) {
      const coverageDays = new Set(project.coverage_days.split(',').map(Number));
      const projectMembers = membersByProject[project.id] || [];

      for (const date of dates) {
        const dow = dayjs(date).day();
        const kinds = [];
        if (coverageDays.has(dow) && !holidayMap[date]) {
          for (let i = 0; i < project.min_staff_day; i++) kinds.push('day');
        }
        if (project.needs_oncall) kinds.push('oncall');
        if (project.needs_overnight) kinds.push('night');

        for (const kind of kinds) {
          const times = slotTimesFor(kind, cfg);
          const candidates = eligibleCandidates({
            projectMembers,
            kind,
            date,
            leaveMap,
            assignedWindows,
            cfg,
            times
          });

          if (candidates.length === 0) {
            const reason =
              projectMembers.length === 0
                ? 'No members are assigned to this project'
                : 'No eligible member is available (leave, eligibility, or rest window rules exclude everyone)';
            const gapRow = await insertSlot(client, {
              project_id: project.id,
              kind,
              slot_date: date,
              start_time: times.start_time,
              end_time: times.end_time,
              crosses_midnight: times.crosses_midnight,
              assignee_id: null,
              week_start: weekStart,
              note: reason
            });
            gaps.push({ id: gapRow.id, project_name: project.name, kind, date, reason });
            continue;
          }

          const bucket = bucketFor(kind);
          const picked = pickByFairness(candidates, historyCounts, runCounts, bucket);

          const row = await insertSlot(client, {
            project_id: project.id,
            kind,
            slot_date: date,
            start_time: times.start_time,
            end_time: times.end_time,
            crosses_midnight: times.crosses_midnight,
            assignee_id: picked.id,
            week_start: weekStart,
            note: null
          });
          row.project_name = project.name;
          row.assignee_name = picked.name;
          created.push(row);

          if (!runCounts[picked.id]) runCounts[picked.id] = { day: 0, afterhours: 0 };
          runCounts[picked.id][bucket]++;
          if (!assignedWindows[picked.id]) assignedWindows[picked.id] = [];
          assignedWindows[picked.id].push(slotWindow(row));
        }
      }
    }
  });

  return { created, gaps };
}

async function publishWeek(weekStart) {
  const { rowCount } = await db.query(`UPDATE shift_slots SET status = 'published' WHERE week_start = $1 AND status = 'draft'`, [
    weekStart
  ]);
  return rowCount;
}

async function listWeek(weekStart) {
  const { rows } = await db.query(
    `SELECT s.*, p.name AS project_name, m.name AS assignee_name
     FROM shift_slots s
     LEFT JOIN projects p ON p.id = s.project_id
     LEFT JOIN members m ON m.id = s.assignee_id
     WHERE s.week_start = $1
     ORDER BY s.slot_date, p.name, s.kind`,
    [weekStart]
  );
  return rows;
}

// Used by manual overrides and swap acceptance to keep the rules honest
// outside of the automated generation pass. `executor` lets callers that
// already hold a transaction client (e.g. createManualSlot, checking a slot
// it just inserted but hasn't committed yet) see their own uncommitted writes.
async function checkAssignmentValidity(memberId, slotId, executor = db.pool) {
  const { rows: slotRows } = await executor.query('SELECT * FROM shift_slots WHERE id = $1', [slotId]);
  const slot = slotRows[0];
  if (!slot) return { ok: false, reason: 'Shift not found' };

  const { rows: memberRows } = await executor.query('SELECT * FROM members WHERE id = $1', [memberId]);
  const member = memberRows[0];
  if (!member || !member.active) return { ok: false, reason: 'Member is not active' };

  const { rows: mpRows } = await executor.query(
    'SELECT 1 FROM member_projects WHERE member_id = $1 AND project_id = $2',
    [memberId, slot.project_id]
  );
  if (mpRows.length === 0) return { ok: false, reason: `${member.name} is not assigned to this project` };

  if (slot.kind === 'oncall' && !member.can_oncall) {
    return { ok: false, reason: `${member.name} is not marked eligible for on-call` };
  }
  if (slot.kind === 'night' && !member.can_overnight) {
    return { ok: false, reason: `${member.name} is not marked eligible for overnight shifts` };
  }

  const cfg = await settings.getAll();
  const weekEnd = addDays(slot.week_start, 6);
  const leaveMap = await loadApprovedLeave(slot.week_start, weekEnd, executor);
  if (isOnLeave(memberId, slot.slot_date, leaveMap)) {
    return { ok: false, reason: `${member.name} has approved leave that day` };
  }

  const lo = addDays(slot.slot_date, -2);
  const hi = addDays(slot.slot_date, 2);
  const { rows: otherSlots } = await executor.query(
    `SELECT * FROM shift_slots
     WHERE assignee_id = $1 AND id != $2 AND status IN ('draft', 'published') AND slot_date >= $3 AND slot_date <= $4`,
    [memberId, slotId, lo, hi]
  );

  const candidateWindow = slotWindow(slot);
  const restHours = Number(cfg.rest_hours);
  for (const other of otherSlots) {
    if (violatesRest(candidateWindow, slotWindow(other), restHours)) {
      return {
        ok: false,
        reason: `${member.name} would not get the required ${restHours}h rest around their ${KIND_LABELS[other.kind]} shift on ${other.slot_date}`
      };
    }
  }

  return { ok: true };
}

// Manual counterpart to generateWeek — inserts a single slot the admin
// specified by hand instead of picking one via the fairness algorithm.
// Times default from settings when left blank. If an assignee is given but
// fails validity checks, the slot is still created (unfilled) with a note
// explaining why, mirroring how generateWeek() records gaps.
async function createManualSlot({ project_id, kind, slot_date, start_time, end_time, assignee_id, week_start }) {
  const cfg = await settings.getAll();
  const defaults = slotTimesFor(kind, cfg);
  const start = normalizeTime(start_time) || defaults.start_time;
  const end = normalizeTime(end_time) || defaults.end_time;
  const crossesMidnight = end <= start;

  return db.withTransaction(async (client) => {
    const row = await insertSlot(client, {
      project_id,
      kind,
      slot_date,
      start_time: start,
      end_time: end,
      crosses_midnight: crossesMidnight,
      assignee_id: null,
      week_start,
      note: null
    });

    let warning = null;
    if (assignee_id) {
      const check = await checkAssignmentValidity(assignee_id, row.id, client);
      if (!check.ok) {
        await client.query('UPDATE shift_slots SET note = $2 WHERE id = $1', [row.id, check.reason]);
        warning = check.reason;
      } else {
        await client.query('UPDATE shift_slots SET assignee_id = $2 WHERE id = $1', [row.id, assignee_id]);
      }
    }

    return { id: row.id, warning };
  });
}

// Replicates one slot's project/kind/times/assignee onto every other
// weekday (Sun–Thu — Egypt's work week) in the same week. A weekday that
// already has a slot for the same project + kind is left alone rather than
// getting a second, so clicking this more than once doesn't pile up
// duplicates. Runs each new slot through the same eligibility check as a
// manual add, so leave/rest conflicts still show up as unfilled + a note
// instead of silently double-booking someone.
async function copySlotToWeekdays(slotId) {
  const { rows } = await db.query('SELECT * FROM shift_slots WHERE id = $1', [slotId]);
  const source = rows[0];
  if (!source) return { copied: 0, skipped: 0, warnings: [] };

  const targetDates = weekDates(source.week_start).filter((d) => {
    const dow = dayjs(d).day();
    return dow !== 5 && dow !== 6 && d !== source.slot_date;
  });

  let copied = 0;
  let skipped = 0;
  const warnings = [];

  for (const date of targetDates) {
    const { rows: existing } = await db.query(
      'SELECT 1 FROM shift_slots WHERE project_id = $1 AND kind = $2 AND slot_date = $3',
      [source.project_id, source.kind, date]
    );
    if (existing.length > 0) {
      skipped++;
      continue;
    }

    const { warning } = await createManualSlot({
      project_id: source.project_id,
      kind: source.kind,
      slot_date: date,
      start_time: source.start_time,
      end_time: source.end_time,
      assignee_id: source.assignee_id,
      week_start: source.week_start
    });
    copied++;
    if (warning) warnings.push(`${date}: ${warning}`);
  }

  return { copied, skipped, warnings };
}

// Removing a slot also removes any swap requests tied to it via
// shift_slots -> swap_requests ON DELETE CASCADE.
async function deleteSlot(slotId) {
  await db.query('DELETE FROM shift_slots WHERE id = $1', [slotId]);
}

// Clears every draft slot for a week without generating a new one — the
// undo for "Generate draft" when you'd rather start from a blank week.
// Published slots are never touched.
async function deleteDraft(weekStart) {
  const { rowCount } = await db.query(`DELETE FROM shift_slots WHERE week_start = $1 AND status = 'draft'`, [weekStart]);
  return rowCount;
}

// Clears every slot for a week — draft AND published. Unlike deleteDraft(),
// this also removes already-published (potentially communicated) shifts, so
// it's a separate, more deliberate action from the route/UI side.
async function deleteWeek(weekStart) {
  const { rowCount } = await db.query('DELETE FROM shift_slots WHERE week_start = $1', [weekStart]);
  return rowCount;
}

const ASSIGNEE_JOIN = `
  LEFT JOIN members m ON m.id = s.assignee_id
  JOIN projects p ON p.id = s.project_id
`;
const ASSIGNEE_FIELDS = `
  s.*, p.name AS project_name,
  m.name AS assignee_name, m.email AS assignee_email, m.profile_phone AS assignee_phone, m.slack_id AS assignee_slack_id
`;

// One row per project x shift-kind that's live right now: the on-call and
// overnight rows always show (a missing one is exactly the gap an
// escalation page needs to surface), the day row only shows while a day
// shift is actually running.
async function currentStatus(now) {
  const ref = now || dayjs();
  const today = ref.format('YYYY-MM-DD');
  const yesterday = addDays(today, -1);

  const { rows: candidates } = await db.query(
    `SELECT ${ASSIGNEE_FIELDS} FROM shift_slots s ${ASSIGNEE_JOIN}
     WHERE s.status = 'published' AND (s.slot_date = $1 OR s.slot_date = $2)`,
    [today, yesterday]
  );

  const activeByKey = {};
  for (const s of candidates) {
    const { start, end } = slotWindow(s);
    if (!ref.isBefore(start) && ref.isBefore(end)) {
      activeByKey[`${s.project_id}:${s.kind}`] = s;
    }
  }

  const { rows: projects } = await db.query('SELECT * FROM projects WHERE active = true ORDER BY name');
  const rows = [];
  for (const project of projects) {
    for (const kind of ['day', 'oncall', 'night']) {
      const needs = kind === 'day' ? true : kind === 'oncall' ? project.needs_oncall : project.needs_overnight;
      if (!needs) continue;
      const slot = activeByKey[`${project.id}:${kind}`] || null;
      if (kind === 'day' && !slot) continue;
      rows.push({ project_id: project.id, project_name: project.name, kind, slot });
    }
  }
  return rows;
}

// Published shifts that ended within the last `hours`, most recently ended
// first — the window where a handover note is most likely to still need
// writing, and where the next person on would look for one.
async function recentHandoffs(now, hours = 48, limit = 20) {
  const ref = now || dayjs();
  const since = ref.subtract(hours, 'hour');
  const today = ref.format('YYYY-MM-DD');
  const startDate = addDays(today, -3);

  const { rows: candidates } = await db.query(
    `SELECT ${ASSIGNEE_FIELDS} FROM shift_slots s ${ASSIGNEE_JOIN}
     WHERE s.status = 'published' AND s.slot_date >= $1 AND s.slot_date <= $2`,
    [startDate, today]
  );

  return candidates
    .map((s) => ({ slot: s, window: slotWindow(s) }))
    .filter((x) => x.window.end.isAfter(since) && !x.window.end.isAfter(ref))
    .sort((a, b) => b.window.end.valueOf() - a.window.end.valueOf())
    .slice(0, limit)
    .map((x) => ({ ...x.slot, ended_at: x.window.end.format('MMM D, HH:mm') }));
}

async function setHandoverNote(slotId, note) {
  const value = note || null;
  const { rows } = await db.query(
    'UPDATE shift_slots SET handover_note = $2, handover_updated_at = $3 WHERE id = $1 RETURNING *',
    [slotId, value, value ? new Date().toISOString() : null]
  );
  return rows[0] || null;
}

module.exports = {
  KIND_LABELS,
  weekDates,
  weekStartFor,
  generateWeek,
  publishWeek,
  listWeek,
  checkAssignmentValidity,
  createManualSlot,
  copySlotToWeekdays,
  deleteSlot,
  deleteDraft,
  deleteWeek,
  loadHolidayMap,
  countBusinessDays,
  addDays,
  currentStatus,
  recentHandoffs,
  setHandoverNote
};
