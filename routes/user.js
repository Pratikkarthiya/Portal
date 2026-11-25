const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { queryAll, queryOne, runSql } = require('../db');

const router = express.Router();

const uploadDir = path.join(__dirname, '..', 'public', 'uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, uploadDir);
  },
  filename: function (req, file, cb) {
    const prefix = file.fieldname === 'paymentScreenshot' ? 'receipt-' : 'photo-';
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    const ext = path.extname(file.originalname).toLowerCase() || '.jpg';
    cb(null, prefix + uniqueSuffix + ext);
  }
});

const upload = multer({
  storage: storage,
  limits: { fileSize: 12 * 1024 * 1024 }, // 12 MB max (supports 10MB photo upload)
  fileFilter: (req, file, cb) => {
    const filetypes = /jpeg|jpg|png|webp|gif/;
    const mimetype = filetypes.test(file.mimetype);
    const extname = filetypes.test(path.extname(file.originalname).toLowerCase());
    if (mimetype && extname) {
      return cb(null, true);
    }
    cb(new Error('Only image files (JPEG, PNG, WEBP, GIF) are allowed'));
  }
});

// Configure upload to accept both 'photo' and optional 'paymentScreenshot'
const multiUpload = upload.fields([
  { name: 'photo', maxCount: 1 },
  { name: 'paymentScreenshot', maxCount: 1 }
]);

function requireUser(req, res, next) {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'Please log in first' });
  }
  next();
}

function rejectIfShutdown(req, res, next) {
  try {
    const rows = queryAll("SELECT key, value FROM system_settings WHERE key IN ('portal_shutdown', 'portal_shutdown_message')");
    const map = {};
    (rows || []).forEach(r => { map[r.key] = r.value; });
    if (map.portal_shutdown === '1') {
      return res.status(503).json({
        error: (map.portal_shutdown_message || '').trim() || 'Portal is temporarily closed by Admin. Work is paused—please check back later.',
        portalShutdown: true
      });
    }
  } catch (e) {}
  next();
}

function escapeTgHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function sendTelegramAlertNode(messageHtml) {
  try {
    const rows = queryAll("SELECT key, value FROM system_settings WHERE key IN ('telegram_bot_token', 'telegram_chat_id', 'telegram_alerts_enabled')");
    const map = {};
    (rows || []).forEach(r => { map[r.key] = r.value; });
    if (map.telegram_alerts_enabled === '0') return;
    const token = map.telegram_bot_token;
    const chatId = map.telegram_chat_id;
    if (!token || !chatId) return;

    let resp = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: messageHtml,
        parse_mode: 'HTML',
        disable_web_page_preview: true
      })
    });
    if (!resp.ok) {
      const errJson = await resp.json().catch(() => ({}));
      if (errJson?.description && errJson.description.toLowerCase().includes('entities')) {
        const plainText = messageHtml.replace(/<[^>]+>/g, '');
        await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: chatId,
            text: plainText,
            disable_web_page_preview: true
          })
        });
      }
    }
  } catch (err) {
    console.error('Telegram notification error:', err);
  }
}

/**
 * 1. Get user's current batch status (how many pending unpaid applications in current 5-slot batch)
 */
router.get('/batch-status', requireUser, (req, res) => {
  const user = queryOne('SELECT id, name, application_fee FROM users WHERE id = ?', [req.session.userId]);
  const feePerApp = user && user.application_fee ? user.application_fee : 50.00;

  const unpaidApps = queryAll(
    'SELECT id, application_number, submitted_at FROM applications WHERE user_id = ? AND payment_status = "unpaid" ORDER BY id ASC',
    [req.session.userId]
  );

  const unpaidCount = unpaidApps.length;
  const isPaymentDue = unpaidCount >= 4;
  const batchTotal = isPaymentDue ? (feePerApp * 5) : 0;

  res.json({
    feePerApp: feePerApp,
    unpaidCount: unpaidCount,
    slotInBatch: (unpaidCount % 5) + 1,
    requiresPaymentOnNext: unpaidCount === 4,
    hasDueBatch: unpaidCount >= 5,
    unpaidApps: unpaidApps,
    batchTotal: feePerApp * 5
  });
});

