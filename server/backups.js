import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import { backupDatabaseTo, replaceDatabaseFrom } from './database.js';

const filePattern = /^business-(manual|auto|before-restore|before-upgrade|upload)-[\dT-Z-]+-[a-f\d-]+\.db$/;
const defaults = { enabled: true, intervalHours: 24, retention: 14 };

export function validateBusinessBackup(filePath) {
  let candidate;
  try {
    candidate = new Database(filePath, { readonly: true, fileMustExist: true });
    candidate.pragma('trusted_schema = OFF');
    if (candidate.pragma('quick_check', { simple: true }) !== 'ok') throw new Error('数据库完整性校验失败');
    if (candidate.pragma('user_version', { simple: true }) > 2) throw new Error('备份来自更高版本，请先升级服务');
    const tables = candidate.prepare("SELECT name, type FROM sqlite_master WHERE type IN ('table', 'view', 'trigger')").all();
    if (tables.some((entry) => entry.type !== 'table')) throw new Error('备份包含不支持的数据库对象');
    for (const table of ['inventory_items', 'stock_orders', 'price_sheets', 'bills']) {
      if (!tables.some((entry) => entry.name === table)) throw new Error('文件不是有效的业务数据库备份');
    }
    const required = {
      inventory_items: ['id', 'code', 'name', 'category', 'unit', 'safety_stock', 'location', 'stock_qty', 'unit_price', 'created_at', 'updated_at'],
      stock_orders: ['id', 'order_no', 'type', 'item_id', 'quantity', 'unit_price', 'total_amount', 'partner', 'operator', 'order_date', 'remark', 'created_at'],
      price_sheets: ['id', 'sheet_no', 'partner', 'unit_price', 'effective_date', 'remark', 'created_at'],
      bills: ['id', 'bill_no', 'bill_type', 'partner', 'amount', 'status', 'bill_date', 'due_date', 'remark', 'created_at']
    };
    if (candidate.pragma('user_version', { simple: true }) === 2) Object.assign(required, {
      customers: ['id', 'name', 'contact', 'phone', 'address', 'settlement_days', 'remark', 'is_active', 'created_at', 'updated_at'],
      receipts: ['id', 'receipt_no', 'bill_id', 'amount_cents', 'receipt_date', 'method', 'request_key', 'reference', 'remark', 'operator', 'created_at', 'voided_at', 'void_reason', 'voided_by'],
      inventory_ledger: ['id', 'item_id', 'order_id', 'event_type', 'quantity_delta', 'balance_after', 'business_date', 'reference', 'remark', 'operator', 'created_at'],
      bill_events: ['id', 'bill_id', 'action', 'reason', 'operator', 'created_at']
    });
    for (const [table, columns] of Object.entries(required)) {
      const available = candidate.prepare(`PRAGMA table_info(${table})`).all().map((entry) => entry.name);
      if (columns.some((name) => !available.includes(name))) throw new Error(`备份缺少必要的业务字段：${table}`);
    }
    return { ok: true };
  } catch (error) {
    throw new Error(`无法使用此备份：${error.message}`);
  } finally {
    candidate?.close();
  }
}

function makeName(kind) {
  return `business-${kind}-${new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')}-${crypto.randomUUID()}.db`;
}

// Preserve a consistent old database before the first schema upgrade.
export async function backupBeforeUpgrade(storage) {
  const file = path.join(storage.businessDir, 'factory-desk.db');
  if (!fs.existsSync(file)) return;
  const previous = new Database(file, { readonly: true, fileMustExist: true });
  try {
    if (previous.pragma('user_version', { simple: true }) < 2) {
      const target = path.join(storage.backupsDir, makeName('before-upgrade'));
      await previous.backup(target);
      fs.chmodSync(target, 0o600);
    }
  } finally { previous.close(); }
}

