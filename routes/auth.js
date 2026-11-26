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

const router = express.Router();

// Public user registration is disabled as only admins can create user IDs.
router.post('/register', (req, res) => {
  return res.status(403).json({ error: 'Public registration is disabled. Please contact the administrator for account creation.' });
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

  const user = queryOne('SELECT * FROM users WHERE email = ?', [email]);
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
  if (req.session.userId) {
    const user = queryOne('SELECT id, name, email, application_fee, wallet_balance, telegram_chat_id, created_at FROM users WHERE id = ?', [req.session.userId]);
    return res.json({ loggedIn: true, userType: 'user', user, portalShutdown: shutdown.isShutdown, shutdownMessage: shutdown.message });
  }
  if (req.session.adminId) {
    return res.json({ loggedIn: true, userType: 'admin', portalShutdown: shutdown.isShutdown, shutdownMessage: shutdown.message });
  }
  res.json({ loggedIn: false, portalShutdown: shutdown.isShutdown, shutdownMessage: shutdown.message });
});

module.exports = router;
