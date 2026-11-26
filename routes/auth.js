const express = require('express');
const bcrypt = require('bcryptjs');
const { queryOne, queryAll } = require('../db');

function getPortalShutdownStateNode() {
  const defaultMsg = 'Portal is temporarily closed by Admin. Work is paused—please check back later.';
  try {
    const rows = queryAll("SELECT key, value FROM system_settings WHERE key IN ('portal_shutdown', 'portal_shutdown_message')");
    const map = {};
    (rows || []).forEach(r => { map[r.key] = r.value; });
    return {
      isShutdown: map.portal_shutdown === '1',
      message: (map.portal_shutdown_message || '').trim() || defaultMsg
    };
  } catch (e) {
    return { isShutdown: false, message: defaultMsg };
  }
}

function getPortalNoticeStateNode() {
  try {
    const rows = queryAll("SELECT key, value FROM system_settings WHERE key IN ('portal_notice_enabled', 'portal_notice_title', 'portal_notice_message', 'portal_notice_version')");
    const map = {};
    (rows || []).forEach(r => { map[r.key] = r.value; });
    return {
      enabled: map.portal_notice_enabled === '1' && !!(map.portal_notice_message || '').trim(),
      title: (map.portal_notice_title || '').trim() || '📢 Important Update',
      message: (map.portal_notice_message || '').trim(),
      version: map.portal_notice_version || '1'
    };
  } catch (e) {
    return { enabled: false, title: '', message: '', version: '' };
  }
}

const router = express.Router();

// User Registration with Gmail
router.post('/register', (req, res) => {
  const shutdown = getPortalShutdownStateNode();
  if (shutdown.isShutdown) {
    return res.status(503).json({ error: shutdown.message, portalShutdown: true });
  }

  const name = String(req.body.name || '').trim();
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const telegramChatId = String(req.body.telegramChatId || '').trim();

  if (!name || name.length < 2) {
    return res.status(400).json({ error: 'Please enter your full name.' });
  }
  if (!email || !/^[^\s@]+@gmail\.com$/i.test(email)) {
    return res.status(400).json({ error: 'Please register using a valid @gmail.com email address.' });
  }
  if (!password || password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  }

  const existing = queryOne('SELECT id FROM users WHERE LOWER(email) = ?', [email]);
  if (existing) {
    return res.status(409).json({ error: 'An account with this Gmail already exists. Please sign in.' });
  }

  const { runSql } = require('../db');
  const hash = bcrypt.hashSync(password, 10);
  const newUserId = runSql(
    `INSERT INTO users (name, email, password, application_fee, ll_pdf_fee, payment_mode, telegram_chat_id)
     VALUES (?, ?, ?, 200.00, 20.00, 'batch', ?)`,
    [name, email, hash, telegramChatId]
  );

  req.session.userId = newUserId;
  req.session.userType = 'user';
  res.json({ success: true, message: '🎉 Account created successfully! Redirecting to dashboard...' });
});

// User Login
router.post('/login', (req, res) => {
  const shutdown = getPortalShutdownStateNode();
  if (shutdown.isShutdown) {
    return res.status(503).json({ error: shutdown.message, portalShutdown: true });
  }

  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  const user = queryOne('SELECT * FROM users WHERE LOWER(email) = LOWER(?)', [String(email).trim()]);
  if (!user || !bcrypt.compareSync(password, user.password)) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }

  req.session.userId = user.id;
  req.session.userType = 'user';
  res.json({ success: true, message: 'Login successful' });
});

// Admin Login
router.post('/admin/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }

  const admin = queryOne('SELECT * FROM admins WHERE username = ?', [username]);
  if (!admin || !bcrypt.compareSync(password, admin.password)) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  req.session.adminId = admin.id;
  req.session.userType = 'admin';
  res.json({ success: true, message: 'Admin login successful' });
});

// Logout
router.post('/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

// Check session
router.get('/me', (req, res) => {
  const shutdown = getPortalShutdownStateNode();
  const notice = getPortalNoticeStateNode();
  if (req.session.userId) {
    const user = queryOne('SELECT id, name, email, application_fee, ll_pdf_fee, wallet_balance, telegram_chat_id, created_at FROM users WHERE id = ?', [req.session.userId]);
    return res.json({ loggedIn: true, userType: 'user', user, portalShutdown: shutdown.isShutdown, shutdownMessage: shutdown.message, portalNotice: notice });
  }
  if (req.session.adminId) {
    return res.json({ loggedIn: true, userType: 'admin', portalShutdown: shutdown.isShutdown, shutdownMessage: shutdown.message, portalNotice: notice });
  }
  res.json({ loggedIn: false, portalShutdown: shutdown.isShutdown, shutdownMessage: shutdown.message, portalNotice: notice });
});

module.exports = router;
