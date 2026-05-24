-- J Michael's Marketing HQ — D1 Schema
-- Run: wrangler d1 execute jmichaels-db --file=worker/schema.sql

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'staff',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS invites (
  id TEXT PRIMARY KEY,
  code TEXT UNIQUE NOT NULL,
  role TEXT NOT NULL DEFAULT 'staff',
  expires_at INTEGER NOT NULL,
  created_by TEXT NOT NULL,
  used INTEGER NOT NULL DEFAULT 0,
  used_by TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS posts (
  id TEXT PRIMARY KEY,
  date TEXT NOT NULL,
  platform TEXT NOT NULL DEFAULT 'fb',
  content TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS scores (
  id TEXT PRIMARY KEY,
  content_preview TEXT,
  platform TEXT,
  overall INTEGER,
  grade TEXT,
  breakdown TEXT,
  strengths TEXT,
  improvements TEXT,
  best_time TEXT,
  rewrite_tip TEXT,
  scored_by TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS reminders (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'custom',
  due_at TEXT NOT NULL,
  priority TEXT NOT NULL DEFAULT 'medium',
  notes TEXT,
  done INTEGER NOT NULL DEFAULT 0,
  completed_at TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  content TEXT NOT NULL,
  platform TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  submitted_by TEXT NOT NULL,
  submitted_at TEXT NOT NULL,
  reviewed_by TEXT,
  reviewed_at TEXT
);

CREATE TABLE IF NOT EXISTS library (
  id TEXT PRIMARY KEY,
  content TEXT NOT NULL,
  platform TEXT NOT NULL DEFAULT 'fb',
  saved_by TEXT NOT NULL,
  saved_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS campaigns (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  goal TEXT,
  start_date TEXT,
  end_date TEXT,
  description TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  type TEXT NOT NULL DEFAULT 'info',
  read INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

-- Seed default admin user
-- Password: jmichaels2024 (hashed with SHA-256 + salt 'jm_s2024')
INSERT OR IGNORE INTO users (id, username, password_hash, role, created_at)
VALUES (
  'admin001',
  'admin',
  'a8f5f167f44f4964e6c998dee827110c867eba7b5a4f8c6b1d4f9d2c1a8e3b92',
  'admin',
  datetime('now')
);
