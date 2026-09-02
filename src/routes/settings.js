const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const dayjs = require('dayjs');
const settings = require('../settings');
const db = require('../db');
const { requireAdmin } = require('../middleware/auth');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

const FIELDS = [
  'rest_hours',
  'fairness_window_weeks',
  'day_start',
  'day_end',
  'oncall_start',
  'oncall_end',
  'night_start',
  'night_end',
  'slack_webhook_url',
  'org_timezone',
  'default_annual_leave_days'
];

// Tables whose SERIAL sequence needs bumping past the max id after a
// restore inserts explicit ids.
const SEQUENCED_TABLES = ['members', 'member_history', 'users', 'projects', 'leave_requests', 'shift_slots', 'swap_requests', 'holidays'];

router.get('/settings', requireAdmin, async (req, res) => {
  const cutoff = dayjs().subtract(30, 'day').format('YYYY-MM-DD');
  const [cfg, holidays] = await Promise.all([
    settings.getAll(),
    db.query('SELECT * FROM holidays WHERE date >= $1 ORDER BY date', [cutoff]).then((r) => r.rows)
  ]);
  res.render('settings', { title: 'Settings', active: 'settings', cfg, holidays });
});

router.post('/settings', requireAdmin, async (req, res) => {
  for (const field of FIELDS) {
    if (req.body[field] !== undefined) await settings.set(field, req.body[field]);
  }
  req.session.flash = { type: 'success', message: 'Settings saved.' };
  res.redirect('/settings');
});

// Egypt's fixed-date national holidays are seeded automatically (see
// src/db.js + src/egypt-holidays.js). Moon-sighting-dependent ones (Eid
// al-Fitr, Eid al-Adha, Islamic New Year, Mawlid) and Sham El Nessim aren't
// — their date shifts every year and isn't safe to guess, so they're added
// here once officially announced.
router.post('/settings/holidays', requireAdmin, async (req, res) => {
  const date = req.body.date;
  const name = (req.body.name || '').trim();

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '') || !name) {
    req.session.flash = { type: 'error', message: 'Enter a valid date and a name for the holiday.' };
    return res.redirect('/settings');
  }

  const { rows: existing } = await db.query('SELECT id FROM holidays WHERE date = $1', [date]);
  if (existing.length) {
    await db.query('UPDATE holidays SET name = $2 WHERE id = $1', [existing[0].id, name]);
  } else {
    await db.query(`INSERT INTO holidays (date, name, source) VALUES ($1, $2, 'custom')`, [date, name]);
  }

  req.session.flash = { type: 'success', message: `${name} added as a holiday on ${date}.` };
  res.redirect('/settings');
});

router.post('/settings/holidays/:id/delete', requireAdmin, async (req, res) => {
  await db.query('DELETE FROM holidays WHERE id = $1', [Number(req.params.id)]);
  req.session.flash = { type: 'info', message: 'Holiday removed.' };
  res.redirect('/settings');
});

// Reassembles the whole store from every table into the same nested JSON
// shape the app has always backed up (members[] with a nested .profile
// object, .profile.history[] populated from member_history, etc.) — so a
// backup taken before or after the Postgres migration looks identical, and
// either can be restored.
async function assembleBackup() {
  const [members, memberHistory, users, projects, memberProjects, leaveRequests, shiftSlots, swapRequests, holidays, settingsRows] =
    await Promise.all([
      db.query('SELECT * FROM members ORDER BY id').then((r) => r.rows),
      db.query('SELECT * FROM member_history ORDER BY id').then((r) => r.rows),
      db.query('SELECT * FROM users ORDER BY id').then((r) => r.rows),
      db.query('SELECT * FROM projects ORDER BY id').then((r) => r.rows),
      db.query('SELECT * FROM member_projects').then((r) => r.rows),
      db.query('SELECT * FROM leave_requests ORDER BY id').then((r) => r.rows),
      db.query('SELECT * FROM shift_slots ORDER BY id').then((r) => r.rows),
      db.query('SELECT * FROM swap_requests ORDER BY id').then((r) => r.rows),
      db.query('SELECT * FROM holidays ORDER BY id').then((r) => r.rows),
      db.query('SELECT * FROM settings').then((r) => r.rows)
    ]);

  const historyByMember = {};
  for (const h of memberHistory) {
    if (!historyByMember[h.member_id]) historyByMember[h.member_id] = [];
    historyByMember[h.member_id].push({
      id: h.id,
      title: h.title,
      organization: h.organization,
      start: h.start_label,
      end: h.end_label,
      description: h.description
    });
  }

  const settingsObj = {};
  for (const s of settingsRows) settingsObj[s.key] = s.value;

  return {
    members: members.map((m) => ({
      id: m.id,
      name: m.name,
      email: m.email,
      slack_id: m.slack_id,
      can_oncall: m.can_oncall,
      can_overnight: m.can_overnight,
      active: m.active,
      created_at: m.created_at,
      annual_leave_days: m.annual_leave_days,
      profile: {
        headline: m.profile_headline,
        phone: m.profile_phone,
        location: m.profile_location,
        linkedin: m.profile_linkedin,
        summary: m.profile_summary,
        skills: m.profile_skills || [],
        history: historyByMember[m.id] || []
      }
    })),
    users,
    projects,
    member_projects: memberProjects,
    leave_requests: leaveRequests,
    shift_slots: shiftSlots,
    swap_requests: swapRequests,
    holidays,
    settings: settingsObj
  };
}

