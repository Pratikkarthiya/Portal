-- ========================================================
-- Cloudflare D1 Database Schema for Application Review Portal
-- ========================================================

-- 1. Users Table
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  password TEXT NOT NULL,
  application_fee REAL DEFAULT 50.00,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 2. Applications Table
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
);

-- 3. Admins Table
CREATE TABLE IF NOT EXISTS admins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 4. Sessions Table (for serverless edge session storage)
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER,
  user_type TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  expires_at DATETIME NOT NULL
);

-- 5. Seed default admin: admin / admin123 ($2a$10$vI8aWBnW3fID.ZQ4/zo1G.q1lRps.9cGLcZEiGPEWi9GQOGfuIpWC)
INSERT OR IGNORE INTO admins (id, username, password) 
VALUES (1, 'admin', '$2a$10$vI8aWBnW3fID.ZQ4/zo1G.q1lRps.9cGLcZEiGPEWi9GQOGfuIpWC');
