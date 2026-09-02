# Shift Scheduler

A small internal web app for application-support team leads: generates weekly
schedules (day shifts, on-call, overnight) across multiple projects, respects
fairness and rest rules, and includes a vacation/leave module that
automatically blocks scheduling for approved time off.

This is the working implementation of the plan in *Weekly Shift Scheduler —
Build Recommendations*.

## What it does

- **Members & projects** — roster management, project assignment, on-call /
  overnight eligibility flags.
- **Vacation & leave** — request, approve/reject, and a team leave board
  (a month grid of who's out and when). Approved leave is a hard constraint
  the scheduler respects automatically.
- **Scheduling engine** — generates a draft week at a click: filters out
  anyone not assigned to the project, on approved leave, or who wouldn't get
  the configured minimum rest, then assigns the least-loaded eligible person
  (rolling fairness score over the last N weeks) so on-call/overnight doesn't
  quietly pile onto the same two people.
- **Manual override** — every slot on the draft schedule can be reassigned by
  hand before publishing; the same rules are re-checked so you can't
  accidentally create a conflict.
- **Publish & notify** — publishing a week posts the full schedule to Slack
  (via an incoming webhook) if you've configured one.
- **Self-service swaps** — a member can post their published shift for
  someone else to pick up; accepting re-checks eligibility, leave, and rest
  automatically.
- **CSV export** — any week can be exported/printed.

## Requirements

- Node.js 22.5 or newer, from https://nodejs.org (check with `node --version`).
- A Postgres database. Locally, the easiest way is a Docker container:
  `docker run -d -e POSTGRES_PASSWORD=devpassword -e POSTGRES_DB=shift_scheduler -p 5433:5432 postgres:16`.

## Setup

```bash
npm install
cp .env.example .env
# edit .env — at minimum set DATABASE_URL and SESSION_SECRET, and
# ADMIN_EMAIL/ADMIN_PASSWORD if you want something other than the default
npm run seed
npm start
```

`npm start` creates any missing tables automatically on boot (see
`db/schema.sql`) — there's no separate migration step for a fresh database.

Open http://localhost:4000 (or whatever `PORT` is set to) and log in with the
admin email/password from `.env` (default `admin@example.com` /
`changeme123`). You'll be asked to set a new password on first login.

`npm run seed` also creates 3 sample projects and 8 sample members so you can
try generating a week immediately — every sample login uses the password
`changeme123`. Re-running `npm run seed` is safe; it skips creating sample
data if members already exist, and never touches an admin account that's
already there.

## Using it week to week

1. **Members** — add your team, assign each person to their project(s), and
   mark who can take on-call and who can take overnight.
2. **Projects** — for each project, say whether it needs on-call, overnight,
   how many people need to be on a day shift, and which days it runs.
3. **Vacation & leave** — approve any pending time-off requests before you
   generate the week; the generator only respects *approved* leave.
4. **Schedule → Generate draft** — builds the week. Anything it couldn't
   fill shows up as an "Unfilled" chip with a reason; fix those by hand using
   the dropdown on each shift, or by adjusting project/member settings.
5. **Schedule → Publish week** — locks the week in and posts it to Slack if
   you've set a webhook URL in Settings.

## Configuration (Settings page)

- **Minimum rest (hours)** — how much rest is required around every on-call
  or overnight shift before someone can be given another shift.
- **Fairness look-back (weeks)** — how far back the generator looks when
  deciding who's "due" for on-call/overnight next.
- **Shift times** — the default start/end for day, on-call, and overnight
  shifts. On-call and overnight are treated as crossing midnight when the end
  time is earlier than the start time.
- **Slack webhook URL** — optional; create one at
  https://api.slack.com/messaging/webhooks and paste it in to get the weekly
  schedule posted automatically on publish.

## Notes on this version (v1)

A few deliberate simplifications, called out so they're easy to revisit:

- **Database is Postgres** (`src/db.js`, schema in `db/schema.sql`, both
  created automatically on boot). An earlier version of this app used a
  single JSON file — `scripts/migrate-json-to-pg.js` is the one-time script
  that moved a `data/db.json` export into Postgres; it's kept around in case
  you're doing that same move for a fork of this app. Settings → Backup &
  restore downloads/restores the whole database as one JSON file regardless
  of which storage layer is behind it.
- **Login is email + password** (bcrypt-hashed, session-based) rather than
  SSO. Swapping in SSO later means replacing `src/routes/auth.js` without
  touching the rest of the app.
- **Personal shift reminders and leave-request emails aren't wired up** —
  the Slack webhook covers the team-wide weekly post, but per-person
  reminders need an email/SMS provider's API key, which isn't something this
  app can assume for you. `src/notify.js` is where that would plug in.
- **The assignment algorithm is a greedy fairness pass**, not a constraint
  solver — it's genuinely sufficient at 10–30 people. If a lot of slots start
  going unfilled because the constraints are too tight for the roster, that's
  the signal to grow into a real solver (e.g. Google OR-Tools), not before.
- **No automated tests yet** — the app was smoke-tested end to end (seed →
  generate → publish → swap → leave approval) before delivery; add tests as
  you extend it.

## Deploying (Render)

1. Create a Postgres instance on Render, and a Web Service pointing at this
   repo (build command `npm install`, start command `npm start`).
2. Set env vars on the web service: `DATABASE_URL` (the Postgres instance's
   Internal Database URL), `SESSION_SECRET` (a long random string).
3. First deploy creates the schema automatically. To bring in existing data,
   run `node scripts/migrate-json-to-pg.js path/to/db.json` from your own
   machine with `DATABASE_URL` pointed at the Postgres instance's *External*
   connection string.

## Project layout

```
server.js               entry point
db/schema.sql            Postgres schema (auto-applied on boot)
src/db.js                Postgres pool + query/transaction helpers
src/settings.js          key/value settings helper
src/scheduler.js        the scheduling engine (filters + fairness scoring)
src/notify.js           Slack webhook posting
src/middleware/auth.js  login/role guards
src/routes/             one file per feature area
views/                  EJS templates
public/styles.css       app styling
scripts/seed.js         admin + sample data seeding
scripts/migrate-json-to-pg.js  one-time JSON -> Postgres migration
```
