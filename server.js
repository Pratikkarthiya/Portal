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
app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: true, limit: '25mb' }));
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

// High-performance media serving endpoint (serves binary image with HTTP cache headers)
const { queryOne } = require('./db');
app.get('/api/media/:appId/:type', (req, res) => {
  const { appId, type } = req.params;
  let col = 'photo_url';
  if (type === 'receipt') col = 'payment_screenshot_url';
  else if (type === 'result') col = 'result_photo_url';
  else if (type !== 'photo') return res.status(400).send('Invalid media type');

  const app = queryOne(`SELECT ${col} AS media_data FROM applications WHERE id = ?`, [Number(appId)]);
  if (!app || !app.media_data) return res.status(404).send('Not found');

  const dataStr = (app.media_data || '').trim();
  if (dataStr.startsWith('http://') || dataStr.startsWith('https://') || dataStr.startsWith('/')) {
    return res.redirect(dataStr);
  }
  if (dataStr.startsWith('data:')) {
    const comma = dataStr.indexOf(',');
    const meta = dataStr.substring(0, comma);
    const base64 = dataStr.substring(comma + 1);
    const mimeMatch = meta.match(/data:([^;]+)/);
    const mime = mimeMatch ? mimeMatch[1] : 'image/jpeg';
    const buffer = Buffer.from(base64, 'base64');
    res.setHeader('Content-Type', mime);
    res.setHeader('Cache-Control', 'public, max-age=604800, immutable');
    return res.send(buffer);
  }
  res.status(404).send('Not found');
});

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