/**
 * 2. Submit application:
 * - Applications 1 to 4 in a cycle: Submit directly with status 'unpaid' (NO payment required).
 * - Application 5 in a cycle: Requires Bank UTR and optional/recommended payment screenshot for all 5.
 */
router.post('/applications', requireUser, rejectIfShutdown, (req, res) => {
  multiUpload(req, res, function (err) {
    if (err) {
      return res.status(400).json({ error: err.message });
    }

    const { applicationNumber, dateOfBirth, appPassword, utrNumber } = req.body;
    if (!applicationNumber || !dateOfBirth || !appPassword) {
      return res.status(400).json({ error: 'Application number, date of birth, and password are required' });
    }

    if (!req.files || !req.files['photo'] || req.files['photo'].length === 0) {
      return res.status(400).json({ error: 'An applicant photo upload is required' });
    }

    const user = queryOne('SELECT id, name, email, application_fee, wallet_balance, payment_mode FROM users WHERE id = ?', [req.session.userId]);
    const feePerApp = user && user.application_fee ? user.application_fee : 50.00;
    const walletBalance = user && user.wallet_balance ? Number(user.wallet_balance) : 0.00;
    const paymentMode = user && user.payment_mode ? user.payment_mode : 'batch';
    const candidateLabel = user ? `${escapeTgHtml(user.name)} (${escapeTgHtml(user.email)})` : `User #${req.session.userId}`;
    const timeNow = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
    const photoUrl = '/uploads/' + req.files['photo'][0].filename;

    let screenshotUrl = '';
    if (req.files['paymentScreenshot'] && req.files['paymentScreenshot'].length > 0) {
      screenshotUrl = '/uploads/' + req.files['paymentScreenshot'][0].filename;
    }

    // PREPAID WALLET CHECK: If user has enough balance, auto-pay instantly from wallet
    if (walletBalance >= feePerApp) {
      const newBalance = walletBalance - feePerApp;
      runSql('UPDATE users SET wallet_balance = ? WHERE id = ?', [newBalance, req.session.userId]);

      runSql(
        `INSERT INTO wallet_transactions (user_id, type, amount, balance_after, reference_id, description, status) 
         VALUES (?, 'debit', ?, ?, ?, ?, 'approved')`,
        [req.session.userId, feePerApp, newBalance, applicationNumber, `Application #${applicationNumber} Fee Auto-Deduct`]
      );

      const appId = runSql(
        `INSERT INTO applications 
         (user_id, application_number, date_of_birth, app_password, photo_url, payment_status, payment_id, payment_screenshot_url, payment_amount, payment_method, paid_at) 
         VALUES (?, ?, ?, ?, ?, 'paid', 'WALLET-PAID', '', ?, 'WALLET_BALANCE', CURRENT_TIMESTAMP)`,
        [req.session.userId, applicationNumber, dateOfBirth, appPassword, photoUrl, feePerApp]
      );

      sendTelegramAlertNode(`🔔 <b>KP CYBER — APPLICATION SUBMITTED!</b>\n━━━━━━━━━━━━━━━━━━\n👤 <b>Candidate:</b> ${candidateLabel}\n📝 <b>App Number:</b> <code>${escapeTgHtml(applicationNumber)}</code>\n🎂 <b>DOB:</b> ${escapeTgHtml(dateOfBirth)}\n🔑 <b>Password:</b> <code>${escapeTgHtml(appPassword)}</code>\n💳 <b>Fee:</b> ₹${feePerApp.toFixed(2)} (⚡ Paid from Wallet)\n🏦 <b>Wallet Balance:</b> ₹${newBalance.toFixed(2)}\n⏰ <b>Time:</b> ${timeNow}\n🔗 <a href="https://kpcyber.in/admin">Open Admin Review</a>`).catch(() => {});

      return res.json({
        success: true,
        message: `🎉 Application submitted & paid from Wallet! ₹${feePerApp.toFixed(2)} deducted. Wallet balance: ₹${newBalance.toFixed(2)}.`,
        paidFromWallet: true,
        walletBalance: newBalance,
        applicationId: appId
      });
    }

    // =========================================================
    // PLAN TYPE 1: ONE-TIME PAYMENT (PAY EACH TIME / PER APPLICATION)
    // =========================================================
    if (paymentMode === 'one_time') {
      if (!utrNumber || utrNumber.trim().length < 6) {
        return res.status(400).json({
          error: `Payment required: ₹${feePerApp.toFixed(2)} for this application. Please pay via UPI or enter your Bank UTR.`,
          requiresPayment: true,
          isOneTimePayment: true,
          amountDue: feePerApp,
          paymentMode: 'one_time'
        });
      }

      const cleanUtr = utrNumber.trim();
      const bankEvent = queryOne('SELECT id, amount, used_by_user_id FROM bank_events WHERE utr = ?', [cleanUtr]);

      if (!bankEvent) {
        return res.status(400).json({
          error: `❌ Payment Failed: UTR "${cleanUtr}" is invalid or not received by bank. Please transfer ₹${feePerApp.toFixed(2)} to UPI ID pratikkarthiya6@oksbi and enter the genuine 12-digit UTR.`,
          requiresPayment: true,
          isOneTimePayment: true,
          amountDue: feePerApp,
          paymentMode: 'one_time'
        });
      }

      if (bankEvent.used_by_user_id) {
        return res.status(400).json({
          error: `❌ Payment Rejected: UTR "${cleanUtr}" has already been used by another transaction.`,
          requiresPayment: true,
          isOneTimePayment: true,
          amountDue: feePerApp,
          paymentMode: 'one_time'
        });
      }

      if (Number(bankEvent.amount) < feePerApp) {
        return res.status(400).json({
          error: `❌ Amount Mismatch: Bank received ₹${Number(bankEvent.amount).toFixed(2)}, which is less than the required ₹${feePerApp.toFixed(2)}.`,
          requiresPayment: true,
          isOneTimePayment: true,
          amountDue: feePerApp,
          paymentMode: 'one_time'
        });
      }

      runSql('UPDATE bank_events SET used_by_user_id = ?, used_for = "application_onetime" WHERE id = ?', [req.session.userId, bankEvent.id]);

      const appId = runSql(
        `INSERT INTO applications 
         (user_id, application_number, date_of_birth, app_password, photo_url, payment_status, payment_id, payment_screenshot_url, payment_amount, payment_method, paid_at) 
         VALUES (?, ?, ?, ?, ?, 'paid', ?, ?, ?, 'UPI_ONETIME_PAYMENT', CURRENT_TIMESTAMP)`,
        [req.session.userId, applicationNumber, dateOfBirth, appPassword, photoUrl, cleanUtr, screenshotUrl, feePerApp]
      );

      sendTelegramAlertNode(`🔔 <b>KP CYBER — ONE-TIME APPLICATION PAID!</b>\n━━━━━━━━━━━━━━━━━━\n👤 <b>Candidate:</b> ${candidateLabel}\n📝 <b>App Number:</b> <code>${escapeTgHtml(applicationNumber)}</code>\n🎂 <b>DOB:</b> ${escapeTgHtml(dateOfBirth)}\n🔑 <b>Password:</b> <code>${escapeTgHtml(appPassword)}</code>\n💵 <b>Fee Paid:</b> ₹${feePerApp.toFixed(2)}\n🧾 <b>Verified UTR:</b> <code>${escapeTgHtml(cleanUtr)}</code>\n⏰ <b>Time:</b> ${timeNow}\n🔗 <a href="https://kpcyber.in/admin">Open Admin Review</a>`).catch(() => {});

      return res.json({
        success: true,
        message: `🎉 Application submitted & paid! (Fee: ₹${feePerApp.toFixed(2)}, UTR: ${cleanUtr}).`,
        isOneTimePayment: true,
        totalPaid: feePerApp,
        utr: cleanUtr,
        applicationId: appId
      });
    }

    // =========================================================
    // PLAN TYPE 2: 5-APPLICATION BATCH PAYMENT
    // =========================================================

    const unpaidApps = queryAll(
      'SELECT id FROM applications WHERE user_id = ? AND payment_status = "unpaid" ORDER BY id ASC',
      [req.session.userId]
    );

    const currentUnpaidCount = unpaidApps.length;

    // If there are already 4 unpaid applications, this 5th submission MUST include the UTR & payment info
    if (currentUnpaidCount === 4) {
      if (!utrNumber || utrNumber.trim().length < 6) {
        return res.status(400).json({
          error: 'Payment required! This is your 5th application. Please pay the 5-application batch fee and provide the Bank UTR number.',
          requiresPayment: true,
          unpaidCount: currentUnpaidCount,
          batchTotal: feePerApp * 5
        });
      }

      const cleanUtr = utrNumber.trim();
      const batchAmount = feePerApp * 5;

      // 1. Insert the 5th application as paid with screenshot
      const fifthAppId = runSql(
        `INSERT INTO applications 
         (user_id, application_number, date_of_birth, app_password, photo_url, payment_status, payment_id, payment_screenshot_url, payment_amount, payment_method, paid_at) 
         VALUES (?, ?, ?, ?, ?, 'paid', ?, ?, ?, 'UPI_MANUAL_UTR_BATCH5', CURRENT_TIMESTAMP)`,
        [req.session.userId, applicationNumber, dateOfBirth, appPassword, photoUrl, cleanUtr, screenshotUrl, feePerApp]
      );

      // 2. Mark previous 4 unpaid applications as paid with the same batch UTR and screenshot
      for (const oldApp of unpaidApps) {
        runSql(
          `UPDATE applications 
           SET payment_status = 'paid', payment_id = ?, payment_screenshot_url = ?, payment_amount = ?, payment_method = 'UPI_MANUAL_UTR_BATCH5', paid_at = CURRENT_TIMESTAMP 
           WHERE id = ?`,
          [cleanUtr, screenshotUrl, feePerApp, oldApp.id]
        );
      }

      sendTelegramAlertNode(`🎉 <b>KP CYBER — BATCH OF 5 PAID & SETTLED!</b>\n━━━━━━━━━━━━━━━━━━\n👤 <b>Candidate:</b> ${candidateLabel}\n📝 <b>Final App (5/5):</b> <code>${escapeTgHtml(applicationNumber)}</code>\n💰 <b>Total Batch Paid:</b> ₹${batchAmount.toFixed(2)}\n🧾 <b>Verified UTR:</b> <code>${escapeTgHtml(cleanUtr)}</code>\n⏰ <b>Time:</b> ${timeNow}\n🔗 <a href="https://kpcyber.in/admin">Open Admin Review</a>`).catch(() => {});

      return res.json({
        success: true,
        message: `🎉 Batch payment verified! All 5 applications (Total ₹${batchAmount.toFixed(2)}) marked paid with UTR: ${cleanUtr}.`,
        isBatchPayment: true,
        totalPaid: batchAmount,
        utr: cleanUtr,
        paymentScreenshotUrl: screenshotUrl,
        applicationId: fifthAppId
      });
    }

    // Applications 1, 2, 3, or 4 of the 5-batch -> SUBMITS IMMEDIATELY WITHOUT PAYMENT
    const appId = runSql(
      `INSERT INTO applications 
       (user_id, application_number, date_of_birth, app_password, photo_url, payment_status, payment_id, payment_screenshot_url, payment_amount, payment_method) 
       VALUES (?, ?, ?, ?, ?, 'unpaid', 'PENDING_BATCH_OF_5', '', ?, 'NONE')`,
      [req.session.userId, applicationNumber, dateOfBirth, appPassword, photoUrl, feePerApp]
    );

    const slotNumber = currentUnpaidCount + 1;

    sendTelegramAlertNode(`📝 <b>KP CYBER — APPLICATION SUBMITTED (Slot ${slotNumber}/5)</b>\n━━━━━━━━━━━━━━━━━━\n👤 <b>Candidate:</b> ${candidateLabel}\n📝 <b>App Number:</b> <code>${escapeTgHtml(applicationNumber)}</code>\n🎂 <b>DOB:</b> ${escapeTgHtml(dateOfBirth)}\n🔑 <b>Password:</b> <code>${escapeTgHtml(appPassword)}</code>\n📦 <b>Batch Progress:</b> ${slotNumber} of 5 submitted\n⏰ <b>Time:</b> ${timeNow}\n🔗 <a href="https://kpcyber.in/admin">Open Admin Review</a>`).catch(() => {});
    res.json({
      success: true,
      message: `Application #${slotNumber} submitted successfully! No payment needed now (payment required after every 5 applications).`,
      isBatchPayment: false,
      slotNumber: slotNumber,
      remainingUntilPayment: 5 - slotNumber,
      applicationId: appId
    });
  });
});

