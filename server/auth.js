import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import Database from 'better-sqlite3';
import { HttpError } from './errors.js';

const pbkdf2Async = promisify(crypto.pbkdf2);

const SESSION_TTL_HOURS = Number(process.env.FACTORY_SESSION_TTL_HOURS || 24 * 7);

let authDb;

function nowIso() {
  return new Date().toISOString();
}

function plusHoursIso(hours) {
  const next = new Date();
  next.setHours(next.getHours() + hours);
  return next.toISOString();
}

function sha256Hex(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function buildPasswordHash(password, saltHex) {
  return crypto.pbkdf2Sync(password, saltHex, 120000, 64, 'sha512').toString('hex');
}

async function buildPasswordHashAsync(password, saltHex) {
  return (await pbkdf2Async(password, saltHex, 120000, 64, 'sha512')).toString('hex');
}

function sameHash(a, b) {
  const left = Buffer.from(String(a), 'hex'), right = Buffer.from(String(b), 'hex');
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

// Failed-login throttling (in memory; resets when the service restarts).
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILS_PER_ACCOUNT_AND_IP = 5;
const MAX_FAILS_PER_ACCOUNT = 20;
const loginFailures = new Map();
const DUMMY_SALT = crypto.randomBytes(16).toString('hex');

function recentFailures(key, now) {
  const list = (loginFailures.get(key) || []).filter((time) => now - time < LOGIN_WINDOW_MS);
  if (list.length) loginFailures.set(key, list); else loginFailures.delete(key);
  return list;
}

function assertNotThrottled(keys, now) {
  const [pairKey, accountKey] = keys;
  const pair = recentFailures(pairKey, now), account = recentFailures(accountKey, now);
  const blocked = pair.length >= MAX_FAILS_PER_ACCOUNT_AND_IP ? pair : account.length >= MAX_FAILS_PER_ACCOUNT ? account : null;
  if (blocked) {
    const minutes = Math.max(1, Math.ceil((LOGIN_WINDOW_MS - (now - blocked[0])) / 60000));
    throw new HttpError(429, `登录失败次数过多，请 ${minutes} 分钟后再试`);
  }
}

function recordFailure(keys, now) {
  for (const key of keys) loginFailures.set(key, [...recentFailures(key, now), now]);
}

function safeUserPayload(row) {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    role: row.role
  };
}

function assertAdmin(sessionUser) {
  if (!sessionUser || sessionUser.role !== 'admin') {
    throw new HttpError(403, '仅管理员可执行该操作');
  }
}

const DEFAULT_ADMIN_PASSWORD = 'admin123!';
// Admin accounts still using the built-in default password (checked at start-up and after resets).
const defaultPasswordAdmins = new Set();

function refreshDefaultPasswordAdmins() {
  defaultPasswordAdmins.clear();
  for (const row of authDb.prepare("SELECT id, password_hash, password_salt FROM users WHERE role = 'admin' AND is_active = 1").all()) {
    if (sameHash(buildPasswordHash(DEFAULT_ADMIN_PASSWORD, row.password_salt), row.password_hash)) defaultPasswordAdmins.add(row.id);
  }
  if (defaultPasswordAdmins.size) console.warn('[auth] WARNING: an admin account still uses the default password admin123! — change it in 用户管理 before going live.');
}

export function securityWarningsFor(sessionUser) {
  if (sessionUser?.role !== 'admin' || !defaultPasswordAdmins.size) return [];
  return ['仍有管理员账号使用默认密码 admin123!，请立即在“用户管理”中重置为独立的强密码。'];
}

function upsertDefaultAdmin() {
  const username = String(process.env.FACTORY_ADMIN_USERNAME || 'admin').trim();
  const configured = String(process.env.FACTORY_ADMIN_PASSWORD || '').trim();
  const password = configured || DEFAULT_ADMIN_PASSWORD;
  const displayName = String(process.env.FACTORY_ADMIN_DISPLAY_NAME || '系统管理员').trim();

  const existing = authDb.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (existing) {
    return;
  }
  if (process.env.NODE_ENV === 'production' && (password === DEFAULT_ADMIN_PASSWORD || password.length < 10 || /^ChangeTo|^REPLACE_WITH/i.test(password))) {
    throw new Error('生产环境首次启动必须设置 FACTORY_ADMIN_PASSWORD（至少 10 位，且不能是默认值或模板占位符），见 DEPLOY_SERVER.md');
  }

  const salt = crypto.randomBytes(16).toString('hex');
  const passwordHash = buildPasswordHash(password, salt);
  const timestamp = nowIso();

  authDb.prepare(`
    INSERT INTO users
      (username, display_name, role, password_hash, password_salt, is_active, created_at, updated_at)
    VALUES (?, ?, 'admin', ?, ?, 1, ?, ?)
  `).run(username, displayName, passwordHash, salt, timestamp, timestamp);

  console.log('[auth] default admin created. Please change FACTORY_ADMIN_PASSWORD in production.');
}

export function initializeAuthDatabase(authDir) {
  fs.mkdirSync(authDir, { recursive: true });
  const dbPath = path.join(authDir, 'auth.db');
  authDb = new Database(dbPath);
  authDb.pragma('journal_mode = WAL');

  authDb.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'operator',
      password_hash TEXT NOT NULL,
      password_salt TEXT NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1,
      last_login_at TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      token_hash TEXT NOT NULL UNIQUE,
      user_id INTEGER NOT NULL,
      expires_at TEXT NOT NULL,
      revoked_at TEXT NOT NULL DEFAULT '',
      last_seen_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY(user_id) REFERENCES users(id)
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);
  `);

  upsertDefaultAdmin();
  refreshDefaultPasswordAdmins();

  return dbPath;
}

export async function loginByPassword(username, password, clientIp = '') {
  const name = String(username || '').trim();
  const secret = String(password || '').trim(); // passwords are trimmed when created or reset
  if (!name || !secret) {
    throw new Error('账号和密码不能为空');
  }

  const nowMs = Date.now();
  const keys = [`${name.toLowerCase()}|${clientIp}`, name.toLowerCase()];
  assertNotThrottled(keys, nowMs);

  const user = authDb.prepare(`
    SELECT id, username, display_name, role, password_hash, password_salt, is_active
    FROM users
    WHERE username = ?
  `).get(name);

  // Always hash once, so a missing account takes as long as a wrong password.
  const inputHash = await buildPasswordHashAsync(secret, user ? user.password_salt : DUMMY_SALT);
  if (!user || !sameHash(inputHash, user.password_hash)) {
    recordFailure(keys, nowMs);
    throw new HttpError(401, '账号或密码错误');
  }
  if (Number(user.is_active) !== 1) {
    throw new HttpError(403, '账号已停用，请联系管理员');
  }
  for (const key of keys) loginFailures.delete(key);
  authDb.prepare('DELETE FROM sessions WHERE expires_at <= ? OR revoked_at != \'\'').run(nowIso());

  const token = crypto.randomBytes(32).toString('hex');
  const tokenHash = sha256Hex(token);
  const now = nowIso();
  const expiresAt = plusHoursIso(SESSION_TTL_HOURS);

  const writeTxn = authDb.transaction(() => {
    authDb.prepare(`
      INSERT INTO sessions
        (token_hash, user_id, expires_at, revoked_at, last_seen_at, created_at)
      VALUES (?, ?, ?, '', ?, ?)
    `).run(tokenHash, user.id, expiresAt, now, now);

    authDb.prepare('UPDATE users SET last_login_at = ?, updated_at = ? WHERE id = ?')
      .run(now, now, user.id);
  });

  writeTxn();

  return {
    token,
    expiresAt,
    user: safeUserPayload(user)
  };
}

export function getSessionFromToken(token) {
  if (!token) {
    return null;
  }

  const tokenHash = sha256Hex(token);
  const now = nowIso();

  const row = authDb.prepare(`
    SELECT
      sessions.id AS session_id,
      sessions.expires_at,
      sessions.revoked_at,
      users.id,
      users.username,
      users.display_name,
      users.role,
      users.is_active
    FROM sessions
    INNER JOIN users ON users.id = sessions.user_id
    WHERE sessions.token_hash = ?
    LIMIT 1
  `).get(tokenHash);

  if (!row) {
    return null;
  }

  if (row.revoked_at || Number(row.is_active) !== 1 || row.expires_at <= now) {
    return null;
  }

  authDb.prepare('UPDATE sessions SET last_seen_at = ? WHERE id = ?').run(now, row.session_id);

  return {
    user: safeUserPayload(row),
    expiresAt: row.expires_at
  };
}

export function revokeSessionByToken(token) {
  if (!token) {
    return { ok: true };
  }

  const tokenHash = sha256Hex(token);
  authDb.prepare('UPDATE sessions SET revoked_at = ? WHERE token_hash = ?').run(nowIso(), tokenHash);
  return { ok: true };
}

export function listUsers(sessionUser) {
  assertAdmin(sessionUser);
  const rows = authDb.prepare(`
    SELECT
      id,
      username,
      display_name AS displayName,
      role,
      is_active AS isActive,
      last_login_at AS lastLoginAt,
      created_at AS createdAt
    FROM users
    ORDER BY role DESC, id ASC
  `).all();

  return rows;
}

export function createUser(sessionUser, payload) {
  assertAdmin(sessionUser);

  const username = String(payload?.username || '').trim();
  const displayName = String(payload?.displayName || '').trim();
  const role = String(payload?.role || 'operator').trim() || 'operator';
  const password = String(payload?.password || '').trim();

  if (!username) {
    throw new Error('用户名不能为空');
  }
  if (!displayName) {
    throw new Error('显示名称不能为空');
  }
  if (!password || password.length < 6) {
    throw new Error('密码长度至少 6 位');
  }
  if (!['admin', 'operator'].includes(role)) {
    throw new Error('角色无效');
  }

  const existing = authDb.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (existing) {
    throw new Error('用户名已存在');
  }

  const salt = crypto.randomBytes(16).toString('hex');
  const passwordHash = buildPasswordHash(password, salt);
  const timestamp = nowIso();

  authDb.prepare(`
    INSERT INTO users
      (username, display_name, role, password_hash, password_salt, is_active, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 1, ?, ?)
  `).run(username, displayName, role, passwordHash, salt, timestamp, timestamp);

  return { ok: true };
}

export function resetUserPassword(sessionUser, userId, newPassword, keepToken = '') {
  assertAdmin(sessionUser);

  if (!newPassword || String(newPassword).trim().length < 6) {
    throw new Error('新密码长度至少 6 位');
  }

  const target = authDb.prepare('SELECT id, username FROM users WHERE id = ?').get(Number(userId));
  if (!target) {
    throw new Error('用户不存在');
  }

  const salt = crypto.randomBytes(16).toString('hex');
  const passwordHash = buildPasswordHash(String(newPassword).trim(), salt);
  authDb.prepare(`
    UPDATE users
    SET password_hash = ?, password_salt = ?, updated_at = ?
    WHERE id = ?
  `).run(passwordHash, salt, nowIso(), Number(userId));
  defaultPasswordAdmins.delete(Number(userId));
  // Sign the account out everywhere (except the admin's own current session).
  authDb.prepare("UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at = '' AND token_hash != ?")
    .run(nowIso(), Number(userId), keepToken ? sha256Hex(keepToken) : '');

  return { ok: true };
}

export function setUserActiveStatus(sessionUser, userId, isActive) {
  assertAdmin(sessionUser);

  const target = authDb.prepare('SELECT id, role, is_active FROM users WHERE id = ?').get(Number(userId));
  if (!target) {
    throw new Error('用户不存在');
  }
  const active = isActive === true || isActive === 1 || isActive === '1' || isActive === 'true';
  if (!active && target.id === sessionUser.id) {
    throw new Error('不能停用当前登录的管理员账号');
  }
  if (!active && target.role === 'admin' && Number(target.is_active) === 1) {
    const others = authDb.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND is_active = 1 AND id != ?").get(target.id).n;
    if (!others) throw new Error('至少需要保留一个启用中的管理员');
  }

  authDb.prepare(`
    UPDATE users
    SET is_active = ?, updated_at = ?
    WHERE id = ?
  `).run(active ? 1 : 0, nowIso(), Number(userId));
  if (!active) authDb.prepare("UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at = ''").run(nowIso(), Number(userId));

  return { ok: true };
}
