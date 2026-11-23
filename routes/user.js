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
router.post('/applications', requireUser, (req, res) => {
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

    const user = queryOne('SELECT application_fee FROM users WHERE id = ?', [req.session.userId]);
    const feePerApp = user && user.application_fee ? user.application_fee : 50.00;
    const photoUrl = '/uploads/' + req.files['photo'][0].filename;

    let screenshotUrl = '';
    if (req.files['paymentScreenshot'] && req.files['paymentScreenshot'].length > 0) {
      screenshotUrl = '/uploads/' + req.files['paymentScreenshot'][0].filename;
    }

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

// Get user's applications
router.get('/applications', requireUser, (req, res) => {
  const apps = queryAll(
    `SELECT id, application_number, date_of_birth, photo_url, payment_status, payment_id, payment_screenshot_url, payment_amount, payment_method, paid_at, status, admin_remarks, submitted_at, reviewed_at 
     FROM applications WHERE user_id = ? ORDER BY submitted_at DESC`,
    [req.session.userId]
  );

  res.json({ applications: apps });
});

module.exports = router;