function validBackupShape(candidate) {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return false;
  const requiredArrays = ['members', 'users', 'projects', 'member_projects', 'leave_requests', 'shift_slots', 'swap_requests', 'holidays'];
  return requiredArrays.every((key) => Array.isArray(candidate[key]));
}

// Replaces every table's contents with an uploaded backup's rows, inside
// one transaction — throws (and changes nothing) if the shape looks wrong,
// so a bad upload can't silently wipe the app. Ids are preserved from the
// backup file; every SERIAL sequence is bumped past the max id afterward.
async function restoreFromBackup(candidate) {
  if (!validBackupShape(candidate)) {
    throw new Error('That file does not look like a Shift Scheduler backup.');
  }

  await db.withTransaction(async (client) => {
    await client.query(
      'TRUNCATE swap_requests, shift_slots, member_history, member_projects, leave_requests, users, projects, members, holidays, settings RESTART IDENTITY CASCADE'
    );

    for (const m of candidate.members) {
      const profile = m.profile || {};
      await client.query(
        `INSERT INTO members
           (id, name, email, slack_id, can_oncall, can_overnight, active, created_at, annual_leave_days,
            profile_headline, profile_phone, profile_location, profile_linkedin, profile_summary, profile_skills)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
        [
          m.id,
          m.name,
          m.email,
          m.slack_id || null,
          !!m.can_oncall,
          !!m.can_overnight,
          m.active !== false,
          m.created_at || new Date().toISOString(),
          m.annual_leave_days != null ? m.annual_leave_days : null,
          profile.headline || '',
          profile.phone || '',
          profile.location || '',
          profile.linkedin || '',
          profile.summary || '',
          profile.skills || []
        ]
      );
      for (const h of profile.history || []) {
        await client.query(
          `INSERT INTO member_history (id, member_id, title, organization, start_label, end_label, description)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [h.id, m.id, h.title, h.organization, h.start || null, h.end || null, h.description || null]
        );
      }
    }

    for (const p of candidate.projects) {
      await client.query(
        `INSERT INTO projects (id, name, active, coverage_days, min_staff_day, needs_oncall, needs_overnight)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [p.id, p.name, p.active !== false, p.coverage_days || '0,1,2,3,4,5,6', p.min_staff_day || 1, !!p.needs_oncall, !!p.needs_overnight]
      );
    }

    for (const mp of candidate.member_projects) {
      await client.query('INSERT INTO member_projects (member_id, project_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [
        mp.member_id,
        mp.project_id
      ]);
    }

    for (const u of candidate.users) {
      await client.query(
        `INSERT INTO users (id, member_id, username, password_hash, role, must_change_password) VALUES ($1,$2,$3,$4,$5,$6)`,
        [u.id, u.member_id != null ? u.member_id : null, u.username, u.password_hash, u.role || 'member', u.must_change_password !== false]
      );
    }

    for (const h of candidate.holidays) {
      await client.query('INSERT INTO holidays (id, date, name, source) VALUES ($1,$2,$3,$4)', [
        h.id,
        h.date,
        h.name,
        h.source || 'custom'
      ]);
    }

    for (const s of candidate.shift_slots) {
      await client.query(
        `INSERT INTO shift_slots
           (id, project_id, kind, slot_date, start_time, end_time, crosses_midnight, assignee_id, week_start, status, note, handover_note, handover_updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [
          s.id,
          s.project_id,
          s.kind,
          s.slot_date,
          s.start_time,
          s.end_time,
          !!s.crosses_midnight,
          s.assignee_id != null ? s.assignee_id : null,
          s.week_start,
          s.status || 'draft',
          s.note || null,
          s.handover_note || null,
          s.handover_updated_at || null
        ]
      );
    }

    for (const sw of candidate.swap_requests) {
      await client.query(
        `INSERT INTO swap_requests (id, shift_slot_id, from_member_id, to_member_id, status, created_at, decided_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [
          sw.id,
          sw.shift_slot_id,
          sw.from_member_id,
          sw.to_member_id != null ? sw.to_member_id : null,
          sw.status || 'pending',
          sw.created_at || new Date().toISOString(),
          sw.decided_at || null
        ]
      );
    }

    for (const l of candidate.leave_requests) {
      await client.query(
        `INSERT INTO leave_requests (id, member_id, start_date, end_date, type, reason, status, created_at, decided_by, decided_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          l.id,
          l.member_id,
          l.start_date,
          l.end_date,
          l.type || 'vacation',
          l.reason || null,
          l.status || 'pending',
          l.created_at || new Date().toISOString(),
          l.decided_by != null ? l.decided_by : null,
          l.decided_at || null
        ]
      );
    }

    const settingsObj =
      candidate.settings && typeof candidate.settings === 'object' && !Array.isArray(candidate.settings) ? candidate.settings : {};
    for (const [key, value] of Object.entries(settingsObj)) {
      await client.query('INSERT INTO settings (key, value) VALUES ($1,$2)', [key, String(value)]);
    }

    for (const t of SEQUENCED_TABLES) {
      await client.query(
        `SELECT setval(pg_get_serial_sequence('${t}', 'id'), COALESCE((SELECT MAX(id) FROM ${t}), 0) + 1, false)`
      );
    }
  });
}