// Get user's applications (lightweight URLs)
router.get('/applications', requireUser, (req, res) => {
  const rawApps = queryAll(
    `SELECT id, application_number, date_of_birth, app_password,
            payment_status, payment_id, payment_amount, payment_method, paid_at,
            status, admin_remarks, submitted_at, reviewed_at,
            (photo_url IS NOT NULL AND photo_url != '') AS has_photo,
            (payment_screenshot_url IS NOT NULL AND payment_screenshot_url != '') AS has_receipt,
            (result_photo_url IS NOT NULL AND result_photo_url != '') AS has_result
     FROM applications WHERE user_id = ? ORDER BY submitted_at DESC`,
    [req.session.userId]
  );

  const apps = (rawApps || []).map(a => ({
    ...a,
    photo_url: a.has_photo ? `/api/media/${a.id}/photo` : '',
    payment_screenshot_url: a.has_receipt ? `/api/media/${a.id}/receipt` : '',
    result_photo_url: a.has_result ? `/api/media/${a.id}/result` : ''
  }));

  res.json({ applications: apps });
});

// Candidate corrects and resubmits application
router.put('/applications/:appId', requireUser, rejectIfShutdown, (req, res) => {
  const appId = Number(req.params.appId);
  const app = queryOne('SELECT id, user_id, status FROM applications WHERE id = ? AND user_id = ?', [appId, req.session.userId]);
  if (!app) {
    return res.status(404).json({ error: 'Application not found or unauthorized' });
  }

  const { applicationNumber, dateOfBirth, appPassword, photoUrl } = req.body;
  if (!applicationNumber || !dateOfBirth || !appPassword) {
    return res.status(400).json({ error: 'Application number, date of birth, and password are required' });
  }

  const cleanAppNum = String(applicationNumber).trim();
  const cleanDob = String(dateOfBirth).trim();
  const cleanPass = String(appPassword).trim();

  if (photoUrl && photoUrl.trim()) {
    runSql(
      `UPDATE applications 
       SET application_number = ?, date_of_birth = ?, app_password = ?, photo_url = ?, status = 'pending', admin_remarks = 'Resubmitted with corrections by candidate.', submitted_at = CURRENT_TIMESTAMP
       WHERE id = ? AND user_id = ?`,
      [cleanAppNum, cleanDob, cleanPass, photoUrl.trim(), appId, req.session.userId]
    );
  } else {
    runSql(
      `UPDATE applications 
       SET application_number = ?, date_of_birth = ?, app_password = ?, status = 'pending', admin_remarks = 'Resubmitted with corrections by candidate.', submitted_at = CURRENT_TIMESTAMP
       WHERE id = ? AND user_id = ?`,
      [cleanAppNum, cleanDob, cleanPass, appId, req.session.userId]
    );
  }

  res.json({
    success: true,
    message: `Application #${cleanAppNum} corrected and resubmitted successfully! It is now pending admin review.`
  });
});

