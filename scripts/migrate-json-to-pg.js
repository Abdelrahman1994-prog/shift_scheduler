// One-time migration: loads the old JSON-file store (data/db.json, or a
// path passed as the first argument) into Postgres via DATABASE_URL.
// Read-only on the JSON file — never modifies or deletes it, so it stays a
// rollback snapshot no matter how many times this is run against a test
// database. Safe to re-run: it goes through the same restoreFromBackup()
// path the app's own "Restore from backup" feature uses, which starts by
// truncating every table, so re-running just re-imports cleanly.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const db = require('../src/db');
const { restoreFromBackup, assembleBackup } = require('../src/routes/settings');

const jsonPath = process.argv[2] || path.join(__dirname, '..', 'data', 'db.json');

(async () => {
  console.log(`Reading ${jsonPath} (read-only)...`);
  const raw = fs.readFileSync(jsonPath, 'utf8');
  const candidate = JSON.parse(raw);
  console.log(
    `Found ${candidate.members?.length ?? 0} members, ${candidate.projects?.length ?? 0} projects, ` +
      `${candidate.shift_slots?.length ?? 0} shift slots, ${candidate.leave_requests?.length ?? 0} leave requests, ` +
      `${candidate.holidays?.length ?? 0} holidays.`
  );

  console.log('Ensuring schema exists...');
  await db.init();

  console.log(`Importing into ${process.env.DATABASE_URL.replace(/:[^:@]*@/, ':***@')} ...`);
  await restoreFromBackup(candidate);

  const after = await assembleBackup();
  console.log(
    `Done. Postgres now has ${after.members.length} members, ${after.projects.length} projects, ` +
      `${after.shift_slots.length} shift slots, ${after.leave_requests.length} leave requests, ${after.holidays.length} holidays.`
  );

  await db.pool.end();
})().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
