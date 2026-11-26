const express = require('express');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { queryAll, queryOne, runSql } = require('../db');

const router = express.Router();

const pdfUploadDir = path.join(__dirname, '..', 'public', 'uploads');
if (!fs.existsSync(pdfUploadDir)) {
  fs.mkdirSync(pdfUploadDir, { recursive: true });
}
const pdfUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, pdfUploadDir),
    filename: (req, file, cb) => cb(null, `llpdf-${Date.now()}-${Math.round(Math.random() * 1e9)}.pdf`)
  }),
  limits: { fileSize: 15 * 1024 * 1024 }
});

function requireAdmin(req, res, next) {
  if (!req.session.adminId) {
    return res.status(401).json({ error: 'Admin access required' });
  }
  next();
}

// Admin creates new user account with customized Application Fee
router.post('/users', requireAdmin, (req, res) => {
  const { name, email, password, applicationFee, llPdfFee, paymentMode, telegramChatId } = req.body;
  if (!name || !email || !password) {
    return res.status(400).json({ error: 'Name, email, and password are required' });
  }

  const existing = queryOne('SELECT id FROM users WHERE email = ?', [email]);
  if (existing) {
    return res.status(409).json({ error: 'User with this email already exists' });
  }

  const fee = parseFloat(applicationFee) > 0 ? parseFloat(applicationFee) : 50.00;
  const pdfFee = parseFloat(llPdfFee) >= 0 ? parseFloat(llPdfFee) : 20.00;
  const mode = paymentMode === 'one_time' ? 'one_time' : 'batch';
  const tgChatId = telegramChatId ? String(telegramChatId).trim() : '';
  const hash = bcrypt.hashSync(password, 10);
  const newUserId = runSql(
    'INSERT INTO users (name, email, password, application_fee, ll_pdf_fee, payment_mode, telegram_chat_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [name, email, hash, fee, pdfFee, mode, tgChatId]
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

  const { name, email, applicationFee, llPdfFee, paymentMode, telegramChatId, newPassword } = req.body;
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
  const pdfFee = parseFloat(llPdfFee) >= 0 ? parseFloat(llPdfFee) : (user.ll_pdf_fee ?? 20.00);
  const mode = paymentMode === 'one_time' ? 'one_time' : 'batch';
  const tgChatId = telegramChatId !== undefined ? String(telegramChatId).trim() : (user.telegram_chat_id || '');

  if (newPassword && newPassword.trim().length >= 6) {
    const hash = bcrypt.hashSync(newPassword.trim(), 10);
    runSql(
      'UPDATE users SET name = ?, email = ?, application_fee = ?, ll_pdf_fee = ?, payment_mode = ?, telegram_chat_id = ?, password = ? WHERE id = ?',
      [name, email, fee, pdfFee, mode, tgChatId, hash, userId]
    );
  } else {
    runSql(
      'UPDATE users SET name = ?, email = ?, application_fee = ?, ll_pdf_fee = ?, payment_mode = ?, telegram_chat_id = ? WHERE id = ?',
      [name, email, fee, pdfFee, mode, tgChatId, userId]
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
    SELECT u.id, u.name, u.email, u.application_fee, u.ll_pdf_fee, u.wallet_balance, u.payment_mode, u.telegram_chat_id, u.created_at,
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

// Admin deletes a bank_events UTR record
router.delete('/bank-events/:id', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const existing = queryOne('SELECT id, utr FROM bank_events WHERE id = ?', [id]);
  if (!existing) return res.status(404).json({ error: 'Bank UTR event not found' });
  runSql('DELETE FROM bank_events WHERE id = ?', [id]);
  res.json({ success: true, message: `Bank UTR "${existing.utr}" deleted.` });
});

// Admin deletes a wallet transaction (and reverses credit balance if applicable)
router.delete('/wallet-transactions/:id', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const tx = queryOne('SELECT id, user_id, type, amount, reference_id FROM wallet_transactions WHERE id = ?', [id]);
  if (!tx) return res.status(404).json({ error: 'Wallet transaction not found' });

  if (tx.type === 'credit' && Number(tx.amount) > 0) {
    const user = queryOne('SELECT wallet_balance FROM users WHERE id = ?', [tx.user_id]);
    const curBal = user ? Number(user.wallet_balance || 0) : 0;
    const newBal = Math.max(0, curBal - Number(tx.amount));
    runSql('UPDATE users SET wallet_balance = ? WHERE id = ?', [newBal, tx.user_id]);
  }

  if (tx.reference_id && tx.reference_id !== 'ADMIN-ADJUST') {
    runSql('UPDATE bank_events SET used_by_user_id = NULL, used_for = NULL WHERE utr = ? AND used_by_user_id = ?', [tx.reference_id, tx.user_id]);
  }

  runSql('DELETE FROM wallet_transactions WHERE id = ?', [id]);
  res.json({ success: true, message: `Transaction (Ref: ${tx.reference_id || id}) deleted.` });
});

// Admin clears a UTR from paid applications
router.post('/applications/clear-utr', requireAdmin, (req, res) => {
  const userId = Number(req.body.userId);
  const utr = String(req.body.utr || '').trim();
  if (!userId || !utr) return res.status(400).json({ error: 'userId and utr are required' });

  runSql(
    `UPDATE applications SET payment_status = 'unpaid', payment_id = 'PENDING_BATCH_OF_5', payment_method = 'NONE', paid_at = NULL WHERE user_id = ? AND payment_id = ?`,
    [userId, utr]
  );
  runSql('UPDATE bank_events SET used_by_user_id = NULL, used_for = NULL WHERE utr = ? AND used_by_user_id = ?', [utr, userId]);

  res.json({ success: true, message: `UTR "${utr}" cleared and application(s) marked unpaid.` });
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

  // Send automatic Telegram update to the customer if their Chat ID is linked
  const shouldNotifyCustomer =
    status !== undefined &&
    (status !== existing.status || (status === 'approved' && resultPhotoUrl !== undefined));

  if (shouldNotifyCustomer && ['approved', 'correction', 'rejected'].includes(newStatus)) {
    try {
      const customer = queryOne('SELECT name, telegram_chat_id FROM users WHERE id = ?', [existing.user_id]);
      if (customer && customer.telegram_chat_id) {
        const rows = queryAll("SELECT key, value FROM system_settings WHERE key IN ('telegram_bot_token', 'telegram_alerts_enabled')");
        const map = {};
        (rows || []).forEach(r => { map[r.key] = r.value; });
        if (map.telegram_alerts_enabled !== '0' && map.telegram_bot_token) {
          const esc = s => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
          const escRem = newRemarks ? `\n📝 <b>Remarks:</b> ${esc(newRemarks)}` : '';
          let custMsg = '';
          if (newStatus === 'approved') {
            custMsg = `✅ <b>KP CYBER — APPLICATION APPROVED!</b>\n━━━━━━━━━━━━━━━━━━\n👤 <b>Candidate:</b> ${esc(customer.name)}\n📝 <b>App Number:</b> <code>${esc(newAppNum)}</code>${escRem}\n📄 Check your dashboard to view/download your result!\n🔗 <a href="https://portal-2a3.pages.dev">Open Portal</a>`;
          } else if (newStatus === 'correction') {
            custMsg = `⚠️ <b>KP CYBER — CORRECTION NEEDED</b>\n━━━━━━━━━━━━━━━━━━\n👤 <b>Candidate:</b> ${esc(customer.name)}\n📝 <b>App Number:</b> <code>${esc(newAppNum)}</code>${escRem}\n✏️ Please log in to edit and resubmit.`;
          } else if (newStatus === 'rejected') {
            custMsg = `❌ <b>KP CYBER — APPLICATION REJECTED</b>\n━━━━━━━━━━━━━━━━━━\n👤 <b>Candidate:</b> ${esc(customer.name)}\n📝 <b>App Number:</b> <code>${esc(newAppNum)}</code>${escRem}`;
          }
          if (custMsg) {
            fetch(`https://api.telegram.org/bot${map.telegram_bot_token}/sendMessage`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                chat_id: String(customer.telegram_chat_id).trim(),
                text: custMsg,
                parse_mode: 'HTML',
                disable_web_page_preview: true
              })
            }).catch(() => {});
          }
        }
      }
    } catch (e) {}
  }

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

// Admin Portal Shutdown / Resume Work toggle
router.get('/settings/shutdown', requireAdmin, (req, res) => {
  const rows = queryAll("SELECT key, value FROM system_settings WHERE key IN ('portal_shutdown', 'portal_shutdown_message')");
  const map = {};
  (rows || []).forEach(r => { map[r.key] = r.value; });
  res.json({
    success: true,
    isShutdown: map.portal_shutdown === '1',
    message: (map.portal_shutdown_message || '').trim() || 'Portal is temporarily closed by Admin. Work is paused—please check back later.'
  });
});

router.post('/settings/shutdown', requireAdmin, (req, res) => {
  const isShutdown = !!req.body.isShutdown;
  const customMessage = req.body.message !== undefined ? String(req.body.message).trim() : undefined;

  runSql(
    'INSERT INTO system_settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
    ['portal_shutdown', isShutdown ? '1' : '0']
  );

  if (customMessage !== undefined) {
    runSql(
      'INSERT INTO system_settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
      ['portal_shutdown_message', customMessage]
    );
  }

  res.json({
    success: true,
    isShutdown,
    message: customMessage || 'Portal is temporarily closed by Admin. Work is paused—please check back later.',
    statusText: isShutdown
      ? '🔴 Portal is now SHUT DOWN. All user logins, submissions, and top-ups are stopped.'
      : '🟢 Portal is now ONLINE. Users can work normally.'
  });
});

// Admin LL PDF Requests management
router.get('/ll-pdf', requireAdmin, (req, res) => {
  const requests = queryAll(`
    SELECT r.id, r.user_id, r.application_number, r.fee_amount, r.status, r.pdf_url, r.admin_remarks,
           r.created_at, r.completed_at,
           u.name as user_name, u.email as user_email, u.telegram_chat_id
    FROM ll_pdf_requests r
    JOIN users u ON r.user_id = u.id
    ORDER BY r.id DESC
  `);
  res.json({ success: true, requests: requests || [] });
});

router.put('/ll-pdf/:id', requireAdmin, pdfUpload.single('pdf'), (req, res) => {
  const reqId = Number(req.params.id);
  const existing = queryOne('SELECT * FROM ll_pdf_requests WHERE id = ?', [reqId]);
  if (!existing) return res.status(404).json({ error: 'LL PDF request not found' });

  let status = req.body.status || existing.status;
  const remarks = req.body.remarks !== undefined ? String(req.body.remarks).trim() : (existing.admin_remarks || '');
  let pdfUrl = req.body.pdfUrl || existing.pdf_url || '';

  if (req.file) {
    pdfUrl = '/uploads/' + req.file.filename;
    status = 'completed';
  }

  let refundedAmount = 0;
  if (status === 'rejected' && existing.status === 'pending' && Number(existing.fee_amount) > 0) {
    const userRow = queryOne('SELECT wallet_balance FROM users WHERE id = ?', [existing.user_id]);
    const curBal = userRow ? Number(userRow.wallet_balance || 0) : 0;
    refundedAmount = Number(existing.fee_amount);
    const newBal = curBal + refundedAmount;
    runSql('UPDATE users SET wallet_balance = ? WHERE id = ?', [newBal, existing.user_id]);
    runSql(
      `INSERT INTO wallet_transactions (user_id, type, amount, balance_after, reference_id, description, status)
       VALUES (?, 'credit', ?, ?, ?, ?, 'approved')`,
      [existing.user_id, refundedAmount, newBal, existing.application_number, `Refund: LL PDF #${existing.application_number} Rejected`]
    );
  }

  runSql(
    'UPDATE ll_pdf_requests SET status = ?, pdf_url = ?, admin_remarks = ?, completed_at = CURRENT_TIMESTAMP WHERE id = ?',
    [status, pdfUrl, remarks, reqId]
  );

  res.json({
    success: true,
    status,
    pdfUrl,
    message: status === 'completed'
      ? `📄 LL PDF uploaded & sent for #${existing.application_number}!`
      : (status === 'rejected'
        ? `❌ Request #${existing.application_number} rejected and ₹${refundedAmount.toFixed(2)} refunded to wallet.`
        : `Request #${existing.application_number} updated.`)
  });
});

router.delete('/ll-pdf/:id', requireAdmin, (req, res) => {
  const reqId = Number(req.params.id);
  const existing = queryOne('SELECT id, application_number FROM ll_pdf_requests WHERE id = ?', [reqId]);
  if (!existing) return res.status(404).json({ error: 'LL PDF request not found' });
  runSql('DELETE FROM ll_pdf_requests WHERE id = ?', [reqId]);
  res.json({ success: true, message: `LL PDF request #${existing.application_number} deleted.` });
});

// Admin Notice / Announcement Popup Settings
router.get('/settings/notice', requireAdmin, (req, res) => {
  const rows = queryAll("SELECT key, value FROM system_settings WHERE key IN ('portal_notice_enabled', 'portal_notice_title', 'portal_notice_message', 'portal_notice_version')");
  const map = {};
  (rows || []).forEach(r => { map[r.key] = r.value; });
  res.json({
    success: true,
    notice: {
      enabled: map.portal_notice_enabled === '1' && !!(map.portal_notice_message || '').trim(),
      title: (map.portal_notice_title || '').trim() || '📢 Important Update',
      message: (map.portal_notice_message || '').trim(),
      version: map.portal_notice_version || '1'
    }
  });
});

router.post('/settings/notice', requireAdmin, (req, res) => {
  const enabled = !!req.body.enabled;
  const title = String(req.body.title || '📢 Important Update').trim();
  const message = String(req.body.message || '').trim();
  const version = String(Date.now());

  if (enabled && !message) {
    return res.status(400).json({ error: 'Please enter a notice message before publishing.' });
  }

  const entries = [
    ['portal_notice_enabled', enabled ? '1' : '0'],
    ['portal_notice_title', title],
    ['portal_notice_message', message],
    ['portal_notice_version', version]
  ];
  for (const [k, v] of entries) {
    runSql(
      'INSERT INTO system_settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
      [k, v]
    );
  }

  res.json({
    success: true,
    notice: { enabled, title, message, version },
    statusText: enabled
      ? '📢 Notice published! All users will see this popup on their dashboard.'
      : '🔕 Notice popup turned off.'
  });
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
