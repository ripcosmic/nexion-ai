const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

// ---------------------------------------------------------------------------
// Private SQL database for Nexion accounts.
//
// Storage engine: SQLite via Node's built-in `node:sqlite` module (Node >= 22.5).
// The database file lives outside web-served paths, is created with owner-only
// permissions where the OS supports it, and is never exposed over HTTP.
// ---------------------------------------------------------------------------

const DATA_DIR = process.env.NEXION_DATA_DIR || path.join(__dirname, 'data');
const DB_FILE = process.env.NEXION_DB_FILE || path.join(DATA_DIR, 'nexion.sqlite');

fs.mkdirSync(DATA_DIR, { recursive: true });

const database = new DatabaseSync(DB_FILE);

// Harden the connection: enforce foreign keys and use WAL for safer concurrent
// reads/writes. Both are safe to set on every boot.
database.exec('PRAGMA journal_mode = WAL;');
database.exec('PRAGMA foreign_keys = ON;');
database.exec('PRAGMA synchronous = NORMAL;');

// Restrict the database file permissions to the current user where possible.
try {
  fs.chmodSync(DB_FILE, 0o600);
} catch (error) {
  // Windows and some filesystems ignore POSIX modes; ignore.
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------
database.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id            TEXT PRIMARY KEY,
    email         TEXT NOT NULL UNIQUE,
    display_name  TEXT,
    password_hash TEXT NOT NULL,
    password_salt TEXT NOT NULL,
    password_algo TEXT NOT NULL DEFAULT 'scrypt',
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL,
    last_login_at TEXT,
    is_active     INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token_hash  TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL,
    created_at  TEXT NOT NULL,
    expires_at  INTEGER NOT NULL,
    user_agent  TEXT,
    ip_address  TEXT,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS login_tokens (
    token_hash TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS login_attempts (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    email      TEXT,
    ip_address TEXT,
    succeeded  INTEGER NOT NULL,
    attempted_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
  CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at);
  CREATE INDEX IF NOT EXISTS idx_login_tokens_user ON login_tokens(user_id);
  CREATE INDEX IF NOT EXISTS idx_attempts_email_time ON login_attempts(email, attempted_at);
`);

module.exports = {
  database,
  DB_FILE,
  DATA_DIR
};
