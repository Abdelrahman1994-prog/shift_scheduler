const express = require('express');
const db = require('../db');
const { requireAdmin } = require('../middleware/auth');

const router = express.Router();
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

router.get('/projects', requireAdmin, async (req, res) => {
  const { rows: projects } = await db.query(`
    SELECT p.*, COUNT(mp.member_id)::int AS "memberCount"
    FROM projects p
    LEFT JOIN member_projects mp ON mp.project_id = p.id
    GROUP BY p.id
    ORDER BY p.active DESC, p.name
  `);

  res.render('projects', {
    title: 'Projects',
    active: 'projects',
    projects,
    DAY_NAMES
  });
});

router.post('/projects', requireAdmin, async (req, res) => {
  const { name, min_staff_day, needs_oncall, needs_overnight } = req.body;
  const coverageDays = [].concat(req.body.coverage_days || []).join(',') || '0,1,2,3,4,5,6';

  if (!name) {
    req.session.flash = { type: 'error', message: 'Project name is required.' };
    return res.redirect('/projects');
  }

  await db.query(
    `INSERT INTO projects (name, needs_oncall, needs_overnight, min_staff_day, coverage_days, active)
     VALUES ($1, $2, $3, $4, $5, true)`,
    [name.trim(), !!needs_oncall, !!needs_overnight, Math.max(1, Number(min_staff_day) || 1), coverageDays]
  );

  req.session.flash = { type: 'success', message: `${name} added.` };
  res.redirect('/projects');
});

router.post('/projects/:id/edit', requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const { name, min_staff_day, needs_oncall, needs_overnight, active } = req.body;
  const coverageDays = [].concat(req.body.coverage_days || []).join(',') || '0,1,2,3,4,5,6';

  await db.query(
    `UPDATE projects SET name = $2, needs_oncall = $3, needs_overnight = $4, min_staff_day = $5, coverage_days = $6, active = $7
     WHERE id = $1`,
    [id, name.trim(), !!needs_oncall, !!needs_overnight, Math.max(1, Number(min_staff_day) || 1), coverageDays, !!active]
  );

  req.session.flash = { type: 'success', message: 'Project updated.' };
  res.redirect('/projects');
});

module.exports = router;