export function createBackupManager(storage) {
  const directory = storage.backupsDir;
  const settingsPath = path.join(directory, 'settings.json');
  let busy = false, restoring = false, timer;
  let lastError = '';
  let settings = { ...defaults };
  if (fs.existsSync(settingsPath)) {
    try { settings = checkedSettings(JSON.parse(fs.readFileSync(settingsPath, 'utf8'))); }
    catch (error) { lastError = `备份设置读取失败，已采用默认设置：${error.message}`; }
  }

  function checkedSettings(payload) {
    const intervalHours = Number(payload.intervalHours ?? defaults.intervalHours);
    const retention = Number(payload.retention ?? defaults.retention);
    if (!Number.isInteger(intervalHours) || intervalHours < 1 || intervalHours > 168) throw new Error('备份间隔须为 1 至 168 小时');
    if (!Number.isInteger(retention) || retention < 1 || retention > 90) throw new Error('自动备份保留份数须为 1 至 90');
    const enabled = payload.enabled === undefined ? true : payload.enabled === true || payload.enabled === 1 || payload.enabled === '1' || payload.enabled === 'true';
    return { enabled, intervalHours, retention };
  }

  function filePath(id) {
    if (!filePattern.test(String(id))) throw new Error('备份编号不正确');
    const target = path.join(directory, id);
    if (!fs.existsSync(target) || !fs.lstatSync(target).isFile()) throw new Error('备份不存在');
    return target;
  }

  function list() {
    const backups = fs.readdirSync(directory).filter((name) => filePattern.test(name) && fs.lstatSync(path.join(directory, name)).isFile()).map((name) => {
      const stats = fs.statSync(path.join(directory, name));
      return { id: name, kind: name.match(filePattern)[1], size: stats.size, createdAt: stats.mtime.toISOString() };
    }).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return { backups, settings, busy, restoring, lastError, scope: 'business' };
  }

  async function snapshot(kind) {
    const id = makeName(kind);
    const partial = path.join(directory, `${id}.partial`);
    try {
      await backupDatabaseTo(partial);
      validateBusinessBackup(partial);
      fs.chmodSync(partial, 0o600);
      fs.renameSync(partial, path.join(directory, id));
      lastError = '';
      return { ok: true, id };
    } finally { if (fs.existsSync(partial)) fs.unlinkSync(partial); }
  }

  async function create(kind = 'manual') {
    if (busy) throw new Error('备份任务进行中，请稍后重试');
    if (!['auto', 'manual', 'before-restore'].includes(kind)) throw new Error('备份类型不正确');
    busy = true;
    try {
      const result = await snapshot(kind);
      if (kind === 'auto') {
        for (const old of list().backups.filter((entry) => entry.kind === 'auto').slice(settings.retention)) fs.unlinkSync(filePath(old.id));
      }
      return result;
    } catch (error) { lastError = error.message; throw error; }
    finally { busy = false; }
  }

  async function restore(id, confirmation) {
    if (confirmation !== '恢复业务数据') throw new Error('请输入“恢复业务数据”确认覆盖当前业务记录');
    if (busy) throw new Error('备份任务进行中，请稍后重试');
    const source = filePath(id);
    validateBusinessBackup(source);
    busy = true;
    restoring = true;
    let safety;
    try {
      safety = await snapshot('before-restore');
      replaceDatabaseFrom(source);
      return { ok: true, safetyBackupId: safety.id };
    } catch (error) {
      lastError = error.message;
      if (safety) {
        try { replaceDatabaseFrom(filePath(safety.id)); }
        catch (rollbackError) { throw new Error(`恢复与回退均失败，请使用保护备份 ${safety.id}：${rollbackError.message}`); }
      }
      throw error;
    } finally { busy = false; restoring = false; }
  }

  function upload(buffer) {
    if (busy) throw new Error('备份任务进行中，请稍后重试');
    if (buffer.length > 100 * 1024 * 1024 || buffer.subarray(0, 16).toString() !== 'SQLite format 3\0') throw new Error('请选择不超过 100 MB 的 SQLite 业务备份');
    const id = makeName('upload');
    const target = path.join(directory, id);
    try {
      fs.writeFileSync(target, buffer, { flag: 'wx', mode: 0o600 });
      validateBusinessBackup(target);
      return { ok: true, id };
    } catch (error) { if (fs.existsSync(target)) fs.unlinkSync(target); throw error; }
  }

  async function tick() {
    if (!settings.enabled || busy) return;
    const last = list().backups.find((entry) => entry.kind === 'auto');
    if (!last || Date.now() - Date.parse(last.createdAt) >= settings.intervalHours * 3600000) await create('auto');
  }

  return {
    list, create, restore, upload, filePath,
    get restoring() { return restoring; },
    updateSettings(payload) {
      settings = checkedSettings({ ...settings, ...payload });
      const temporary = `${settingsPath}.tmp`;
      fs.writeFileSync(temporary, JSON.stringify(settings, null, 2), { mode: 0o600 });
      fs.renameSync(temporary, settingsPath);
      return settings;
    },
    tick,
    start() {
      const run = () => tick().catch((error) => { lastError = error.message; console.error('[backup]', error.message); });
      void run();
      timer = setInterval(run, 60_000);
      timer.unref();
    },
    stop() { clearInterval(timer); }
  };
}
