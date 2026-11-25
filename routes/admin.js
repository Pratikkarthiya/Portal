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
  const { name, email, password, applicationFee, paymentMode } = req.body;
  if (!name || !email || !password) {
    return res.status(400).json({ error: 'Name, email, and password are required' });
  }

  const existing = queryOne('SELECT id FROM users WHERE email = ?', [email]);
  if (existing) {
    return res.status(409).json({ error: 'User with this email already exists' });
  }

  const fee = parseFloat(applicationFee) > 0 ? parseFloat(applicationFee) : 50.00;
  const mode = paymentMode === 'one_time' ? 'one_time' : 'batch';
  const hash = bcrypt.hashSync(password, 10);
  const newUserId = runSql(
    'INSERT INTO users (name, email, password, application_fee, payment_mode) VALUES (?, ?, ?, ?, ?)',
    [name, email, hash, fee, mode]
  );

  res.json({
    success: true,
    message: `User account created successfully (${mode === 'one_time' ? 'One-Time' : '5-Batch'}, fee ₹${fee.toFixed(2)})`,
    userId: newUserId,
    applicationFee: fee,
    paymentMode: mode
  });
});

// Admin updates user details (Name, Email, Application Fee, Payment Mode, optional Password)
router.put('/users/:userId', requireAdmin, (req, res) => {
  const userId = Number(req.params.userId);
  const user = queryOne('SELECT * FROM users WHERE id = ?', [userId]);
  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }

  const { name, email, applicationFee, paymentMode, newPassword } = req.body;
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
  const mode = paymentMode === 'one_time' ? 'one_time' : 'batch';

  if (newPassword && newPassword.trim().length >= 6) {
    const hash = bcrypt.hashSync(newPassword.trim(), 10);
    runSql(
      'UPDATE users SET name = ?, email = ?, application_fee = ?, payment_mode = ?, password = ? WHERE id = ?',
      [name, email, fee, mode, hash, userId]
    );
  } else {
    runSql(
      'UPDATE users SET name = ?, email = ?, application_fee = ?, payment_mode = ? WHERE id = ?',
      [name, email, fee, mode, userId]
    );
  }

  res.json({
    success: true,
    message: `User updated successfully (${mode === 'one_time' ? 'One-Time Payment' : '5-Batch Payment'}, fee ₹${fee.toFixed(2)})`
  });
});

