const express = require('express');
const bcrypt = require('bcryptjs');
const { queryOne } = require('../db');

const router = express.Router();

// Public user registration is disabled as only admins can create user IDs.
router.post('/register', (req, res) => {
  return res.status(403).json({ error: 'Public registration is disabled. Please contact the administrator for account creation.' });
});

// User Login
router.post('/login', (req, res) => {
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
  if (req.session.userId) {
    const user = queryOne('SELECT id, name, email FROM users WHERE id = ?', [req.session.userId]);
    return res.json({ loggedIn: true, userType: 'user', user });
  }
  if (req.session.adminId) {
    return res.json({ loggedIn: true, userType: 'admin' });
  }
  res.json({ loggedIn: false });
});

module.exports = router;
