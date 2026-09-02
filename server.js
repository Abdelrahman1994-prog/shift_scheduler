require('dotenv').config();
const path = require('path');
const express = require('express');
require('express-async-errors'); // lets async route handlers reject -> next(err) instead of hanging
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);

const db = require('./src/db');

const { requireLogin, requirePasswordCurrent } = require('./src/middleware/auth');
const authRoutes = require('./src/routes/auth');
const dashboardRoutes = require('./src/routes/dashboard');
const memberRoutes = require('./src/routes/members');
const projectRoutes = require('./src/routes/projects');
const leaveRoutes = require('./src/routes/leave');
const scheduleRoutes = require('./src/routes/schedule');
const swapRoutes = require('./src/routes/swaps');
const settingsRoutes = require('./src/routes/settings');
const profileRoutes = require('./src/routes/profile');
const oncallRoutes = require('./src/routes/oncall');

const app = express();

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.use(
  session({
    store: new pgSession({ pool: db.pool, createTableIfMissing: true }),
    secret: process.env.SESSION_SECRET || 'dev-only-secret-change-me',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 1000 * 60 * 60 * 24 * 14 } // 14 days
  })
);

// Flash messages: routes set req.session.flash, we surface it once then clear it.
app.use((req, res, next) => {
  res.locals.flash = req.session.flash || null;
  delete req.session.flash;
  res.locals.currentUser = req.session.user || null;
  next();
});

app.use(authRoutes);

app.use(requireLogin);
app.use(requirePasswordCurrent);

app.use(dashboardRoutes);
app.use(memberRoutes);
app.use(projectRoutes);
app.use(leaveRoutes);
app.use(scheduleRoutes);
app.use(swapRoutes);
app.use(settingsRoutes);
app.use(profileRoutes);
app.use(oncallRoutes);

app.use((req, res) => {
  res.status(404).render('error', { message: 'Page not found.' });
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).render('error', { message: 'An unexpected error occurred.' });
});

const PORT = process.env.PORT || 3000;
db.init()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Shift Scheduler running at http://localhost:${PORT}`);
    });
  })
  .catch((err) => {
    console.error('Failed to initialize the database:', err);
    process.exit(1);
  });