// Get all users with application counts & payment stats
router.get('/users', requireAdmin, (req, res) => {
  const users = queryAll(`
    SELECT u.id, u.name, u.email, u.application_fee, u.wallet_balance, u.payment_mode, u.created_at,
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

// Admin tops up or adjusts candidate wallet balance
router.post('/users/:userId/wallet', requireAdmin, (req, res) => {
  const userId = Number(req.params.userId);
  const user = queryOne('SELECT id, name, wallet_balance FROM users WHERE id = ?', [userId]);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const { amount, type, note } = req.body;
  const numAmount = parseFloat(amount);
  if (!numAmount || isNaN(numAmount) || numAmount <= 0) {
    return res.status(400).json({ error: 'Valid amount is required' });
  }

  const currentBalance = Number(user.wallet_balance) || 0.00;
  const isCredit = type !== 'debit';
  const newBalance = isCredit ? currentBalance + numAmount : Math.max(0, currentBalance - numAmount);
  const actualDiff = isCredit ? numAmount : (currentBalance - newBalance);

  runSql('UPDATE users SET wallet_balance = ? WHERE id = ?', [newBalance, userId]);

  runSql(
    `INSERT INTO wallet_transactions (user_id, type, amount, balance_after, reference_id, description, status)
     VALUES (?, ?, ?, ?, 'ADMIN-ADJUST', ?, 'approved')`,
    [userId, isCredit ? 'credit' : 'debit', actualDiff, newBalance, note || (isCredit ? 'Admin Wallet Credit' : 'Admin Wallet Debit')]
  );

  res.json({
    success: true,
    message: `Wallet updated for ${user.name}: ${isCredit ? '+' : '-'}₹${numAmount.toFixed(2)}. New balance: ₹${newBalance.toFixed(2)}`,
    newBalance
  });
});

// Admin gets all wallet transactions
router.get('/wallet-transactions', requireAdmin, (req, res) => {
  const transactions = queryAll(`
    SELECT wt.id, wt.user_id, wt.type, wt.amount, wt.balance_after, wt.reference_id, wt.description, wt.receipt_url, wt.status, wt.created_at,
           u.name as user_name, u.email as user_email
    FROM wallet_transactions wt
    JOIN users u ON wt.user_id = u.id
    ORDER BY wt.id DESC
  `);

  res.json({ success: true, transactions });
});

// Admin gets all incoming Android bank/UPI events (claimed and unclaimed)
router.get('/bank-events', requireAdmin, (req, res) => {
  const events = queryAll(`
    SELECT be.id, be.utr, be.amount, be.sender_vpa, be.raw_text,
           be.used_by_user_id, be.used_for, be.created_at,
           u.name as claimed_user_name, u.email as claimed_user_email
    FROM bank_events be
    LEFT JOIN users u ON be.used_by_user_id = u.id
    ORDER BY be.id DESC
    LIMIT 300
  `);

  res.json({ success: true, events: events || [] });
});

// Get all applications across all users with user name and email (lightweight URLs)
router.get('/applications', requireAdmin, (req, res) => {
  const rawApps = queryAll(`
    SELECT a.id, a.user_id, a.application_number, a.date_of_birth, a.app_password,
           a.payment_status, a.payment_id, a.payment_amount, a.payment_method, a.paid_at,
           a.status, a.admin_remarks, a.submitted_at, a.reviewed_at,
           (a.photo_url IS NOT NULL AND a.photo_url != '') AS has_photo,
           (a.payment_screenshot_url IS NOT NULL AND a.payment_screenshot_url != '') AS has_receipt,
           (a.result_photo_url IS NOT NULL AND a.result_photo_url != '') AS has_result,
           u.name as user_name, u.email as user_email, u.application_fee
    FROM applications a
    JOIN users u ON a.user_id = u.id
    ORDER BY a.submitted_at DESC
  `);

  const applications = (rawApps || []).map(a => ({
    ...a,
    photo_url: a.has_photo ? `/api/media/${a.id}/photo` : '',
    payment_screenshot_url: a.has_receipt ? `/api/media/${a.id}/receipt` : '',
    result_photo_url: a.has_result ? `/api/media/${a.id}/result` : ''
  }));

  res.json({ applications });
});

// Get specific user's applications & profile details (lightweight URLs)
router.get('/users/:userId/applications', requireAdmin, (req, res) => {
  const user = queryOne('SELECT id, name, email, application_fee, created_at FROM users WHERE id = ?', [Number(req.params.userId)]);
  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }

  const rawApps = queryAll(`
    SELECT id, user_id, application_number, date_of_birth, app_password,
           payment_status, payment_id, payment_amount, payment_method, paid_at,
           status, admin_remarks, submitted_at, reviewed_at,
           (photo_url IS NOT NULL AND photo_url != '') AS has_photo,
           (payment_screenshot_url IS NOT NULL AND payment_screenshot_url != '') AS has_receipt,
           (result_photo_url IS NOT NULL AND result_photo_url != '') AS has_result
    FROM applications WHERE user_id = ? ORDER BY submitted_at DESC
  `, [Number(req.params.userId)]);

  const applications = (rawApps || []).map(a => ({
    ...a,
    photo_url: a.has_photo ? `/api/media/${a.id}/photo` : '',
    payment_screenshot_url: a.has_receipt ? `/api/media/${a.id}/receipt` : '',
    result_photo_url: a.has_result ? `/api/media/${a.id}/result` : ''
  }));

  res.json({ user, applications });
});

// Review or edit application (approve, reject, request correction, direct edit details)
router.put('/applications/:appId', requireAdmin, (req, res) => {
  const appId = Number(req.params.appId);
  const existing = queryOne('SELECT * FROM applications WHERE id = ?', [appId]);
  if (!existing) {
    return res.status(404).json({ error: 'Application not found' });
  }

  const { status, remarks, resultPhotoUrl, applicationNumber, dateOfBirth, appPassword, paymentId, paymentStatus, paymentAmount, paymentMethod } = req.body;

  const newStatus = status !== undefined ? status : existing.status;
  const newRemarks = remarks !== undefined ? remarks : (existing.admin_remarks || '');
  const newAppNum = applicationNumber !== undefined ? String(applicationNumber).trim() : existing.application_number;
  const newDob = dateOfBirth !== undefined ? String(dateOfBirth).trim() : existing.date_of_birth;
  const newPass = appPassword !== undefined ? String(appPassword).trim() : existing.app_password;
  const newResultPhotoUrl = resultPhotoUrl !== undefined ? resultPhotoUrl : (existing.result_photo_url || '');

  const newPaymentStatus = (paymentStatus === 'paid' || paymentStatus === 'unpaid') ? paymentStatus : existing.payment_status;
  let newPaymentId = paymentId !== undefined ? String(paymentId).trim() : (existing.payment_id || '');
  let newPaymentAmount = paymentAmount !== undefined ? Number(paymentAmount) : Number(existing.payment_amount || 0);
  let newPaymentMethod = paymentMethod !== undefined ? String(paymentMethod).trim() : (existing.payment_method || 'NONE');
  let newPaidAt = existing.paid_at || null;

  if (paymentStatus === 'paid') {
    if (!newPaymentId || newPaymentId === 'PENDING_BATCH_OF_5') {
      newPaymentId = 'ADMIN-PAID';
    }
    if (!newPaymentAmount || newPaymentAmount <= 0 || Number.isNaN(newPaymentAmount)) {
      const owner = queryOne('SELECT application_fee FROM users WHERE id = ?', [existing.user_id]);
      newPaymentAmount = owner && owner.application_fee ? Number(owner.application_fee) : 50.00;
    }
    if (!paymentMethod && (!newPaymentMethod || newPaymentMethod === 'NONE')) {
      newPaymentMethod = 'ADMIN_MARKED_PAID';
    }
    if (!newPaidAt) {
      newPaidAt = new Date().toISOString().replace('T', ' ').slice(0, 19);
    }
  } else if (paymentStatus === 'unpaid') {
    if (paymentId === undefined && (newPaymentId === 'ADMIN-PAID' || !newPaymentId)) {
      newPaymentId = 'PENDING_BATCH_OF_5';
    }
    if (!paymentMethod) {
      newPaymentMethod = 'NONE';
    }
    newPaidAt = null;
  }

  runSql(
    `UPDATE applications 
     SET status = ?, 
         admin_remarks = ?, 
         application_number = ?, 
         date_of_birth = ?, 
         app_password = ?, 
         payment_status = ?,
         payment_id = ?, 
         payment_amount = ?,
         payment_method = ?,
         paid_at = ?,
         result_photo_url = ?, 
         reviewed_at = CURRENT_TIMESTAMP 
     WHERE id = ?`,
    [newStatus, newRemarks, newAppNum, newDob, newPass, newPaymentStatus, newPaymentId, newPaymentAmount, newPaymentMethod, newPaidAt, newResultPhotoUrl, appId]
  );

  let message = `Application #${newAppNum} updated successfully`;
  if (paymentStatus === 'paid' && status === undefined) message = `Application #${newAppNum} marked as PAID (₹${Number(newPaymentAmount).toFixed(2)}, Ref: ${newPaymentId})`;
  else if (paymentStatus === 'unpaid' && status === undefined) message = `Application #${newAppNum} marked as UNPAID`;
  else if (status === 'correction') message = `Application #${newAppNum} sent for Candidate Correction`;
  else if (status === 'approved') message = `Application #${newAppNum} approved successfully`;
  else if (status === 'rejected') message = `Application #${newAppNum} rejected`;

  res.json({ success: true, message });
});

// Admin deletes an application
router.delete('/applications/:appId', requireAdmin, (req, res) => {
  const appId = Number(req.params.appId);
  const existing = queryOne('SELECT id, application_number FROM applications WHERE id = ?', [appId]);
  if (!existing) {
    return res.status(404).json({ error: 'Application not found' });
  }

  runSql('DELETE FROM applications WHERE id = ?', [appId]);
  res.json({
    success: true,
    message: `Application #${existing.application_number || appId} deleted successfully.`
  });
});

// Telegram Bot push alert settings
router.get('/settings/telegram', requireAdmin, (req, res) => {
  const rows = queryAll("SELECT key, value FROM system_settings WHERE key IN ('telegram_bot_token', 'telegram_chat_id', 'telegram_alerts_enabled')");
  const settings = {
    botToken: '',
    chatId: '',
    enabled: true
  };
  (rows || []).forEach(r => {
    if (r.key === 'telegram_bot_token') settings.botToken = r.value || '';
    if (r.key === 'telegram_chat_id') settings.chatId = r.value || '';
    if (r.key === 'telegram_alerts_enabled') settings.enabled = r.value !== '0';
  });
  res.json({ success: true, settings });
});

router.post('/settings/telegram', requireAdmin, async (req, res) => {
  const { botToken, chatId, enabled, isTest } = req.body;
  if (botToken !== undefined) {
    runSql('INSERT INTO system_settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at', ['telegram_bot_token', String(botToken).trim()]);
  }
  if (chatId !== undefined) {
    runSql('INSERT INTO system_settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at', ['telegram_chat_id', String(chatId).trim()]);
  }
  if (enabled !== undefined) {
    runSql('INSERT INTO system_settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at', ['telegram_alerts_enabled', enabled ? '1' : '0']);
  }
  if (isTest) {
    const activeToken = String(botToken || '').trim();
    const activeChatId = String(chatId || '').trim();
    if (!activeToken || !activeChatId) {
      return res.status(400).json({ error: 'Please enter both Bot Token and Chat ID to send test alert.' });
    }
    const testMsg = `🔔 <b>KP CYBER — TEST NOTIFICATION</b>\n━━━━━━━━━━━━━━━━━━\n✅ <b>Telegram Bot connection successful!</b>\n⏰ <b>Time:</b> ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}\n⚡ You will now receive instant push alerts whenever candidates submit applications or add money to their wallet!`;
    try {
      const response = await fetch(`https://api.telegram.org/bot${activeToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: activeChatId,
          text: testMsg,
          parse_mode: 'HTML',
          disable_web_page_preview: true
        })
      });
      const data = await response.json();
      if (!response.ok || !data.ok) {
        let errDesc = data.description || 'Invalid Bot Token or Chat ID';
        if (errDesc.includes('chat not found')) {
          errDesc = '⚠️ Chat not found: Please open your bot in Telegram and tap the "START" button (or send /start) first, then click "Send Test Alert" again!';
        }
        return res.status(400).json({ error: errDesc });
      }
      return res.json({ success: true, message: '🎉 Test message sent to your Telegram successfully! Check your phone.' });
    } catch (e) {
      return res.status(500).json({ error: 'Failed to contact Telegram API: ' + e.message });
    }
  }
  res.json({ success: true, message: 'Telegram alert settings saved successfully.' });
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
