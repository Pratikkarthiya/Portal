const express = require('express');
const bcrypt = require('bcryptjs');
const { queryAll, queryOne, runSql } = require('../db');

const router = express.Router();

function requireAdmin(req, res, next) {
  if (!req.session.adminId) {
    return res.status(401).json({ error: 'Admin access required' });
  }
  next();
}

// Admin creates new user account with customized Application Fee
router.post('/users', requireAdmin, (req, res) => {
  const { name, email, password, applicationFee } = req.body;
  if (!name || !email || !password) {
    return res.status(400).json({ error: 'Name, email, and password are required' });
  }

  const existing = queryOne('SELECT id FROM users WHERE email = ?', [email]);
  if (existing) {
    return res.status(409).json({ error: 'User with this email already exists' });
  }

  const fee = parseFloat(applicationFee) > 0 ? parseFloat(applicationFee) : 50.00;
  const hash = bcrypt.hashSync(password, 10);
  const newUserId = runSql(
    'INSERT INTO users (name, email, password, application_fee) VALUES (?, ?, ?, ?)',
    [name, email, hash, fee]
  );

  res.json({
    success: true,
    message: `User account created successfully with application fee of ₹${fee.toFixed(2)}`,
    userId: newUserId,
    applicationFee: fee
  });
});

// Admin updates user details (Name, Email, Application Fee, optional Password)
router.put('/users/:userId', requireAdmin, (req, res) => {
  const userId = Number(req.params.userId);
  const user = queryOne('SELECT * FROM users WHERE id = ?', [userId]);
  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }

  const { name, email, applicationFee, newPassword } = req.body;
  if (!name || !email) {
    return res.status(400).json({ error: 'Name and email are required' });
  }

  // Check email uniqueness if email changed
  if (email !== user.email) {
    const existing = queryOne('SELECT id FROM users WHERE email = ? AND id != ?', [email, userId]);
    if (existing) {
      return res.status(409).json({ error: 'Another user already has this email address' });
    }
  }

  const fee = parseFloat(applicationFee) > 0 ? parseFloat(applicationFee) : user.application_fee;

  if (newPassword && newPassword.trim().length >= 6) {
    const hash = bcrypt.hashSync(newPassword.trim(), 10);
    runSql(
      'UPDATE users SET name = ?, email = ?, application_fee = ?, password = ? WHERE id = ?',
      [name, email, fee, hash, userId]
    );
  } else {
    runSql(
      'UPDATE users SET name = ?, email = ?, application_fee = ? WHERE id = ?',
      [name, email, fee, userId]
    );
  }

  res.json({
    success: true,
    message: `User profile & application fee updated to ₹${fee.toFixed(2)} successfully!`
  });
});

// Get all users with application counts & payment stats
router.get('/users', requireAdmin, (req, res) => {
  const users = queryAll(`
    SELECT u.id, u.name, u.email, u.application_fee, u.created_at,
           COUNT(a.id) as total_applications,
           SUM(CASE WHEN a.status = 'pending' THEN 1 ELSE 0 END) as pending,
           SUM(CASE WHEN a.status = 'approved' THEN 1 ELSE 0 END) as approved,
           SUM(CASE WHEN a.status = 'rejected' THEN 1 ELSE 0 END) as rejected,
           SUM(CASE WHEN a.payment_status = 'paid' THEN a.payment_amount ELSE 0 END) as total_paid
    FROM users u
    LEFT JOIN applications a ON u.id = a.user_id
    GROUP BY u.id
    ORDER BY u.created_at DESC
  `);

  res.json({ users });
});

// Get all applications across all users with user name and email
router.get('/applications', requireAdmin, (req, res) => {
  const applications = queryAll(`
    SELECT a.*, u.name as user_name, u.email as user_email, u.application_fee
    FROM applications a
    JOIN users u ON a.user_id = u.id
    ORDER BY a.submitted_at DESC
  `);
  res.json({ applications });
});

// Get specific user's applications & profile details
router.get('/users/:userId/applications', requireAdmin, (req, res) => {
  const user = queryOne('SELECT id, name, email, application_fee, created_at FROM users WHERE id = ?', [Number(req.params.userId)]);
  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }

  const applications = queryAll(
    'SELECT * FROM applications WHERE user_id = ? ORDER BY submitted_at DESC',
    [Number(req.params.userId)]
  );

  res.json({ user, applications });
});

// Review application (approve / reject)
router.put('/applications/:appId', requireAdmin, (req, res) => {
  const { status, remarks } = req.body;
  if (!['approved', 'rejected'].includes(status)) {
    return res.status(400).json({ error: 'Status must be approved or rejected' });
  }

  const app = queryOne('SELECT id FROM applications WHERE id = ?', [Number(req.params.appId)]);
  if (!app) {
    return res.status(404).json({ error: 'Application not found' });
  }

  runSql(
    'UPDATE applications SET status = ?, admin_remarks = ?, reviewed_at = CURRENT_TIMESTAMP WHERE id = ?',
    [status, remarks || '', Number(req.params.appId)]
  );

  res.json({ success: true, message: `Application ${status}` });
});

// Dashboard stats including revenue
router.get('/stats', requireAdmin, (req, res) => {
  const totalUsers = queryOne('SELECT COUNT(*) as c FROM users');
  const totalApps = queryOne('SELECT COUNT(*) as c FROM applications');
  const pending = queryOne("SELECT COUNT(*) as c FROM applications WHERE status = 'pending'");
  const approved = queryOne("SELECT COUNT(*) as c FROM applications WHERE status = 'approved'");
  const rejected = queryOne("SELECT COUNT(*) as c FROM applications WHERE status = 'rejected'");
  const revenue = queryOne("SELECT SUM(payment_amount) as total FROM applications WHERE payment_status = 'paid'");

  res.json({
    totalUsers: totalUsers ? totalUsers.c : 0,
    totalApplications: totalApps ? totalApps.c : 0,
    pending: pending ? pending.c : 0,
    approved: approved ? approved.c : 0,
    rejected: rejected ? rejected.c : 0,
    totalRevenue: revenue && revenue.total ? revenue.total : 0
  });
});

module.exports = router;