/**
 * 4. Candidate Wallet: Get Balance & Transactions
 */
router.get('/wallet', requireUser, (req, res) => {
  const user = queryOne('SELECT id, name, email, application_fee, wallet_balance FROM users WHERE id = ?', [req.session.userId]);
  const transactions = queryAll(
    'SELECT id, type, amount, balance_after, reference_id, description, receipt_url, status, created_at FROM wallet_transactions WHERE user_id = ? ORDER BY id DESC',
    [req.session.userId]
  );

  res.json({
    success: true,
    walletBalance: user && user.wallet_balance ? user.wallet_balance : 0.00,
    applicationFee: user && user.application_fee ? user.application_fee : 50.00,
    transactions: transactions || []
  });
});

/**
 * 5. Candidate Wallet: Top-up Balance via UPI (handles both /wallet/topup and /wallet)
 */
function handleWalletTopup(req, res) {
  const amount = parseFloat(req.body.amount || '0');
  const utrNumber = (req.body.utrNumber || '').trim();
  const receiptUrl = req.file ? '/uploads/' + req.file.filename : (req.body.receiptUrl || '');

  if (!amount || amount < 10) {
    return res.status(400).json({ error: 'Minimum wallet top-up amount is ₹10.00' });
  }

  if (!utrNumber || utrNumber.length < 6) {
    return res.status(400).json({ error: 'Please enter your 12-digit Bank UTR / Transaction Reference ID' });
  }

  const user = queryOne('SELECT wallet_balance FROM users WHERE id = ?', [req.session.userId]);
  const currentBalance = user && user.wallet_balance ? Number(user.wallet_balance) : 0.00;

  const duplicate = queryOne('SELECT id FROM wallet_transactions WHERE reference_id = ? AND status != "rejected"', [utrNumber]);
  if (duplicate) {
    return res.status(400).json({ error: `❌ UTR / Transaction Ref "${utrNumber}" has already been submitted and processed.` });
  }

  // Strict Real-Time Bank Verification Check
  const bankEvent = queryOne('SELECT id, amount, used_by_user_id FROM bank_events WHERE utr = ?', [utrNumber]);
  if (!bankEvent) {
    return res.status(400).json({
      error: `❌ Payment Failed: UTR "${utrNumber}" is invalid or not received by bank. Please ensure you transferred ₹${amount.toFixed(2)} to UPI ID pratikkarthiya6@oksbi and entered the genuine 12-digit UTR.`
    });
  }

  if (bankEvent.used_by_user_id) {
    return res.status(400).json({
      error: `❌ Payment Rejected: UTR "${utrNumber}" has already been claimed by another transaction.`
    });
  }

  if (Number(bankEvent.amount) < amount) {
    return res.status(400).json({
      error: `❌ Amount Mismatch: Bank received ₹${Number(bankEvent.amount).toFixed(2)}, which is less than requested ₹${amount.toFixed(2)}.`
    });
  }

  runSql('UPDATE bank_events SET used_by_user_id = ?, used_for = "wallet" WHERE id = ?', [req.session.userId, bankEvent.id]);

  const newBalance = currentBalance + amount;
  runSql('UPDATE users SET wallet_balance = ? WHERE id = ?', [newBalance, req.session.userId]);

  const trxId = runSql(
    `INSERT INTO wallet_transactions (user_id, type, amount, balance_after, reference_id, description, receipt_url, status)
     VALUES (?, 'credit', ?, ?, ?, 'Prepaid Wallet Top-up (UPI)', ?, 'approved')`,
    [req.session.userId, amount, newBalance, utrNumber, receiptUrl]
  );

  const candidateUser = queryOne('SELECT name, email FROM users WHERE id = ?', [req.session.userId]);
  const candidateLabel = candidateUser ? `${escapeTgHtml(candidateUser.name)} (${escapeTgHtml(candidateUser.email)})` : `User #${req.session.userId}`;
  const timeStr = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
  sendTelegramAlertNode(`💰 <b>KP CYBER — WALLET TOP-UP!</b>\n━━━━━━━━━━━━━━━━━━\n👤 <b>Candidate:</b> ${candidateLabel}\n💵 <b>Amount Credited:</b> ₹${amount.toFixed(2)}\n🏦 <b>New Wallet Balance:</b> ₹${newBalance.toFixed(2)}\n🧾 <b>Verified UTR:</b> <code>${escapeTgHtml(utrNumber)}</code>\n⏰ <b>Time:</b> ${timeStr}\n🔗 <a href="https://kpcyber.in/admin">Open Admin Wallet Ledger</a>`).catch(() => {});

  res.json({
    success: true,
    message: `🎉 ₹${amount.toFixed(2)} added to your wallet successfully! New Balance: ₹${newBalance.toFixed(2)}.`,
    newBalance,
    transactionId: trxId
  });
}

