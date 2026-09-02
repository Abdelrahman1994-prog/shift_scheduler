// Postgres-backed data layer. Replaces the earlier JSON-file store now that
// the app needs to survive redeploys on a host with an ephemeral filesystem.
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const dayjs = require('dayjs');
const { fixedHolidaysForYear } = require('./egypt-holidays');

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error('DATABASE_URL is not set. Point it at a Postgres connection string (see .env.example).');
}

// Render (and most hosted Postgres) require SSL on external connections but
// use certs that aren't in Node's default trust store — this is the
// standard node-postgres workaround, not a security downgrade of the
// connection itself (still encrypted, just not chain-verified).
const useSSL = /render\.com|amazonaws\.com|sslmode=require/.test(connectionString) || process.env.PGSSL === 'true';

const pool = new Pool({
  connectionString,
  ssl: useSSL ? { rejectUnauthorized: false } : false
});

function query(text, params) {
  return pool.query(text, params);
}

// Checks out a single client, runs fn inside BEGIN/COMMIT, rolls back and
// rethrows on any error. Always releases the client back to the pool.
async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// Fixed-date national holidays never change year to year (see
// egypt-holidays.js), so they're safe to seed automatically — only once,
// the first time the holidays table is empty, for this year and the next
// two. Moon-sighting-dependent holidays are never auto-seeded; those get
// added by hand from Settings once officially announced.
async function seedFixedHolidaysIfEmpty() {
  const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM holidays');
  if (rows[0].n > 0) return;

  const year = dayjs().year();
  const holidays = [year, year + 1, year + 2].flatMap((y) => fixedHolidaysForYear(y));
  for (const h of holidays) {
    await pool.query(`INSERT INTO holidays (date, name, source) VALUES ($1, $2, 'auto')`, [h.date, h.name]);
  }
}

// Idempotent — safe to run on every boot, same spirit as the old JSON
// store's "fill in any keys added after the file was created" migration.
async function init() {
  const schema = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
  await pool.query(schema);
  await seedFixedHolidaysIfEmpty();
}

module.exports = { pool, query, withTransaction, init };
