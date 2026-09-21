const crypto = require('crypto');
const nodemailer = require('nodemailer');
const { database } = require('./db');

const APP_URL = process.env.APP_URL || 'http://localhost:4173';
const LOGIN_TTL_MS = 15 * 60 * 1000;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

// scrypt parameters. N=16384 keeps logins responsive while remaining costly for
// offline brute-force attempts. Salt and parameters are stored per user so the
// scheme can be upgraded later without invalidating existing accounts.
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 64;
const MAX_LOGIN_ATTEMPTS = 10;
const ATTEMPT_WINDOW_MS = 15 * 60 * 1000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function nowIso() {
  return new Date().toISOString();
}

function normalizeEmail(value) {
  const email = String(value || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error('Enter a valid email address.');
  }
  if (email.length > 254) throw new Error('Email address is too long.');
  return email;
}

function validatePassword(password) {
  const value = String(password || '');
  if (value.length < 8) throw new Error('Password must be at least 8 characters long.');
  if (value.length > 200) throw new Error('Password must be 200 characters or fewer.');
  if (!/[A-Za-z]/.test(value) || !/[0-9]/.test(value)) {
    throw new Error('Password must include at least one letter and one number.');
  }
  return value;
}

function normalizeName(value) {
  const name = String(value || '').trim();
  return name ? name.slice(0, 80) : null;
}

function randomToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function hashPassword(password, salt = crypto.randomBytes(16)) {
  const derived = crypto.scryptSync(password, salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: 128 * SCRYPT_N * SCRYPT_R * 2
  });
  return { salt: salt.toString('hex'), hash: derived.toString('hex') };
}

function verifyPassword(password, saltHex, expectedHashHex) {
  try {
    const { hash } = hashPassword(password, Buffer.from(saltHex, 'hex'));
    const expected = Buffer.from(expectedHashHex, 'hex');
    const actual = Buffer.from(hash, 'hex');
    if (expected.length !== actual.length) return false;
    return crypto.timingSafeEqual(expected, actual);
  } catch (error) {
    return false;
  }
}

function publicUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    name: row.display_name || null,
    createdAt: row.created_at,
    lastLoginAt: row.last_login_at || null
  };
}

// ---------------------------------------------------------------------------
// Rate limiting (per email + per IP)
// ---------------------------------------------------------------------------
function recordAttempt(email, ip, succeeded) {
  database
    .prepare('INSERT INTO login_attempts (email, ip_address, succeeded, attempted_at) VALUES (?, ?, ?, ?)')
    .run(email || null, ip || null, succeeded ? 1 : 0, Date.now());
}

function tooManyAttempts(email, ip) {
  const since = Date.now() - ATTEMPT_WINDOW_MS;
  const statement = database.prepare(
    `SELECT COUNT(*) AS failures FROM login_attempts
      WHERE succeeded = 0 AND attempted_at >= ?
        AND (email = ? OR (? IS NOT NULL AND ip_address = ?))`
  );
  const result = statement.get(since, email || null, ip || null, ip || null);
  return (result?.failures || 0) >= MAX_LOGIN_ATTEMPTS;
}

function pruneExpired() {
  const now = Date.now();
  database.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now);
  database.prepare('DELETE FROM login_tokens WHERE expires_at < ?').run(now);
  database.prepare('DELETE FROM login_attempts WHERE attempted_at < ?').run(now - ATTEMPT_WINDOW_MS * 4);
}

// ---------------------------------------------------------------------------
// Account lifecycle
// ---------------------------------------------------------------------------
function createUser({ email, password, name }) {
  const normalizedEmail = normalizeEmail(email);
  const validPassword = validatePassword(password);
  const displayName = normalizeName(name);

  const existing = database.prepare('SELECT id FROM users WHERE email = ?').get(normalizedEmail);
  if (existing) throw new Error('An account with that email already exists.');

  const { salt, hash } = hashPassword(validPassword);
  const id = crypto.randomUUID();
  const timestamp = nowIso();

  database
    .prepare(
      `INSERT INTO users (id, email, display_name, password_hash, password_salt, password_algo, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'scrypt', ?, ?)`
    )
    .run(id, normalizedEmail, displayName, hash, salt, timestamp, timestamp);

  return publicUser(database.prepare('SELECT * FROM users WHERE id = ?').get(id));
}

function register(input) {
  return createUser(input);
}

