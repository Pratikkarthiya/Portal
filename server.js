const express = require('express');
const session = require('express-session');
const path = require('path');
const { initializeSQL, initialize } = require('./db');
const authRoutes = require('./routes/auth');
const userRoutes = require('./routes/user');
const adminRoutes = require('./routes/admin');
const youpiRoutes = require('./routes/youpi');

const app = express();
const PORT = 3000;

// Body Parsers (placed before routes so req.body is parsed)
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Session Middleware (placed before all API routes so req.session is populated)
app.use(session({
  secret: 'application-review-secret-key-2024',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 24 * 60 * 60 * 1000 }
}));

// API Routes
app.use('/api/auth', authRoutes);
app.use('/api/user', userRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/youpi', youpiRoutes);

// Page routes
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/register', (req, res) => res.sendFile(path.join(__dirname, 'public', 'register.html')));
app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'public', 'dashboard.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/admin/login', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin-login.html')));

async function start() {
  await initializeSQL();
  initialize();

  app.listen(PORT, () => {
    console.log(`\n========================================`);
    console.log(`  Application Review Portal is running!`);
    console.log(`========================================`);
    console.log(`  User site:       http://localhost:${PORT}`);
    console.log(`  Admin panel:     http://localhost:${PORT}/admin/login`);
    console.log(`  YouPI Gateway:   http://localhost:${PORT}/api/youpi`);
    console.log(`========================================\n`);
  });
}

start().catch(err => {
  console.error('Failed to start:', err);
  process.exit(1);
});