router.post('/wallet/topup', requireUser, rejectIfShutdown, upload.single('receipt'), handleWalletTopup);
router.post('/wallet', requireUser, rejectIfShutdown, upload.single('receipt'), handleWalletTopup);

/**
 * 6. Real-time Payment Verification Checker (for automatic popup)
 */
router.get('/check-payment', requireUser, (req, res) => {
  const sinceMs = parseInt(req.query.since || '0', 10);
  const lookbackSeconds = sinceMs > 0 ? Math.max(1, Math.floor((Date.now() - sinceMs) / 1000)) : 120;

  // Check recent application payments
  const recentApp = queryOne(`
    SELECT id, application_number, payment_id, payment_amount, paid_at 
    FROM applications 
    WHERE user_id = ? AND payment_status = 'paid' AND paid_at >= datetime('now', '-' || ? || ' seconds')
    ORDER BY paid_at DESC LIMIT 1
  `, [req.session.userId, lookbackSeconds]);

  if (recentApp) {
    return res.json({
      success: true,
      verified: true,
      type: 'application',
      amount: recentApp.payment_amount || 250.00,
      utr: recentApp.payment_id || 'N/A',
      title: 'Batch Payment Verified!',
      message: `Your payment of ₹${Number(recentApp.payment_amount || 250).toFixed(2)} has been verified and settled successfully!`
    });
  }

  // Check recent wallet credits
  const recentWallet = queryOne(`
    SELECT id, amount, balance_after, reference_id, created_at 
    FROM wallet_transactions 
    WHERE user_id = ? AND type = 'credit' AND status = 'approved' AND created_at >= datetime('now', '-' || ? || ' seconds')
    ORDER BY id DESC LIMIT 1
  `, [req.session.userId, lookbackSeconds]);

  if (recentWallet) {
    return res.json({
      success: true,
      verified: true,
      type: 'wallet',
      amount: recentWallet.amount,
      utr: recentWallet.reference_id || 'N/A',
      newBalance: recentWallet.balance_after,
      title: 'Wallet Top-Up Confirmed!',
      message: `₹${Number(recentWallet.amount).toFixed(2)} has been credited to your prepaid wallet! New balance: ₹${Number(recentWallet.balance_after).toFixed(2)}.`
    });
  }

  res.json({ success: true, verified: false });
});

module.exports = router;