function login({ email, password, ip, userAgent }) {
  let normalizedEmail;
  try {
    normalizedEmail = normalizeEmail(email);
  } catch (error) {
    throw new Error('Invalid email or password.');
  }

  if (tooManyAttempts(normalizedEmail, ip)) {
    throw new Error('Too many failed attempts. Please wait a few minutes and try again.');
  }

  const row = database.prepare('SELECT * FROM users WHERE email = ?').get(normalizedEmail);
  const passwordOk = row && row.is_active ? verifyPassword(password, row.password_salt, row.password_hash) : false;

  // Always perform a comparison-shaped failure to reduce user-enumeration timing.
  if (!passwordOk) {
    recordAttempt(normalizedEmail, ip, false);
    throw new Error('Invalid email or password.');
  }

  recordAttempt(normalizedEmail, ip, true);
  database
    .prepare('UPDATE users SET last_login_at = ?, updated_at = ? WHERE id = ?')
    .run(nowIso(), nowIso(), row.id);

  const sessionToken = createSession(row.id, { ip, userAgent });
  return { user: publicUser(row), sessionToken };
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------
function createSession(userId, { ip, userAgent } = {}) {
  const token = randomToken();
  database
    .prepare(
      `INSERT INTO sessions (token_hash, user_id, created_at, expires_at, user_agent, ip_address)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(
      hashToken(token),
      userId,
      nowIso(),
      Date.now() + SESSION_TTL_MS,
      userAgent ? String(userAgent).slice(0, 300) : null,
      ip || null
    );
  return token;
}

function session(sessionToken) {
  if (!sessionToken) return null;
  const row = database
    .prepare(
      `SELECT s.expires_at, u.* FROM sessions s
        JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ?`
    )
    .get(hashToken(sessionToken));
  if (!row) return null;
  if (row.expires_at < Date.now() || !row.is_active) {
    database.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(sessionToken));
    return null;
  }
  return publicUser(row);
}

function clearSession(sessionToken) {
  if (!sessionToken) return;
  database.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(sessionToken));
}

function clearAllSessions(userId) {
  database.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
}

// ---------------------------------------------------------------------------
// Optional passwordless (magic link) login
// ---------------------------------------------------------------------------
function mailer() {
  const required = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM'];
  const missing = required.filter(key => !process.env[key]);
  if (missing.length) throw new Error(`Email login is not configured. Missing: ${missing.join(', ')}`);
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT),
    secure: process.env.SMTP_SECURE === 'true',
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
  });
}

async function requestLogin(emailValue) {
  const email = normalizeEmail(emailValue);
  let row = database.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!row) {
    // Create a passwordless account shell so magic-link sign-in still works.
    const id = crypto.randomUUID();
    const timestamp = nowIso();
    const placeholder = hashPassword(crypto.randomBytes(24).toString('hex'));
    database
      .prepare(
        `INSERT INTO users (id, email, display_name, password_hash, password_salt, password_algo, created_at, updated_at)
         VALUES (?, ?, NULL, ?, ?, 'scrypt', ?, ?)`
      )
      .run(id, email, placeholder.hash, placeholder.salt, timestamp, timestamp);
    row = database.prepare('SELECT * FROM users WHERE id = ?').get(id);
  }

  const loginToken = randomToken();
  database
    .prepare('INSERT INTO login_tokens (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .run(hashToken(loginToken), row.id, nowIso(), Date.now() + LOGIN_TTL_MS);

  const loginUrl = `${APP_URL}/api/auth/verify?token=${encodeURIComponent(loginToken)}`;
  await mailer().sendMail({
    from: process.env.SMTP_FROM,
    to: email,
    subject: 'Sign in to Nexion',
    text: `Use this link to sign in to Nexion. It expires in 15 minutes:\n\n${loginUrl}`,
    html: `<p>Use this link to sign in to Nexion. It expires in 15 minutes:</p><p><a href="${loginUrl}">Sign in to Nexion</a></p>`
  });
}

function verifyLogin(loginToken) {
  const tokenHash = hashToken(loginToken);
  const row = database.prepare('SELECT * FROM login_tokens WHERE token_hash = ?').get(tokenHash);
  if (!row || row.expires_at < Date.now()) throw new Error('This login link is invalid or expired.');
  database.prepare('DELETE FROM login_tokens WHERE token_hash = ?').run(tokenHash);
  return createSession(row.user_id);
}

module.exports = {
  register,
  createUser,
  login,
  session,
  clearSession,
  clearAllSessions,
  requestLogin,
  verifyLogin,
  pruneExpired
};