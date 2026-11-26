const initSqlJs = require('sql.js');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');

const dbPath = path.join(__dirname, 'portal.db');
let db;
let SQL;

async function initializeSQL() {
  SQL = await initSqlJs();
}

function getDb() {
  if (!db) {
    if (fs.existsSync(dbPath)) {
      const buffer = fs.readFileSync(dbPath);
      db = new SQL.Database(buffer);
    } else {
      db = new SQL.Database();
    }
  }
  return db;
}

function saveDb() {
  if (db) {
    const data = db.export();
    const buffer = Buffer.from(data);
    fs.writeFileSync(dbPath, buffer);
  }
}

function initialize() {
  const conn = getDb();

  // Users table with customizable application_fee
  conn.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      application_fee REAL DEFAULT 50.00,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Applications table with photo, manual UTR, and payment screenshot
  conn.run(`
    CREATE TABLE IF NOT EXISTS applications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      application_number TEXT NOT NULL,
      date_of_birth TEXT NOT NULL,
      app_password TEXT NOT NULL,
      photo_url TEXT DEFAULT '',
      payment_status TEXT DEFAULT 'unpaid',
      payment_id TEXT DEFAULT '',
      payment_screenshot_url TEXT DEFAULT '',
      payment_amount REAL DEFAULT 50.00,
      payment_method TEXT DEFAULT 'UPI_MANUAL_UTR',
      paid_at DATETIME,
      status TEXT DEFAULT 'pending',
      admin_remarks TEXT DEFAULT '',
      submitted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      reviewed_at DATETIME,
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `);

  // Migrations for existing database columns
  const migrationCols = [
    `ALTER TABLE users ADD COLUMN application_fee REAL DEFAULT 50.00`,
    `ALTER TABLE applications ADD COLUMN photo_url TEXT DEFAULT ''`,
    `ALTER TABLE applications ADD COLUMN payment_status TEXT DEFAULT 'unpaid'`,
    `ALTER TABLE applications ADD COLUMN payment_id TEXT DEFAULT ''`,
    `ALTER TABLE applications ADD COLUMN payment_screenshot_url TEXT DEFAULT ''`,
    `ALTER TABLE applications ADD COLUMN payment_amount REAL DEFAULT 50.00`,
    `ALTER TABLE applications ADD COLUMN payment_method TEXT DEFAULT 'UPI_MANUAL_UTR'`,
    `ALTER TABLE applications ADD COLUMN paid_at DATETIME`,
    `ALTER TABLE applications ADD COLUMN result_photo_url TEXT DEFAULT ''`,
    `ALTER TABLE users ADD COLUMN wallet_balance REAL DEFAULT 0.00`,
    `ALTER TABLE users ADD COLUMN payment_mode TEXT DEFAULT 'batch'`,
    `ALTER TABLE users ADD COLUMN telegram_chat_id TEXT DEFAULT ''`,
    `ALTER TABLE users ADD COLUMN ll_pdf_fee REAL DEFAULT 20.00`
  ];

  for (const query of migrationCols) {
    try {
      conn.run(query);
    } catch (e) {
      // Column already exists or already migrated
    }
  }

  // Wallet Transactions table
  conn.run(`
    CREATE TABLE IF NOT EXISTS wallet_transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      type TEXT NOT NULL,
      amount REAL NOT NULL,
      balance_after REAL NOT NULL,
      reference_id TEXT DEFAULT '',
      description TEXT NOT NULL,
      receipt_url TEXT DEFAULT '',
      status TEXT DEFAULT 'approved',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `);

  // Observer Bank Events table (for automatic strict UTR reconciliation)
  conn.run(`
    CREATE TABLE IF NOT EXISTS bank_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      utr TEXT UNIQUE NOT NULL,
      amount REAL NOT NULL,
      sender_vpa TEXT,
      raw_text TEXT,
      used_by_user_id INTEGER,
      used_for TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  try {
    conn.run(`CREATE INDEX IF NOT EXISTS idx_bank_events_utr ON bank_events(utr)`);
  } catch (e) {}

  // System Settings table (e.g. Telegram Bot notifications, alert preferences)
  conn.run(`
    CREATE TABLE IF NOT EXISTS system_settings (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // LL PDF Requests table
  conn.run(`
    CREATE TABLE IF NOT EXISTS ll_pdf_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      application_number TEXT NOT NULL,
      fee_amount REAL NOT NULL DEFAULT 20.00,
      status TEXT DEFAULT 'pending',
      pdf_url TEXT DEFAULT '',
      admin_remarks TEXT DEFAULT '',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      completed_at DATETIME,
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `);

  // Admin table
  conn.run(`
    CREATE TABLE IF NOT EXISTS admins (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Seed default admin: Pratik / Pratik@6161
  const existing = conn.exec("SELECT id FROM admins WHERE username = 'Pratik'");
  if (existing.length === 0 || existing[0].values.length === 0) {
    const hash = bcrypt.hashSync('Pratik@6161', 10);
    conn.run('INSERT INTO admins (username, password) VALUES (?, ?)', ['Pratik', hash]);
    console.log('Default admin created → username: Pratik, password: Pratik@6161');
  }

  saveDb();
}

function queryAll(sql, params = []) {
  const conn = getDb();
  const stmt = conn.prepare(sql);
  stmt.bind(params);
  const results = [];
  while (stmt.step()) {
    results.push(stmt.getAsObject());
  }
  stmt.free();
  return results;
}

function queryOne(sql, params = []) {
  const results = queryAll(sql, params);
  return results.length > 0 ? results[0] : null;
}

function runSql(sql, params = []) {
  const conn = getDb();
  conn.run(sql, params);
  saveDb();
  const result = conn.exec("SELECT last_insert_rowid() as id");
  return result.length > 0 ? result[0].values[0][0] : null;
}

module.exports = { initializeSQL, initialize, queryAll, queryOne, runSql, getDb, saveDb };