// Downloads the entire data store as a single JSON file — the whole app's
// state, reassembled from every table.
router.get('/settings/backup', requireAdmin, async (req, res) => {
  const filename = `shift-scheduler-backup-${dayjs().format('YYYY-MM-DD-HHmm')}.json`;
  const backup = await assembleBackup();
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(JSON.stringify(backup, null, 2));
});

// Restores the whole data store from a previously downloaded backup file —
// gated by a typed confirmation since it replaces everything currently in
// the app. The current data is saved to disk first so a wrong upload is
// itself recoverable.
router.post('/settings/restore', requireAdmin, upload.single('backup_file'), async (req, res) => {
  if ((req.body.confirm_text || '').trim().toUpperCase() !== 'RESTORE') {
    req.session.flash = { type: 'error', message: 'Type RESTORE in the confirmation box to restore from a backup.' };
    return res.redirect('/settings');
  }
  if (!req.file) {
    req.session.flash = { type: 'error', message: 'Choose a backup .json file to restore.' };
    return res.redirect('/settings');
  }

  let parsed;
  try {
    parsed = JSON.parse(req.file.buffer.toString('utf8'));
  } catch (err) {
    req.session.flash = { type: 'error', message: `That file isn't valid JSON: ${err.message}` };
    return res.redirect('/settings');
  }

  const dataDir = path.join(__dirname, '..', '..', 'data');
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  const safetyFile = path.join(dataDir, `pre-restore-${dayjs().format('YYYY-MM-DD-HHmmss-SSS')}.json`);
  fs.writeFileSync(safetyFile, JSON.stringify(await assembleBackup(), null, 2));

  try {
    await restoreFromBackup(parsed);
  } catch (err) {
    req.session.flash = { type: 'error', message: `Restore failed: ${err.message}` };
    return res.redirect('/settings');
  }

  // The current session's user id may no longer exist in the restored data
  // (or may now mean someone else), so force a fresh login rather than
  // trusting the old session.
  req.session.destroy(() => {
    res.redirect('/login?restored=1');
  });
});

// Wipes every member, user login (except the admin performing the reset),
// project, leave request, shift slot, and swap request. Settings (config)
// are left untouched. Irreversible — gated by a typed confirmation.
router.post('/settings/reset-data', requireAdmin, async (req, res) => {
  if ((req.body.confirm_text || '').trim().toUpperCase() !== 'RESET') {
    req.session.flash = { type: 'error', message: 'Type RESET in the confirmation box to wipe all data.' };
    return res.redirect('/settings');
  }

  const currentUserId = req.session.user.id;

  try {
    await db.withTransaction(async (client) => {
      // Detach the acting admin's own login from their member row first —
      // members->users is ON DELETE CASCADE, which would otherwise delete
      // this login too when every member is wiped below.
      await client.query('UPDATE users SET member_id = NULL WHERE id = $1', [currentUserId]);
      await client.query('DELETE FROM swap_requests');
      await client.query('DELETE FROM shift_slots');
      await client.query('DELETE FROM leave_requests');
      await client.query('DELETE FROM member_projects');
      await client.query('DELETE FROM users WHERE id != $1', [currentUserId]);
      await client.query('DELETE FROM members'); // cascades to member_history
      await client.query('DELETE FROM projects');
    });
  } catch (err) {
    req.session.flash = { type: 'error', message: `Reset failed: ${err.message}` };
    return res.redirect('/settings');
  }

  req.session.flash = {
    type: 'success',
    message: 'All members, projects, schedules, leave requests, and swap requests were deleted. Every login except yours was removed.'
  };
  res.redirect('/settings');
});

module.exports = router;
// Exposed for scripts/migrate-json-to-pg.js — migrating the old JSON store
// into Postgres is exactly "restore this file as if it were a backup".
module.exports.assembleBackup = assembleBackup;
module.exports.restoreFromBackup = restoreFromBackup;
