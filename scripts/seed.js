require('dotenv').config();
const bcrypt = require('bcryptjs');
const db = require('../src/db');

const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || 'admin@example.com').toLowerCase();
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'changeme123';

async function upsertAdmin() {
  const { rows } = await db.query('SELECT 1 FROM users WHERE username = $1', [ADMIN_EMAIL]);
  if (rows.length) {
    console.log(`Admin user ${ADMIN_EMAIL} already exists — leaving it as is.`);
    return;
  }
  const hash = bcrypt.hashSync(ADMIN_PASSWORD, 10);
  await db.query(
    `INSERT INTO users (member_id, username, password_hash, role, must_change_password) VALUES (NULL, $1, $2, 'admin', true)`,
    [ADMIN_EMAIL, hash]
  );
  console.log(`Created admin login: ${ADMIN_EMAIL} / ${ADMIN_PASSWORD} (you'll be asked to change this on first login)`);
}

async function seedSampleData() {
  const { rows } = await db.query('SELECT COUNT(*)::int AS n FROM members');
  if (rows[0].n > 0) {
    console.log('Members already exist — skipping sample data.');
    return;
  }

  const roster = [
    { name: 'Aisha Khan', email: 'aisha@example.com', oncall: true, overnight: true, projects: ['Acme Retail Platform', 'Nova Billing'] },
    { name: 'Ben Ortiz', email: 'ben@example.com', oncall: true, overnight: true, projects: ['Acme Retail Platform'] },
    { name: 'Chen Wei', email: 'chen@example.com', oncall: true, overnight: false, projects: ['Acme Retail Platform', 'Helix Internal Tools'] },
    { name: 'Dara Osei', email: 'dara@example.com', oncall: false, overnight: false, projects: ['Nova Billing', 'Helix Internal Tools'] },
    { name: 'Elif Yilmaz', email: 'elif@example.com', oncall: true, overnight: true, projects: ['Nova Billing'] },
    { name: 'Farid Haddad', email: 'farid@example.com', oncall: true, overnight: true, projects: ['Acme Retail Platform', 'Nova Billing'] },
    { name: 'Grace Muthoni', email: 'grace@example.com', oncall: false, overnight: false, projects: ['Helix Internal Tools'] },
    { name: 'Hassan Ali', email: 'hassan@example.com', oncall: true, overnight: false, projects: ['Acme Retail Platform'] }
  ];

  const pwHash = bcrypt.hashSync('changeme123', 10);

  await db.withTransaction(async (client) => {
    const projectIdByName = {};
    for (const [name, needsOncall, needsOvernight, minStaff, coverage] of [
      ['Acme Retail Platform', true, true, 2, '0,1,2,3,4,5,6'],
      ['Nova Billing', true, false, 1, '0,1,2,3,4,5,6'],
      ['Helix Internal Tools', false, false, 1, '1,2,3,4,5']
    ]) {
      const { rows: projectRows } = await client.query(
        `INSERT INTO projects (name, needs_oncall, needs_overnight, min_staff_day, coverage_days, active)
         VALUES ($1,$2,$3,$4,$5,true) RETURNING id`,
        [name, needsOncall, needsOvernight, minStaff, coverage]
      );
      projectIdByName[name] = projectRows[0].id;
    }

    for (const m of roster) {
      const { rows: memberRows } = await client.query(
        `INSERT INTO members (name, email, slack_id, can_oncall, can_overnight, active, created_at, annual_leave_days)
         VALUES ($1,$2,NULL,$3,$4,true,$5,NULL) RETURNING id`,
        [m.name, m.email, m.oncall, m.overnight, new Date().toISOString()]
      );
      const memberId = memberRows[0].id;

      for (const projectName of m.projects) {
        await client.query('INSERT INTO member_projects (member_id, project_id) VALUES ($1, $2)', [
          memberId,
          projectIdByName[projectName]
        ]);
      }

      await client.query(
        `INSERT INTO users (member_id, username, password_hash, role, must_change_password) VALUES ($1,$2,$3,'member',true)`,
        [memberId, m.email, pwHash]
      );
    }
  });

  console.log(`Seeded ${roster.length} sample members and 3 sample projects.`);
  console.log('Sample member logins all use password: changeme123 (forced change on first login)');
}

(async () => {
  await db.init();
  await upsertAdmin();
  await seedSampleData();
  console.log('Done.');
  await db.pool.end();
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
