-- Shift Scheduler — Postgres schema. Idempotent (CREATE TABLE IF NOT EXISTS),
-- run automatically on boot by src/db.js#init(). Mirrors the shape of the
-- earlier JSON-file store 1:1 so every route's query returns the same field
-- names the views already expect.
--
-- Dates and timestamps are TEXT ('YYYY-MM-DD' / ISO8601), not DATE/TIMESTAMPTZ
-- — the app already treats them everywhere as plain sortable strings
-- (localeCompare, slice(0,4), <=), and node-postgres otherwise parses those
-- types into JS Date objects with timezone-conversion footguns. Storing them
-- as the exact same strings the app already produces sidesteps that
-- entirely; ISO-format strings sort/compare identically to real dates.

CREATE TABLE IF NOT EXISTS members (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  slack_id TEXT,
  can_oncall BOOLEAN NOT NULL DEFAULT false,
  can_overnight BOOLEAN NOT NULL DEFAULT false,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TEXT NOT NULL,
  annual_leave_days INTEGER,
  profile_headline TEXT NOT NULL DEFAULT '',
  profile_phone TEXT NOT NULL DEFAULT '',
  profile_location TEXT NOT NULL DEFAULT '',
  profile_linkedin TEXT NOT NULL DEFAULT '',
  profile_summary TEXT NOT NULL DEFAULT '',
  profile_skills TEXT[] NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS member_history (
  id SERIAL PRIMARY KEY,
  member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  organization TEXT NOT NULL,
  start_label TEXT,
  end_label TEXT,
  description TEXT
);
CREATE INDEX IF NOT EXISTS idx_member_history_member ON member_history(member_id);

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  member_id INTEGER REFERENCES members(id) ON DELETE CASCADE,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',
  must_change_password BOOLEAN NOT NULL DEFAULT true
);
CREATE INDEX IF NOT EXISTS idx_users_member ON users(member_id);

CREATE TABLE IF NOT EXISTS projects (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT true,
  coverage_days TEXT NOT NULL DEFAULT '0,1,2,3,4,5,6',
  min_staff_day INTEGER NOT NULL DEFAULT 1,
  needs_oncall BOOLEAN NOT NULL DEFAULT false,
  needs_overnight BOOLEAN NOT NULL DEFAULT false
);

CREATE TABLE IF NOT EXISTS member_projects (
  member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  PRIMARY KEY (member_id, project_id)
);
CREATE INDEX IF NOT EXISTS idx_member_projects_project ON member_projects(project_id);

CREATE TABLE IF NOT EXISTS leave_requests (
  id SERIAL PRIMARY KEY,
  member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'vacation',
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL,
  decided_by INTEGER,
  decided_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_leave_requests_member ON leave_requests(member_id, status);
CREATE INDEX IF NOT EXISTS idx_leave_requests_dates ON leave_requests(start_date, end_date);

CREATE TABLE IF NOT EXISTS shift_slots (
  id SERIAL PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  slot_date TEXT NOT NULL,
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  crosses_midnight BOOLEAN NOT NULL DEFAULT false,
  assignee_id INTEGER REFERENCES members(id) ON DELETE SET NULL,
  week_start TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  note TEXT,
  handover_note TEXT,
  handover_updated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_shift_slots_week ON shift_slots(week_start);
CREATE INDEX IF NOT EXISTS idx_shift_slots_date_status ON shift_slots(slot_date, status);
CREATE INDEX IF NOT EXISTS idx_shift_slots_assignee ON shift_slots(assignee_id);

CREATE TABLE IF NOT EXISTS swap_requests (
  id SERIAL PRIMARY KEY,
  shift_slot_id INTEGER NOT NULL REFERENCES shift_slots(id) ON DELETE CASCADE,
  from_member_id INTEGER NOT NULL REFERENCES members(id),
  to_member_id INTEGER REFERENCES members(id),
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL,
  decided_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_swap_requests_status ON swap_requests(status);

CREATE TABLE IF NOT EXISTS holidays (
  id SERIAL PRIMARY KEY,
  date TEXT NOT NULL,
  name TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'custom'
);
CREATE INDEX IF NOT EXISTS idx_holidays_date ON holidays(date);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
