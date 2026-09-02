const db = require('./db');

async function getAll() {
  const { rows } = await db.query('SELECT key, value FROM settings');
  const cfg = {};
  for (const r of rows) cfg[r.key] = r.value;
  return cfg;
}

async function get(key, fallback = null) {
  const { rows } = await db.query('SELECT value FROM settings WHERE key = $1', [key]);
  return rows.length ? rows[0].value : fallback;
}

async function set(key, value) {
  await db.query(
    'INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value',
    [key, String(value)]
  );
}

module.exports = { getAll, get, set };
