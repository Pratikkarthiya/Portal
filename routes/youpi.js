const express = require('express');
const { queryOne, queryAll } = require('../db');

const router = express.Router();

const YOUPI_CONFIG = {
  vpa: 'pratikkarthiya6@oksbi',
  merchantName: 'Pratik Karthiya',
  verificationMode: 'MANUAL_UTR'
};

function requireUser(req, res, next) {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'Please log in first' });
  }
  next();
}

/**
 * 1. Get YouPI payment parameters & batch status for 5-application cycle
 */
router.get('/config', requireUser, (req, res) => {
  const user = queryOne('SELECT id, name, application_fee FROM users WHERE id = ?', [req.session.userId]);
  const feePerApp = user && user.application_fee ? user.application_fee : 50.00;

  const unpaidCount = queryOne(
    'SELECT COUNT(*) as c FROM applications WHERE user_id = ? AND payment_status = "unpaid"',
    [req.session.userId]
  ).c;

  // Batch fee is 5 * single fee
  const batchFee = feePerApp * 5;

  res.json({
    vpa: YOUPI_CONFIG.vpa,
    merchantName: YOUPI_CONFIG.merchantName,
    feePerApp: feePerApp,
    batchFee: batchFee,
    unpaidCount: unpaidCount,
    slotNumber: (unpaidCount % 5) + 1, // 1 to 5
    is5thApp: unpaidCount === 4,
    verificationMode: YOUPI_CONFIG.verificationMode
  });
});

/**
 * 2. Create YouPI session for 5-application batch
 */
router.post('/create-session', requireUser, (req, res) => {
  const { applicationNumber } = req.body;
  const user = queryOne('SELECT id, name, application_fee FROM users WHERE id = ?', [req.session.userId]);
  const feePerApp = user && user.application_fee ? user.application_fee : 50.00;
  const batchFee = feePerApp * 5;

  const orderId = 'BATCH5-' + Date.now().toString(36).toUpperCase();

  res.json({
    success: true,
    orderId: orderId,
    vpa: YOUPI_CONFIG.vpa,
    merchantName: YOUPI_CONFIG.merchantName,
    feePerApp: feePerApp,
    batchFee: batchFee,
    amount: batchFee, // exact total for all 5 applications
    currency: 'INR',
    verificationMode: 'MANUAL_UTR',
    instructions: `Batch payment of ₹${batchFee.toFixed(2)} for 5 applications. Scan & pay via UPI, then submit UTR.`
  });
});

module.exports = router;
