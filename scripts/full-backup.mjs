// Full backup for moving off the server: business DB + auth DB (accounts) + backup settings.
// Safe while the service is running (uses SQLite's online backup API, WAL included).
//
//   node scripts/full-backup.mjs                    # uses /opt/factory-desk/data → /opt/factory-desk/offsite
//   FACTORY_STORAGE_ROOT=… FACTORY_OFFSITE_DIR=… FACTORY_OFFSITE_KEEP=30 node scripts/full-backup.mjs
//
// Each run writes <offsite>/<YYYY-MM-DD_HHMMSS>/ with factory-desk.db, auth.db, settings.json (if any)
// and SHA256SUMS, then keeps only the newest FACTORY_OFFSITE_KEEP folders. Copy the folder to
// another machine (rsync/scp/对象存储) — a backup on the same disk does not survive a disk failure.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

const root = process.env.FACTORY_STORAGE_ROOT || '/opt/factory-desk/data';
const outRoot = process.env.FACTORY_OFFSITE_DIR || '/opt/factory-desk/offsite';
const keep = Math.max(1, Number(process.env.FACTORY_OFFSITE_KEEP || 30));
const sources = [
  ['factory-desk.db', path.join(root, 'business', 'factory-desk.db')],
  ['auth.db', path.join(root, 'auth', 'auth.db')]
];

const stamp = new Date().toISOString().replace('T', '_').replace(/[:]/g, '').slice(0, 17);
const target = path.join(outRoot, stamp);
fs.mkdirSync(target, { recursive: true, mode: 0o700 });

const sums = [];
for (const [name, source] of sources) {
  if (!fs.existsSync(source)) throw new Error(`找不到数据库：${source}（请检查 FACTORY_STORAGE_ROOT）`);
  const db = new Database(source, { readonly: true, fileMustExist: true });
  const destination = path.join(target, name);
  await db.backup(destination);
  db.close();
  // Store the copy as one self-contained file (no -wal/-shm side files) and verify it.
  const check = new Database(destination);
  check.pragma('journal_mode = DELETE');
  const result = check.pragma('integrity_check', { simple: true });
  check.close();
  if (result !== 'ok') throw new Error(`${name} 备份校验失败：${result}`);
  fs.chmodSync(destination, 0o600);
  sums.push(`${crypto.createHash('sha256').update(fs.readFileSync(destination)).digest('hex')}  ${name}`);
}
const settings = path.join(root, 'backups', 'settings.json');
if (fs.existsSync(settings)) fs.copyFileSync(settings, path.join(target, 'settings.json'));
fs.writeFileSync(path.join(target, 'SHA256SUMS'), `${sums.join('\n')}\n`, { mode: 0o600 });

const folders = fs.readdirSync(outRoot).filter((name) => /^\d{4}-\d{2}-\d{2}_\d{6}$/.test(name)).sort();
for (const old of folders.slice(0, Math.max(0, folders.length - keep))) fs.rmSync(path.join(outRoot, old), { recursive: true, force: true });

console.log(`[full-backup] ${new Date().toISOString()} → ${target}`);
