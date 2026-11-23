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
    `ALTER TABLE applications ADD COLUMN paid_at DATETIME`
  ];

  for (const query of migrationCols) {
    try {
      conn.run(query);
    } catch (e) {
      // Column already exists or already migrated
    }
  }

  // Admin table
  conn.run(`
    CREATE TABLE IF NOT EXISTS admins (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Seed default admin: admin / admin123
  const existing = conn.exec("SELECT id FROM admins WHERE username = 'admin'");
  if (existing.length === 0 || existing[0].values.length === 0) {
    const hash = bcrypt.hashSync('admin123', 10);
    conn.run('INSERT INTO admins (username, password) VALUES (?, ?)', ['admin', hash]);
    console.log('Default admin created → username: admin, password: admin123');
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
