import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { initializeDocuments } from './documents.js';
import { INBOUND_TYPES, OUTBOUND_TYPES, isFreeOutbound, defaultBusinessType, batchKey, summarizeBatch, batchProblem } from '../shared/businessTypes.js';
export { getPrintSettings, updatePrintSettings, generateDocument } from './documents.js';
import { initializeOperations, refreshEffectivePrices, effectivePrice, validDate, nonnegative, moneyCents, quantityNumber, businessToday,
  recordInventoryMovement, resolveCustomer, lineAmount, billPayment, refreshBillStatus, recordBillEvent, voidBill } from './operations.js';
export { getCustomers, createCustomer, updateCustomer, getInventoryLedger, adjustInventory,
  getReceipts, createReceipt, voidReceipt, voidBill, restoreBill, clearLegacySettlement, getBillEvents } from './operations.js';

let db;
let dbFilePath = '';
const NUMBERING_DEFAULTS = Object.freeze({
  inventoryCodeMode: 'manual',
  deliveryNoMode: 'manual',
  outsourceNoMode: 'manual',
  processNoMode: 'manual'
});

const NUMBERING_CODEBOOK = Object.freeze({
  inventoryCodeMode: { table: 'inventory_items', column: 'code', prefix: 'MAT' },
  deliveryNoModeInbound: { table: 'stock_orders', column: 'delivery_no', prefix: 'INB' },
  deliveryNoModeOutbound: { table: 'stock_orders', column: 'delivery_no', prefix: 'DEL' },
  outsourceNoMode: { table: 'stock_orders', column: 'outsource_no', prefix: 'OUT' },
  processNoMode: { table: 'stock_orders', column: 'process_no', prefix: 'PRC' }
});

function nowIso() {
  return new Date().toISOString();
}

function addDays(dateString, days) {
  const date = new Date(dateString);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function formatStatementMonth(dateString) {
  return String(dateString || '').slice(0, 7);
}

function currentDateStamp() {
  return businessToday().replaceAll('-', '');
}

function assertRequired(value, label) {
  if (value === undefined || value === null || String(value).trim() === '') {
    throw new Error(`${label}不能为空`);
  }
}

function nextSequenceByLike(tableName, columnName, likePattern) {
  const rows = db.prepare(`
    SELECT ${columnName} AS code
    FROM ${tableName}
    WHERE ${columnName} LIKE ?
  `).all(likePattern);

  let maxSequence = 0;
  rows.forEach((row) => {
    const sequence = Number(String(row.code).split('-').pop());
    if (Number.isFinite(sequence) && sequence > maxSequence) {
      maxSequence = sequence;
    }
  });

  return maxSequence + 1;
}

function createAutoCode(definition) {
  const stamp = currentDateStamp();
  const likePattern = `${definition.prefix}-${stamp}-%`;
  const sequence = nextSequenceByLike(definition.table, definition.column, likePattern);
  return `${definition.prefix}-${stamp}-${String(sequence).padStart(3, '0')}`;
}

function formatOrderNo(prefix) {
  const stamp = businessToday().replaceAll('-', '');
  const sequence = nextSequenceByLike('stock_orders', 'order_no', `${prefix}-${stamp}-%`);
  return `${prefix}-${stamp}-${String(sequence).padStart(3, '0')}`;
}

function formatSheetNo() {
  const stamp = businessToday().replaceAll('-', '');
  const sequence = nextSequenceByLike('price_sheets', 'sheet_no', `PR-${stamp}-%`);
  return `PR-${stamp}-${String(sequence).padStart(3, '0')}`;
}

function formatBillNo() {
  const stamp = businessToday().replaceAll('-', '');
  const sequence = nextSequenceByLike('bills', 'bill_no', `BL-${stamp}-%`);
  return `BL-${stamp}-${String(sequence).padStart(3, '0')}`;
}

function normalizeBillStatus(status) {
  return String(status || '') === '已结算' ? '已结算' : '未结清';
}

function getStockOrderForBilling(stockOrderId) {
  return db.prepare(`
    SELECT
      stock_orders.id,
      stock_orders.type,
      stock_orders.business_type AS businessType,
      stock_orders.item_id AS itemId,
      stock_orders.quantity,
      stock_orders.unit_price AS unitPrice,
      stock_orders.partner,
      stock_orders.customer_id AS customerId,
      stock_orders.order_date AS orderDate,
      stock_orders.remark,
      stock_orders.delivery_no AS deliveryNo,
      stock_orders.process_no AS processNo,
      inventory_items.process_note AS processNote,
      stock_orders.voided_at AS voidedAt
    FROM stock_orders
    INNER JOIN inventory_items ON inventory_items.id = stock_orders.item_id
    WHERE stock_orders.id = ?
  `).get(Number(stockOrderId));
}

function deriveBillPayloadFromOrder(orderLike) {
  if (!orderLike || orderLike.type !== '出库') {
    return null;
  }

  const quantity = Number(orderLike.quantity || 0);
  const unitPrice = Number(orderLike.unitPrice ?? 0);
  const vendor = String(orderLike.partner || orderLike.processNote || '').trim();
  const amount = lineAmount(quantity, unitPrice);
  const billDate = String(orderLike.orderDate || businessToday());
  const days = db.prepare('SELECT settlement_days FROM customers WHERE id = ?').get(orderLike.customerId || null)?.settlement_days ?? 30;

  return {
    billType: '应收',
    partner: vendor || String(orderLike.partner || '').trim(),
    statementMonth: formatStatementMonth(billDate),
    settlementMethod: `账期${days}天`,
    currency: 'RMB',
    quantity,
    unitPrice,
    amount,
    status: '未结清',
    billDate,
    dueDate: addDays(billDate, days),
    remark: orderLike.remark || '出库单自动生成账单'
  };
}

function syncBillForOrder(orderLike) {
  const order = getStockOrderForBilling(orderLike?.id);
  if (!order || order.type !== '出库' || order.voidedAt || isFreeOutbound(order)) return;
  const existing = db.prepare('SELECT * FROM bills WHERE stock_order_id = ?').get(Number(order.id));
  if (existing) {
    if (existing.voided_at) return;
    const derived = deriveBillPayloadFromOrder({ ...order, unitPrice: existing.unit_price });
    const termDays = Math.max(0, Math.round((Date.parse(existing.due_date) - Date.parse(existing.bill_date)) / 86400000));
    db.prepare('UPDATE bills SET quantity = ?, amount = ?, bill_date = ?, statement_month = ?, due_date = ? WHERE id = ?')
      .run(derived.quantity, derived.amount, derived.billDate, derived.statementMonth, addDays(derived.billDate, termDays), existing.id);
    refreshBillStatus(existing.id);
    recordBillEvent(existing.id, '修正出货记录', `数量 ${derived.quantity}，金额 ${derived.amount}，保留开单价`, orderLike.actor);
    return;
  }
  if (db.prepare('SELECT billing_suppressed FROM stock_orders WHERE id = ?').get(order.id)?.billing_suppressed) return;
  createBill({ stockOrderId: order.id, actor: orderLike.actor });
}

function seedDatabase() {
  const items = [
    ['401031701010', '直管件', '直管 φ50.8*L492*T1.1mm 双内牙', '管件', '件', 120, 'A-01', 280, 3.3, '抛光同心圆+砂镍', '双内牙直管标准件'],
    ['501017401010', '底座件', '底座φ132*H22*中孔φ10.2*T0.6mm 内卷边', '底座', '件', 100, 'B-03', 640, 0.9, '抛光同心圆+砂镍', '底座类常规件'],
    ['301043901010', '开关帽', '开关帽φ16*H16.5mm内牙M6*P1.0沉台4.5mm', '车件', '件', 80, 'C-02', 430, 0.4, '抛光同心圆+砂镍', '车件/开关帽'],
    ['502016901010', '五金罩', '五金罩 φ230*H85*T0.6*φ10.5mm 中孔', '罩件', '件', 60, 'B-08', 198, 2.4, '抛光同心圆+砂镍', '罩类件']
  ];

  const insertItem = db.prepare(`
    INSERT INTO inventory_items
      (code, name, specification, category, unit, safety_stock, location, stock_qty, unit_price, plating, process_note, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertOrder = db.prepare(`
    INSERT INTO stock_orders
      (
        order_no, type, business_type, item_id, delivery_no, outsource_no, process_no, quantity, unit_price, total_amount,
        partner, operator, order_date, plating, remark, created_at
      )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertPriceSheet = db.prepare(`
    INSERT INTO price_sheets
      (sheet_no, partner, item_id, unit_price, effective_date, remark, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  const insertBill = db.prepare(`
    INSERT INTO bills
      (
        bill_no, bill_type, partner, statement_month, settlement_method, currency, amount, status,
        bill_date, due_date, remark, stock_order_id, created_at
      )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const timestamp = nowIso();
  for (const item of items) {
    insertItem.run(...item, timestamp, timestamp);
  }

  const itemMap = db.prepare('SELECT id, code FROM inventory_items').all();
  const codeToId = Object.fromEntries(itemMap.map((item) => [item.code, item.id]));

  const seedOrders = [
    ['IN', '入库', '退胚回库', codeToId['501017401010'], 'RB-20260403-001', '250011301-2', '50214022', 2, 2.8, 5.6, '盛发', '朱铭欣', '2026-04-03', '抛光同心圆+砂镍', '客户退胚回库'],
    ['OUT', '出库', '成品出货', codeToId['401031701010'], '2500242', '250068401-2', '50926018', 16, 2.4, 38.4, '盛发', '朱铭欣', '2026-04-03', '抛光同心圆+砂镍', '按送货单出货'],
    ['IN', '入库', '不良退回', codeToId['301043901010'], 'NG-20260403-001', '24120043', '41122031', 12, 0.4, 4.8, '盛发', '朱铭欣', '2026-04-03', '抛光同心圆+砂镍', '电镀不良退回'],
    ['OUT', '出库', '成品出货', codeToId['502016901010'], '2500244', '250073101-4', '51031037', 103, 1, 103, '盛发', '朱铭欣', '2026-04-03', '抛光同心圆+砂镍', '月度送货']
  ];

  seedOrders.forEach(([prefix, type, businessType, itemId, deliveryNo, outsourceNo, processNo, quantity, unitPrice, totalAmount, partner, operator, orderDate, plating, remark], index) => {
    insertOrder.run(
      `${prefix}-20260403-${String(index + 1).padStart(3, '0')}`,
      type,
      businessType,
      itemId,
      deliveryNo,
      outsourceNo,
      processNo,
      quantity,
      unitPrice,
      totalAmount,
      partner,
      operator,
      orderDate,
      plating,
      remark,
      timestamp
    );
  });

  insertPriceSheet.run(formatSheetNo(), '标准价', codeToId['401031701010'], 3.3, '2026-04-01', '辅助价目表', timestamp);
  insertPriceSheet.run(formatSheetNo(), '标准价', codeToId['502016901010'], 2.4, '2026-04-02', '辅助价目表', timestamp);

  insertBill.run(formatBillNo(), '应收', '盛发', '2026-04', '月结30', 'RMB', 38.4, '未结清', '2026-04-03', '2026-04-10', '四月第一批对账', 2, timestamp);
  insertBill.run(formatBillNo(), '应收', '盛发', '2026-04', '月结30', 'RMB', 103, '已结算', '2026-04-03', '2026-04-10', '四月第二批对账', 4, timestamp);
}

export function initializeDatabase(userDataPath) {
  closeDatabase();
  fs.mkdirSync(userDataPath, { recursive: true });
  dbFilePath = path.join(userDataPath, 'factory-desk.db');
  db = new Database(dbFilePath);
  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS inventory_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      specification TEXT NOT NULL DEFAULT '',
      category TEXT NOT NULL,
      unit TEXT NOT NULL,
      safety_stock REAL NOT NULL DEFAULT 0,
      location TEXT NOT NULL DEFAULT '',
      stock_qty REAL NOT NULL DEFAULT 0,
      unit_price REAL NOT NULL DEFAULT 0,
      plating TEXT NOT NULL DEFAULT '',
      process_note TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS stock_orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_no TEXT NOT NULL UNIQUE,
      type TEXT NOT NULL CHECK(type IN ('入库', '出库')),
      business_type TEXT NOT NULL DEFAULT '',
      item_id INTEGER NOT NULL,
      delivery_no TEXT NOT NULL DEFAULT '',
      outsource_no TEXT NOT NULL DEFAULT '',
      process_no TEXT NOT NULL DEFAULT '',
      quantity REAL NOT NULL,
      unit_price REAL NOT NULL DEFAULT 0,
      total_amount REAL NOT NULL DEFAULT 0,
      partner TEXT NOT NULL,
      operator TEXT NOT NULL,
      order_date TEXT NOT NULL,
      plating TEXT NOT NULL DEFAULT '',
      remark TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      FOREIGN KEY(item_id) REFERENCES inventory_items(id)
    );

    CREATE TABLE IF NOT EXISTS price_sheets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sheet_no TEXT NOT NULL UNIQUE,
      partner TEXT NOT NULL,
      item_id INTEGER NOT NULL,
      unit_price REAL NOT NULL,
      effective_date TEXT NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1,
      remark TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      FOREIGN KEY(item_id) REFERENCES inventory_items(id)
    );

    CREATE TABLE IF NOT EXISTS bills (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bill_no TEXT NOT NULL UNIQUE,
      bill_type TEXT NOT NULL CHECK(bill_type IN ('应收', '应付')),
      partner TEXT NOT NULL,
      statement_month TEXT NOT NULL DEFAULT '',
      settlement_method TEXT NOT NULL DEFAULT '月结30',
      currency TEXT NOT NULL DEFAULT 'RMB',
      amount REAL NOT NULL,
      status TEXT NOT NULL,
      bill_date TEXT NOT NULL,
      due_date TEXT NOT NULL,
      remark TEXT NOT NULL DEFAULT '',
      stock_order_id INTEGER NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      FOREIGN KEY(stock_order_id) REFERENCES stock_orders(id)
    );

    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  // Shared web mode defaults to an empty database for production/testing readiness.
  // Historical sample data seeding is intentionally disabled.

  migrateLegacyPriceSheets();
  migrateBillsForStockOrderLink();
  migrateBusinessColumns();
  migrateBillPriceSnapshots();
  ensureNumberingDefaults();
  initializeOperations(db);
  initializeDocuments(db);
  syncMissingBillsForStockOrders();

  return dbFilePath;
}

function syncMissingBillsForStockOrders() {
  const missingOrders = db.prepare(`
    SELECT
      stock_orders.id,
      stock_orders.type,
      stock_orders.business_type AS businessType,
      stock_orders.partner,
      stock_orders.customer_id AS customerId,
      stock_orders.total_amount AS totalAmount,
      stock_orders.order_date AS orderDate,
      stock_orders.remark
    FROM stock_orders
    LEFT JOIN bills ON bills.stock_order_id = stock_orders.id
    WHERE bills.id IS NULL AND stock_orders.type = '出库' AND stock_orders.voided_at = '' AND stock_orders.billing_suppressed = 0
    ORDER BY stock_orders.id ASC
  `).all();

  missingOrders.forEach((order) => {
    syncBillForOrder(order);
  });
}

function migrateBillsForStockOrderLink() {
  const columns = db.prepare('PRAGMA table_info(bills)').all();
  const hasStockOrderId = columns.some((column) => column.name === 'stock_order_id');
  if (hasStockOrderId) {
    return;
  }

  db.exec(`
    ALTER TABLE bills RENAME TO bills_legacy;

    CREATE TABLE bills (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bill_no TEXT NOT NULL UNIQUE,
      bill_type TEXT NOT NULL CHECK(bill_type IN ('应收', '应付')),
      partner TEXT NOT NULL,
      amount REAL NOT NULL,
      status TEXT NOT NULL,
      bill_date TEXT NOT NULL,
      due_date TEXT NOT NULL,
      remark TEXT NOT NULL DEFAULT '',
      stock_order_id INTEGER NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      FOREIGN KEY(stock_order_id) REFERENCES stock_orders(id)
    );
  `);

  const legacyBills = db.prepare(`
    SELECT
      id,
      bill_no AS billNo,
      bill_type AS billType,
      partner,
      amount,
      status,
      bill_date AS billDate,
      due_date AS dueDate,
      remark,
      created_at AS createdAt
    FROM bills_legacy
    ORDER BY id ASC
  `).all();

  const outboundOrders = db.prepare(`
    SELECT id, partner, total_amount AS totalAmount, order_date AS orderDate
    FROM stock_orders
    WHERE type = '出库'
    ORDER BY id ASC
  `).all();

  const insertBill = db.prepare(`
    INSERT INTO bills
      (bill_no, bill_type, partner, amount, status, bill_date, due_date, remark, stock_order_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const usedOrderIds = new Set();
  legacyBills.forEach((bill) => {
    const matchedOrder = outboundOrders.find((order) => {
      if (usedOrderIds.has(order.id)) {
        return false;
      }
      return order.partner === bill.partner;
    });

    if (matchedOrder) {
      usedOrderIds.add(matchedOrder.id);
      insertBill.run(
        bill.billNo,
        bill.billType,
        bill.partner,
        bill.amount,
        bill.status,
        bill.billDate,
        bill.dueDate,
        bill.remark || '',
        matchedOrder.id,
        bill.createdAt || nowIso()
      );
    }
  });

  db.exec('DROP TABLE bills_legacy;');
}

function migrateLegacyPriceSheets() {
  const columns = db.prepare('PRAGMA table_info(price_sheets)').all();
  const hasItemId = columns.some((column) => column.name === 'item_id');
  const hasItemName = columns.some((column) => column.name === 'item_name');

  if (hasItemId || !hasItemName) {
    return;
  }

  db.exec(`
    ALTER TABLE price_sheets RENAME TO price_sheets_legacy;

    CREATE TABLE price_sheets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sheet_no TEXT NOT NULL UNIQUE,
      partner TEXT NOT NULL,
      item_id INTEGER NOT NULL,
      unit_price REAL NOT NULL,
      effective_date TEXT NOT NULL,
      remark TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      FOREIGN KEY(item_id) REFERENCES inventory_items(id)
    );
  `);

  const legacyRows = db.prepare(`
    SELECT
      price_sheets_legacy.sheet_no AS sheetNo,
      price_sheets_legacy.partner,
      price_sheets_legacy.item_name AS itemName,
      price_sheets_legacy.unit_price AS unitPrice,
      price_sheets_legacy.effective_date AS effectiveDate,
      price_sheets_legacy.remark,
      price_sheets_legacy.created_at AS createdAt
    FROM price_sheets_legacy
  `).all();

  const findItem = db.prepare('SELECT id FROM inventory_items WHERE name = ? LIMIT 1');
  const insertSheet = db.prepare(`
    INSERT INTO price_sheets
      (sheet_no, partner, item_id, unit_price, effective_date, remark, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  legacyRows.forEach((row) => {
    const item = findItem.get(row.itemName);
    if (item) {
      insertSheet.run(row.sheetNo, row.partner, item.id, row.unitPrice, row.effectiveDate, row.remark || '', row.createdAt || nowIso());
    }
  });

  db.exec('DROP TABLE price_sheets_legacy;');
}

function ensureColumn(tableName, columnName, definition) {
  const columns = db.prepare(`PRAGMA table_info(${tableName})`).all();
  const hasColumn = columns.some((column) => column.name === columnName);
  if (!hasColumn) {
    db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition};`);
  }
}

function migrateBillPriceSnapshots() {
  ensureColumn('bills', 'quantity', 'REAL');
  ensureColumn('bills', 'unit_price', 'REAL');
  // Preserve existing amounts, including bills that older versions repriced.
  // NULL marks legacy rows; a valid zero-price snapshot must never be overwritten.
  db.exec(`
    UPDATE bills
    SET quantity = (SELECT quantity FROM stock_orders WHERE id = bills.stock_order_id)
    WHERE quantity IS NULL;

    UPDATE bills
    SET unit_price = CASE
      WHEN ROUND(quantity * (SELECT unit_price FROM stock_orders WHERE id = bills.stock_order_id), 2) = amount
        THEN (SELECT unit_price FROM stock_orders WHERE id = bills.stock_order_id)
      WHEN quantity > 0 THEN amount / quantity
      ELSE 0
    END
    WHERE unit_price IS NULL;
  `);
}

function migrateBusinessColumns() {
  ensureColumn('inventory_items', 'specification', "TEXT NOT NULL DEFAULT ''");
  ensureColumn('inventory_items', 'plating', "TEXT NOT NULL DEFAULT ''");
  ensureColumn('inventory_items', 'process_note', "TEXT NOT NULL DEFAULT ''");
  ensureColumn('stock_orders', 'business_type', "TEXT NOT NULL DEFAULT ''");
  ensureColumn('stock_orders', 'delivery_no', "TEXT NOT NULL DEFAULT ''");
  ensureColumn('stock_orders', 'outsource_no', "TEXT NOT NULL DEFAULT ''");
  ensureColumn('stock_orders', 'process_no', "TEXT NOT NULL DEFAULT ''");
  ensureColumn('stock_orders', 'plating', "TEXT NOT NULL DEFAULT ''");
  ensureColumn('price_sheets', 'is_active', 'INTEGER NOT NULL DEFAULT 1');
  ensureColumn('bills', 'statement_month', "TEXT NOT NULL DEFAULT ''");
  ensureColumn('bills', 'settlement_method', "TEXT NOT NULL DEFAULT '月结30'");
  ensureColumn('bills', 'currency', "TEXT NOT NULL DEFAULT 'RMB'");

  db.exec(`
    UPDATE inventory_items
    SET specification = COALESCE(NULLIF(specification, ''), name)
    WHERE specification = '' OR specification IS NULL;

    UPDATE inventory_items
    SET process_note = COALESCE(NULLIF(process_note, ''), category)
    WHERE process_note = '' OR process_note IS NULL;

    UPDATE price_sheets
    SET partner = '标准价'
    WHERE partner = '' OR partner IS NULL;

    UPDATE stock_orders
    SET business_type = CASE
      WHEN type = '入库' THEN '正常入库'
      WHEN type = '出库' THEN '成品出货'
      ELSE ''
    END
    WHERE business_type = '' OR business_type IS NULL;

    UPDATE bills
    SET statement_month = substr(bill_date, 1, 7)
    WHERE statement_month = '' OR statement_month IS NULL;

    UPDATE bills
    SET settlement_method = '月结30'
    WHERE settlement_method = '' OR settlement_method IS NULL;

    UPDATE bills
    SET currency = 'RMB'
    WHERE currency = '' OR currency IS NULL;

    UPDATE bills
    SET status = CASE
      WHEN status IN ('已回款', '已付款', '已结算') THEN '已结算'
      WHEN status IN ('已作废', '部分收款') THEN status
      ELSE '未结清'
    END;

    DELETE FROM bills
    WHERE stock_order_id IN (SELECT id FROM stock_orders WHERE type != '出库');
  `);


}

function withFilters(baseSql, params = {}, dateColumn) {
  const clauses = [];
  const values = [];

  if (params.startDate) {
    clauses.push(`${dateColumn} >= ?`);
    values.push(params.startDate);
  }

  if (params.endDate) {
    clauses.push(`${dateColumn} <= ?`);
    values.push(params.endDate);
  }

  const sql = clauses.length ? `${baseSql} WHERE ${clauses.join(' AND ')}` : baseSql;
  return { sql, values };
}

function ensureNumberingDefaults() {
  const insert = db.prepare('INSERT OR IGNORE INTO app_settings (key, value) VALUES (?, ?)');
  Object.entries(NUMBERING_DEFAULTS).forEach(([key, value]) => {
    insert.run(key, value);
  });
}

export function getNumberingSettings() {
  try {
    const rows = db.prepare(`
      SELECT key, value
      FROM app_settings
      WHERE key IN ('inventoryCodeMode', 'deliveryNoMode', 'outsourceNoMode', 'processNoMode')
    `).all();
    const settings = { ...NUMBERING_DEFAULTS };
    rows.forEach((row) => {
      const mode = String(row.value || '').trim() === 'auto' ? 'auto' : 'manual';
      settings[row.key] = mode;
    });
    return settings;
  } catch {
    return { ...NUMBERING_DEFAULTS };
  }
}

export function updateNumberingSettings(payload = {}) {
  try {
    ensureNumberingDefaults();
    const allowed = Object.keys(NUMBERING_DEFAULTS);
    const update = db.prepare('UPDATE app_settings SET value = ? WHERE key = ?');
    allowed.forEach((key) => {
      if (payload[key] === undefined) {
        return;
      }
      const mode = String(payload[key]) === 'auto' ? 'auto' : 'manual';
      update.run(mode, key);
    });
    return getNumberingSettings();
  } catch {
    return { ...NUMBERING_DEFAULTS };
  }
}

export function getDatabasePath() {
  return dbFilePath;
}

export function closeDatabase() {
  if (db?.open) db.close();
}

export async function backupDatabaseTo(targetPath) {
  await db.backup(targetPath);
  return { ok: true, filePath: targetPath };
}

export function getInventoryItems() {
  refreshEffectivePrices();
  return db.prepare(`
    SELECT
      id,
      code,
      name,
      specification,
      category,
      unit,
      safety_stock AS safetyStock,
      location,
      stock_qty AS stockQty,
      unit_price AS unitPrice,
      plating,
      process_note AS processNote,
      updated_at AS updatedAt
    FROM inventory_items
    ORDER BY code ASC
  `).all();
}

export function createInventoryItem(payload) {
  return db.transaction(() => {
    const settings = getNumberingSettings();
    const autoCode = settings.inventoryCodeMode === 'auto';
    const generatedCode = autoCode ? createAutoCode(NUMBERING_CODEBOOK.inventoryCodeMode) : '';
    const finalCode = String(autoCode ? generatedCode : (payload.code || '')).trim();
    assertRequired(finalCode, '物料编码');
    assertRequired(payload.name, '品名规格');
    assertRequired(payload.unit, '单位');

    const exists = db.prepare('SELECT id FROM inventory_items WHERE code = ?').get(finalCode);
    if (exists) {
      throw new Error('物料编码已存在');
    }

    const stockQty = quantityNumber(payload.stockQty ?? 0, '库存数量');
    const safetyStock = nonnegative(payload.safetyStock ?? 0, '安全库存');
    const unitPrice = nonnegative(payload.unitPrice ?? 0, '单价');
    const timestamp = nowIso();

    const result = db.prepare(`
      INSERT INTO inventory_items
        (
          code, name, category, unit, safety_stock, location, stock_qty, unit_price,
          created_at, updated_at, specification, plating, process_note
        )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      finalCode,
      payload.name.trim(),
      (payload.category || '未分类').trim(),
      payload.unit.trim(),
      safetyStock,
      (payload.location || '').trim(),
      stockQty,
      unitPrice,
      timestamp,
      timestamp,
      (payload.specification || payload.name).trim(),
      (payload.plating || '').trim(),
      (payload.processNote || payload.category || '').trim()
    );

    recordInventoryMovement(result.lastInsertRowid, stockQty, { type: '期初建账', actor: payload.actor });
    return { ok: true, itemId: result.lastInsertRowid };
  })();
}

export function updateInventoryItem(payload) {
  return db.transaction(() => {
    assertRequired(payload.id, '物料');

    const existing = db.prepare('SELECT * FROM inventory_items WHERE id = ?').get(Number(payload.id));
    if (!existing) {
      throw new Error('物料不存在');
    }

    const specification = String(payload.specification ?? payload.name ?? existing.specification).trim();
    assertRequired(specification, '规格');
    // Keep the stored name unless a new one is sent (partial updates such as safety stock must not rename).
    const name = String(payload.name ?? (payload.specification !== undefined && existing.name === existing.specification ? specification : existing.name)).trim() || specification;
    const category = String(payload.category ?? existing.category).trim();
    const plating = String(payload.plating ?? existing.plating).trim();
    const processNote = String(payload.processNote ?? payload.vendor ?? existing.process_note).trim();
    const unit = String(payload.unit ?? existing.unit).trim();
    assertRequired(unit, '单位');
    if (unit !== existing.unit && (existing.stock_qty !== 0 || db.prepare('SELECT 1 FROM inventory_ledger WHERE item_id = ? AND quantity_delta != 0').get(existing.id))) {
      throw new Error('该物料已有库存或库存流水，不能变更计量单位，请新建物料');
    }
    const location = String(payload.location ?? existing.location).trim();
    const safetyStock = nonnegative(payload.safetyStock ?? existing.safety_stock, '安全库存');
    // Stock is only changed by orders and 盘点 (adjustInventory), which check the pre-count balance.
    const stockQty = existing.stock_qty;
    const unitPrice = nonnegative(payload.unitPrice ?? existing.unit_price, '单价');

    db.prepare(`
      UPDATE inventory_items
      SET
        name = ?,
        specification = ?,
        category = ?,
        unit = ?,
        plating = ?,
        process_note = ?,
        location = ?,
        safety_stock = ?,
        stock_qty = ?,
        unit_price = ?,
        updated_at = ?
      WHERE id = ?
    `).run(
      name,
      specification,
      category,
      unit,
      plating,
      processNote,
      location,
      safetyStock,
      stockQty,
      unitPrice,
      nowIso(),
      Number(payload.id)
    );

    refreshEffectivePrices();
    return { ok: true };
  })();
}

export function deleteInventoryItem(itemId) {
  const id = Number(itemId);
  const existing = db.prepare('SELECT id, code, stock_qty FROM inventory_items WHERE id = ?').get(id);
  if (!existing) {
    throw new Error('物料不存在');
  }

  if (existing.stock_qty !== 0 || db.prepare('SELECT 1 FROM inventory_ledger WHERE item_id = ? AND quantity_delta != 0').get(id)) {
    throw new Error('物料存在库存或库存变动记录，不能删除');
  }

  const relatedOrders = db.prepare('SELECT COUNT(*) AS total FROM stock_orders WHERE item_id = ?').get(id).total;
  if (Number(relatedOrders) > 0) {
    throw new Error('该物料已被出入库单引用，不能删除');
  }

  const run = db.transaction(() => {
    db.prepare('DELETE FROM price_sheets WHERE item_id = ?').run(id);
    db.prepare('DELETE FROM inventory_ledger WHERE item_id = ?').run(id);
    db.prepare('DELETE FROM inventory_items WHERE id = ?').run(id);
  });

  run();
  return { ok: true };
}

export function getStockOrders(filters = {}) {
  const query = withFilters(`
    SELECT
      stock_orders.id,
      stock_orders.order_no AS orderNo,
      stock_orders.type,
      stock_orders.business_type AS businessType,
      stock_orders.item_id AS itemId,
      stock_orders.delivery_no AS deliveryNo,
      stock_orders.outsource_no AS outsourceNo,
      stock_orders.process_no AS processNo,
      inventory_items.code AS itemCode,
      inventory_items.name AS itemName,
      inventory_items.specification AS specification,
      inventory_items.category AS category,
      inventory_items.unit,
      stock_orders.quantity,
      stock_orders.unit_price AS unitPrice,
      stock_orders.total_amount AS totalAmount,
      stock_orders.partner,
      stock_orders.customer_id AS customerId,
      stock_orders.operator,
      stock_orders.order_date AS orderDate,
      COALESCE(NULLIF(stock_orders.plating, ''), inventory_items.plating) AS plating,
      stock_orders.remark,
      bills.id AS billId,
      bills.bill_no AS billNo
    FROM stock_orders
    INNER JOIN inventory_items ON inventory_items.id = stock_orders.item_id
    LEFT JOIN bills ON bills.stock_order_id = stock_orders.id
  `, filters, 'stock_orders.order_date');

  let sql = query.sql;
  const values = [...query.values];

  if (filters.type) {
    sql += query.values.length ? ' AND stock_orders.type = ?' : ' WHERE stock_orders.type = ?';
    values.push(filters.type);
  }

  sql += sql.includes(' WHERE ') || /\n\s*WHERE /.test(sql) ? " AND stock_orders.voided_at = ''" : " WHERE stock_orders.voided_at = ''";
  return db.prepare(`${sql} ORDER BY stock_orders.order_date DESC, stock_orders.id DESC`).all(...values);
}

export function getPriceSheets(filters = {}) {
  refreshEffectivePrices();
  const query = withFilters(`
    SELECT
      price_sheets.id,
      price_sheets.sheet_no AS sheetNo,
      price_sheets.partner,
      inventory_items.id AS itemId,
      inventory_items.code AS itemCode,
      inventory_items.name AS itemName,
      inventory_items.specification AS specification,
      inventory_items.unit,
      inventory_items.stock_qty AS stockQty,
      inventory_items.plating,
      inventory_items.process_note AS processNote,
      inventory_items.category,
      price_sheets.unit_price AS unitPrice,
      price_sheets.effective_date AS effectiveDate,
      price_sheets.is_active AS isActive,
      CASE WHEN price_sheets.is_active = 1 THEN '生效中' WHEN price_sheets.effective_date > ? THEN '待生效' ELSE '历史价格' END AS priceStatus,
      price_sheets.remark
    FROM price_sheets
    INNER JOIN inventory_items ON inventory_items.id = price_sheets.item_id
  `, filters, 'effective_date');

  return db.prepare(`${query.sql} ORDER BY price_sheets.is_active DESC, price_sheets.effective_date DESC, price_sheets.id DESC`).all(businessToday(), ...query.values);
}

export function getBills(filters = {}) {
  const query = withFilters(`
    SELECT
      bills.id,
      bills.bill_no AS billNo,
      bills.bill_type AS billType,
      bills.partner,
      bills.statement_month AS statementMonth,
      bills.settlement_method AS settlementMethod,
      bills.currency,
      bills.amount,
      bills.status,
      bills.customer_id AS customerId,
      bills.voided_at AS voidedAt,
      bills.void_reason AS voidReason,
      bills.legacy_settled_cents / 100.0 AS legacySettledAmount,
      COALESCE((SELECT SUM(amount_cents) / 100.0 FROM receipts WHERE bill_id = bills.id AND voided_at = ''), 0) AS receivedAmount,
      (ROUND(bills.amount * 100) - bills.legacy_settled_cents - COALESCE((SELECT SUM(amount_cents) FROM receipts WHERE bill_id = bills.id AND voided_at = ''), 0)) / 100.0 AS balanceAmount,
      bills.bill_date AS billDate,
      bills.due_date AS dueDate,
      bills.remark,
      bills.stock_order_id AS stockOrderId,
      stock_orders.order_no AS stockOrderNo,
      stock_orders.voided_at AS stockOrderVoidedAt,
      stock_orders.type AS stockOrderType,
      stock_orders.business_type AS businessType,
      stock_orders.delivery_no AS deliveryNo,
      stock_orders.outsource_no AS outsourceNo,
      stock_orders.process_no AS processNo,
      stock_orders.order_date AS outboundDate,
      bills.quantity,
      bills.unit_price AS unitPrice,
      bills.partner AS vendor,
      COALESCE(NULLIF(stock_orders.plating, ''), inventory_items.plating) AS plating,
      inventory_items.code AS itemCode,
      inventory_items.name AS itemName,
      inventory_items.specification AS specification,
      inventory_items.category AS category
    FROM bills
    INNER JOIN stock_orders ON stock_orders.id = bills.stock_order_id
    INNER JOIN inventory_items ON inventory_items.id = stock_orders.item_id
  `, filters, 'stock_orders.order_date');

  return db.prepare(`${query.sql} ORDER BY bills.bill_date DESC, bills.id DESC`).all(...query.values);
}

export function getDashboardData() {
  const today = businessToday();
  const monthStart = `${today.slice(0, 7)}-01`;

  const inboundToday = db.prepare(`
    SELECT COALESCE(SUM(quantity), 0) AS total
    FROM stock_orders
    WHERE type = '入库' AND voided_at = '' AND order_date = ?
  `).get(today).total;

  const outboundToday = db.prepare(`
    SELECT COALESCE(SUM(quantity), 0) AS total
    FROM stock_orders
    WHERE type = '出库' AND voided_at = '' AND order_date = ?
  `).get(today).total;

  const warningCount = db.prepare(`
    SELECT COUNT(*) AS total
    FROM inventory_items
    WHERE stock_qty < safety_stock
  `).get().total;

  const monthReceivable = db.prepare(`
    SELECT COALESCE(SUM(ROUND(amount * 100)), 0) / 100.0 AS total
    FROM bills
    WHERE bill_type = '应收' AND voided_at = '' AND bill_date >= ? AND bill_date <= ?
  `).get(monthStart, today).total;

  const accountStats = db.prepare(`
    SELECT
      SUM(CASE WHEN bill_type = '应收' THEN ROUND(amount * 100) ELSE 0 END) / 100.0 AS receivable,
      SUM(CASE WHEN bill_type = '应付' THEN ROUND(amount * 100) ELSE 0 END) / 100.0 AS payable,
      SUM(legacy_settled_cents) / 100.0 AS legacySettledAmount
    FROM bills WHERE voided_at = ''
  `).get();

  const lowStockItems = db.prepare(`
    SELECT code, name, unit, stock_qty AS stockQty, safety_stock AS safetyStock
    FROM inventory_items
    WHERE stock_qty < safety_stock
    ORDER BY (safety_stock - stock_qty) DESC
    LIMIT 5
  `).all();

  const recentOrders = getStockOrders({}).slice(0, 5);

  // Inbound goods carry no amount; reports use shipment amounts plus quantities per business-type label.
  const months = new Map();
  for (const row of db.prepare(`
    SELECT substr(order_date, 1, 7) AS month, type, business_type AS businessType,
      SUM(quantity) AS quantity, SUM(total_amount) AS amount
    FROM stock_orders
    WHERE voided_at = ''
    GROUP BY 1, 2, 3
    ORDER BY 1 ASC
  `).all()) {
    if (!months.has(row.month)) months.set(row.month, { month: row.month, outboundAmount: 0, quantities: {} });
    const entry = months.get(row.month);
    const label = row.businessType || row.type;
    entry.quantities[label] = Number(((entry.quantities[label] || 0) + Number(row.quantity || 0)).toFixed(6));
  }
  // 出货金额 = valid (not voided) receivable bills by bill month, the same basis as 应收.
  for (const row of db.prepare(`SELECT substr(bill_date, 1, 7) AS month, SUM(ROUND(amount * 100)) AS cents
    FROM bills WHERE voided_at = '' AND bill_type = '应收' GROUP BY 1`).all()) {
    if (!months.has(row.month)) months.set(row.month, { month: row.month, outboundAmount: 0, quantities: {} });
    months.get(row.month).outboundAmount = Number(row.cents || 0) / 100;
  }
  const monthlyTrend = [...months.values()].sort((a, b) => a.month.localeCompare(b.month));

  return {
    summaryCards: [
      { label: '今日入库', value: `${Number(inboundToday).toFixed(0)}`, hint: '按数量汇总', tone: 'amber', suffix: '件/箱/kg' },
      { label: '今日出库', value: `${Number(outboundToday).toFixed(0)}`, hint: '按数量汇总', tone: 'green', suffix: '件/箱/kg' },
      { label: '库存预警', value: `${warningCount}`, hint: '低于安全库存', tone: 'red', suffix: '项' },
      { label: '本月应收', value: `¥${Number(monthReceivable).toFixed(2)}`, hint: '按账单统计', tone: 'blue', suffix: '' }
    ],
    warningItems: lowStockItems,
    recentOrders,
    accountStats: {
      receivable: Number(accountStats.receivable || 0),
      payable: Number(accountStats.payable || 0),
      cashBalance: Number(db.prepare("SELECT COALESCE(SUM(amount_cents), 0) / 100.0 AS total FROM receipts WHERE voided_at = ''").get().total),
      legacySettledAmount: Number(accountStats.legacySettledAmount || 0)
    },
    monthlyTrend
  };
}

// Price used when a 成品出货 is billed. An explicit price (even 0) is kept; otherwise the
// dated price list decides, and a missing price is refused instead of silently billing 0.
function billingUnitPrice(explicitPrice, itemId, orderDate) {
  if (explicitPrice !== undefined && explicitPrice !== null && explicitPrice !== '') return nonnegative(explicitPrice, '单价');
  const price = effectivePrice(itemId, orderDate);
  if (!(price > 0)) throw new Error('该物料在业务日期没有有效单价，请先在辅助价目中设置价格');
  return price;
}

function normalizeBusinessType(type, value, existing) {
  if (!['入库', '出库'].includes(type)) throw new Error('单据类型不正确');
  const sameType = Boolean(existing && existing.type === type);
  let label = String(value ?? '').trim();
  if (!label) label = sameType && existing.businessType ? existing.businessType : defaultBusinessType(type);
  const allowed = type === '入库' ? INBOUND_TYPES : OUTBOUND_TYPES;
  // Legacy labels already stored on a record stay editable; new records use the fixed list.
  if (!allowed.includes(label) && !(sameType && label === existing.businessType)) {
    throw new Error(`${type}业务类型只能是：${allowed.join('、')}`);
  }
  return label;
}

function orderBatch(orderId) {
  return db.prepare('SELECT customer_id AS customerId, item_id AS itemId, process_no AS processNo FROM stock_orders WHERE id = ?').get(Number(orderId));
}

// Re-checks every touched batch after a change, inside the same transaction, so
// receipts, shipments, blank returns and rework shipments always stay consistent.
function assertBatches(keys, upstream = false) {
  const seen = new Set();
  for (const key of keys) {
    const processNo = String(key?.processNo || '').trim();
    if (!processNo || seen.has(batchKey(key))) continue;
    seen.add(batchKey(key));
    const orders = db.prepare(`SELECT type, business_type AS businessType, quantity FROM stock_orders
      WHERE voided_at = '' AND customer_id IS ? AND item_id = ? AND process_no = ?`).all(key.customerId ?? null, Number(key.itemId), processNo);
    const problem = batchProblem(summarizeBatch(orders), processNo, upstream);
    if (problem) throw new Error(problem);
  }
}

function freeOutboundSourceHint(businessType) {
  return businessType === '退胚' ? '收货' : '不良退回';
}

export function createStockOrder(payload) {
  const settings = getNumberingSettings();
  const businessType = normalizeBusinessType(payload.type, payload.businessType);
  const freeOutbound = isFreeOutbound({ businessType });
  const isOutbound = payload.type === '出库';
  const inputDeliveryNo = String(payload.deliveryNo || '').trim();
  const inputOutsourceNo = String(payload.outsourceNo || '').trim();
  const inputProcessNo = String(payload.processNo || '').trim();
  if (freeOutbound && !inputProcessNo) throw new Error(`${businessType}须选择原${freeOutboundSourceHint(businessType)}批次的加工单号`);
  const deliveryNo = settings.deliveryNoMode === 'auto'
    ? (inputDeliveryNo || createAutoCode(isOutbound ? NUMBERING_CODEBOOK.deliveryNoModeOutbound : NUMBERING_CODEBOOK.deliveryNoModeInbound))
    : inputDeliveryNo;
  const outsourceNo = settings.outsourceNoMode === 'auto'
    ? (inputOutsourceNo || createAutoCode(NUMBERING_CODEBOOK.outsourceNoMode))
    : inputOutsourceNo;
  // 加工单号 follows only its own numbering rule (inbound and outbound alike).
  const processNo = settings.processNoMode === 'auto'
    ? (inputProcessNo || createAutoCode(NUMBERING_CODEBOOK.processNoMode))
    : inputProcessNo;

  if (!['入库', '出库'].includes(payload.type)) throw new Error('单据类型不正确');
  validDate(payload.orderDate, '业务日期');
  assertRequired(payload.partner, '客户');
  assertRequired(payload.operator, '制表人');
  assertRequired(payload.orderDate, '业务日期');
  assertRequired(deliveryNo, payload.type === '出库' ? '送货单号' : '回库单号');

  const item = db.prepare(`
    SELECT id, code, name, stock_qty AS stockQty, unit, unit_price AS unitPrice, plating
    FROM inventory_items
    WHERE id = ?
  `).get(payload.itemId);

  if (!item) {
    throw new Error('未找到对应库存物料');
  }

  const quantity = quantityNumber(payload.quantity, '数量');
  // Inbound goods are the customer's own material and free outbound types carry no processing fee.
  const unitPrice = freeOutbound || payload.type === '入库' ? 0 : billingUnitPrice(payload.unitPrice, payload.itemId, payload.orderDate);

  if (!quantity || quantity <= 0) {
    throw new Error('数量必须大于 0');
  }

  if (payload.type === '出库' && Number(item.stockQty) < quantity) {
    throw new Error(`库存不足，当前仅剩 ${item.stockQty}${item.unit}`);
  }

  const totalAmount = lineAmount(quantity, unitPrice);
  const orderNo = formatOrderNo(payload.type === '入库' ? 'IN' : 'OUT');
  const timestamp = nowIso();
  let createdOrderId = null;

  const run = db.transaction(() => {
    const result = db.prepare(`
      INSERT INTO stock_orders
        (
          order_no, type, business_type, item_id, delivery_no, outsource_no, process_no,
          quantity, unit_price, total_amount, partner, operator, order_date, plating, remark, created_at
        )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      orderNo,
      payload.type,
      businessType,
      payload.itemId,
      deliveryNo,
      outsourceNo,
      processNo,
      quantity,
      unitPrice,
      totalAmount,
      payload.partner,
      payload.operator,
      payload.orderDate,
      String(payload.plating || item.plating || '').trim(),
      payload.remark || '',
      timestamp
    );
    createdOrderId = result.lastInsertRowid;
    const customer = resolveCustomer(payload);
    if (!customer.customerId) throw new Error('请选择客户档案');
    db.prepare('UPDATE stock_orders SET customer_id = ?, partner = ?, billing_suppressed = ? WHERE id = ?')
      .run(customer.customerId, customer.partner, freeOutbound || payload.autoCreateBill === false ? 1 : 0, createdOrderId);

    const delta = payload.type === '入库' ? quantity : -quantity;
    db.prepare(`
      UPDATE inventory_items
      SET
        stock_qty = ROUND(stock_qty + ?, 6),
        updated_at = ?
      WHERE id = ?
    `).run(delta, timestamp, payload.itemId);
    recordInventoryMovement(payload.itemId, delta, { orderId: createdOrderId, type: freeOutbound ? businessType : payload.type, date: payload.orderDate,
      reference: deliveryNo, actor: payload.actor || payload.operator, remark: payload.remark });

    if (payload.autoCreateBill !== false) {
      syncBillForOrder({
        id: createdOrderId,
        actor: payload.actor,
        type: payload.type,
        businessType,
        partner: payload.partner,
        totalAmount,
        orderDate: payload.orderDate,
        remark: payload.remark || ''
      });
    }
    assertBatches([orderBatch(createdOrderId)], !freeOutbound);
  });

  run();

  return {
    ok: true,
    id: createdOrderId,
    orderNo,
    totalAmount
  };
}

function adjustInventoryForOrder(itemId, quantityDelta) {
  const current = db.prepare('SELECT stock_qty FROM inventory_items WHERE id = ?').get(itemId);
  if (!current || Number((current.stock_qty + quantityDelta).toFixed(6)) < 0) throw new Error('撤销后库存不足，无法操作');
  db.prepare('UPDATE inventory_items SET stock_qty = ROUND(stock_qty + ?, 6), updated_at = ? WHERE id = ?').run(quantityDelta, nowIso(), itemId);
}

export function updateStockOrder(payload) {
  const settings = getNumberingSettings();
  assertRequired(payload.id, '单据');
  if (!['入库', '出库'].includes(payload.type)) throw new Error('单据类型不正确');
  validDate(payload.orderDate, '业务日期');
  assertRequired(payload.partner, '客户');
  assertRequired(payload.operator, '制表人');
  assertRequired(payload.orderDate, '业务日期');

  const existing = db.prepare(`
    SELECT
      id,
      type,
      business_type AS businessType,
      item_id AS itemId,
      quantity,
      unit_price AS unitPrice,
      delivery_no AS deliveryNo,
      outsource_no AS outsourceNo,
      process_no AS processNo, customer_id AS customerId, voided_at AS voidedAt
    FROM stock_orders
    WHERE id = ?
  `).get(payload.id);

  if (!existing) {
    throw new Error('未找到单据');
  }

  if (existing.voidedAt) throw new Error('已撤销的单据不能修改');
  const businessType = normalizeBusinessType(payload.type, payload.businessType, existing);
  const freeOutbound = isFreeOutbound({ businessType });
  if (payload.type !== existing.type) throw new Error('入库与出库不能互相修改，请撤销后重新登记');
  if ((freeOutbound || isFreeOutbound(existing)) && businessType !== existing.businessType) {
    throw new Error('出货、退胚与返工出货类型不能互相修改，请撤销后重新登记');
  }
  const linkedBill = db.prepare('SELECT * FROM bills WHERE stock_order_id = ?').get(Number(payload.id));
  if (linkedBill) {
    const paid = billPayment(linkedBill);
    if (linkedBill.voided_at || paid.receivedCents || paid.legacyCents) throw new Error('关联账单已作废或已有收款，不能修改出货记录');
    if (payload.type !== existing.type || Number(payload.itemId) !== existing.itemId ||
      (payload.unitPrice !== undefined && Number(payload.unitPrice) !== existing.unitPrice) ||
      (payload.customerId && Number(payload.customerId) !== existing.customerId) ||
      String(payload.partner).trim() !== linkedBill.partner) throw new Error('已开账单的物料、客户与开单价不可变更，请撤销原单后重新开单');
  }
  const targetItemId = Number(payload.itemId);
  const targetItem = db.prepare(`
    SELECT id, stock_qty AS stockQty, unit, unit_price AS unitPrice, plating
    FROM inventory_items
    WHERE id = ?
  `).get(targetItemId);

  if (!targetItem) {
    throw new Error('未找到对应库存物料');
  }

  const quantity = quantityNumber(payload.quantity, '数量');
  if (!quantity || quantity <= 0) {
    throw new Error('数量必须大于 0');
  }

  // Keep the price the record was saved with; a changed material (only possible without a bill) is re-priced.
  const unitPrice = freeOutbound || payload.type === '入库' ? 0
    : targetItemId === existing.itemId && payload.unitPrice === undefined ? existing.unitPrice
      : billingUnitPrice(payload.unitPrice, targetItemId, payload.orderDate);
  const totalAmount = lineAmount(quantity, unitPrice);
  const timestamp = nowIso();

  const isOutbound = payload.type === '出库';
  const inputDeliveryNo = String(payload.deliveryNo || '').trim();
  const inputOutsourceNo = String(payload.outsourceNo || '').trim();
  const inputProcessNo = String(payload.processNo || '').trim();
  const deliveryNo = settings.deliveryNoMode === 'auto'
    ? (inputDeliveryNo || existing.deliveryNo || createAutoCode(isOutbound ? NUMBERING_CODEBOOK.deliveryNoModeOutbound : NUMBERING_CODEBOOK.deliveryNoModeInbound))
    : inputDeliveryNo;
  const outsourceNo = settings.outsourceNoMode === 'auto'
    ? (inputOutsourceNo || existing.outsourceNo || createAutoCode(NUMBERING_CODEBOOK.outsourceNoMode))
    : inputOutsourceNo;
  const processNo = settings.processNoMode === 'auto'
    ? (inputProcessNo || existing.processNo || createAutoCode(NUMBERING_CODEBOOK.processNoMode))
    : inputProcessNo;

  assertRequired(deliveryNo, payload.type === '出库' ? '送货单号' : '回库单号');
  if (freeOutbound && !processNo) throw new Error(`${businessType}须选择原${freeOutboundSourceHint(businessType)}批次的加工单号`);

  const existingEffect = existing.type === '入库' ? Number(existing.quantity) : -Number(existing.quantity);
  const newEffect = payload.type === '入库' ? quantity : -quantity;

  const run = db.transaction(() => {
    const currentOld = db.prepare('SELECT stock_qty AS stockQty, unit FROM inventory_items WHERE id = ?').get(Number(existing.itemId));
    const currentNew = Number(existing.itemId) === targetItemId
      ? currentOld
      : db.prepare('SELECT stock_qty AS stockQty, unit FROM inventory_items WHERE id = ?').get(targetItemId);

    if (!currentOld || !currentNew) {
      throw new Error('库存物料不存在');
    }

    if (Number(existing.itemId) === targetItemId) {
      const finalStock = Number((Number(currentOld.stockQty) - existingEffect + newEffect).toFixed(6));
      if (finalStock < 0) {
        throw new Error(`库存不足，当前仅剩 ${Number(currentOld.stockQty)}${currentOld.unit}`);
      }
      db.prepare(`
        UPDATE inventory_items
        SET
          stock_qty = ?,
          updated_at = ?
        WHERE id = ?
      `).run(finalStock, timestamp, targetItemId);
    } else {
      const oldFinalStock = Number((Number(currentOld.stockQty) - existingEffect).toFixed(6));
      const newFinalStock = Number((Number(currentNew.stockQty) + newEffect).toFixed(6));
      if (oldFinalStock < 0 || newFinalStock < 0) {
        throw new Error(`库存不足，当前仅剩 ${Number(currentNew.stockQty)}${currentNew.unit}`);
      }
      db.prepare(`
        UPDATE inventory_items
        SET
          stock_qty = ?,
          updated_at = ?
        WHERE id = ?
      `).run(oldFinalStock, timestamp, Number(existing.itemId));
      db.prepare(`
        UPDATE inventory_items
        SET
          stock_qty = ?,
          updated_at = ?
        WHERE id = ?
      `).run(newFinalStock, timestamp, targetItemId);
    }

    db.prepare(`
      UPDATE stock_orders
      SET
        type = ?, business_type = ?, item_id = ?, delivery_no = ?, outsource_no = ?, process_no = ?,
        quantity = ?, unit_price = ?, total_amount = ?, partner = ?, operator = ?, order_date = ?, plating = ?, remark = ?
      WHERE id = ?
    `).run(
      payload.type,
      businessType,
      targetItemId,
      deliveryNo,
      outsourceNo,
      processNo,
      quantity,
      unitPrice,
      totalAmount,
      payload.partner,
      payload.operator,
      payload.orderDate,
      String(payload.plating || targetItem.plating || '').trim(),
      payload.remark || '',
      Number(payload.id)
    );

    const customer = resolveCustomer(payload, existing.customerId);
    db.prepare('UPDATE stock_orders SET customer_id = ?, partner = ? WHERE id = ?').run(customer.customerId,
      linkedBill ? linkedBill.partner : customer.partner, Number(payload.id));
    const details = { orderId: Number(payload.id), type: '单据修正', date: payload.orderDate, reference: deliveryNo, actor: payload.actor || payload.operator };
    if (existing.itemId === targetItemId) recordInventoryMovement(targetItemId, Number((newEffect - existingEffect).toFixed(6)), details);
    else {
      recordInventoryMovement(existing.itemId, -existingEffect, details);
      recordInventoryMovement(targetItemId, newEffect, details);
    }
    syncBillForOrder({
      id: Number(payload.id), actor: payload.actor,
      type: payload.type,
      businessType,
      partner: payload.partner,
      totalAmount,
      orderDate: payload.orderDate,
      remark: payload.remark || ''
    });
    assertBatches([{ customerId: existing.customerId, itemId: existing.itemId, processNo: existing.processNo }, orderBatch(payload.id)], !freeOutbound);
  });

  run();
  return { ok: true };
}

export function deleteStockOrder(orderId, options = {}) {
  return db.transaction(() => {
    const existing = db.prepare('SELECT * FROM stock_orders WHERE id = ?').get(Number(orderId));
    if (!existing || existing.voided_at) throw new Error('单据不存在或已撤销');
    const linkedBill = db.prepare('SELECT * FROM bills WHERE stock_order_id = ?').get(existing.id);
    if (linkedBill && !linkedBill.voided_at) {
      if (!options.cascadeBill) throw new Error('该出库单已绑定账单，请同时作废对应账单');
      voidBill(linkedBill.id, { reason: '关联出货单撤销', actor: options.actor });
    }
    const delta = existing.type === '入库' ? -existing.quantity : existing.quantity;
    adjustInventoryForOrder(existing.item_id, delta);
    recordInventoryMovement(existing.item_id, delta, { orderId: existing.id, type: '单据撤销', reference: existing.delivery_no, actor: options.actor });
    db.prepare('UPDATE stock_orders SET voided_at = ? WHERE id = ?').run(nowIso(), existing.id);
    assertBatches([{ customerId: existing.customer_id, itemId: existing.item_id, processNo: existing.process_no }], true);
    return { ok: true };
  })();
}

export function createPriceSheet(payload) {
  assertRequired(payload.itemId, '物料');
  validDate(payload.effectiveDate, '生效日期');
  const unitPrice = nonnegative(payload.unitPrice, '单价');
  if (!db.prepare('SELECT 1 FROM inventory_items WHERE id = ?').get(Number(payload.itemId))) throw new Error('物料不存在');
  return db.transaction(() => {
    const sheetNo = formatSheetNo();
    const result = db.prepare(`INSERT INTO price_sheets (sheet_no, partner, item_id, unit_price, effective_date, is_active, remark, created_at)
      VALUES (?, ?, ?, ?, ?, 0, ?, ?)`).run(sheetNo, payload.partner || '标准价', Number(payload.itemId), unitPrice,
      payload.effectiveDate, payload.remark || '', nowIso());
    refreshEffectivePrices();
    return { ok: true, sheetNo, id: Number(result.lastInsertRowid) };
  })();
}

export function saveMaterialPrice(payload) {
  validDate(payload.effectiveDate, '生效日期');
  nonnegative(payload.unitPrice, '单价');
  return db.transaction(() => {
    let itemId = Number(payload.itemId);
    const material = { name: payload.specification, specification: payload.specification, unit: payload.unit,
      category: payload.category, plating: payload.plating, processNote: payload.vendor, actor: payload.actor };
    if (itemId) updateInventoryItem({ ...material, id: itemId });
    else itemId = Number(createInventoryItem({ ...material, code: payload.code, unitPrice: 0 }).itemId);
    const result = createPriceSheet({ itemId, unitPrice: payload.unitPrice, effectiveDate: payload.effectiveDate, remark: payload.vendor || '' });
    return { ...result, itemId };
  })();
}

export function updatePriceSheet(payload) {
  assertRequired(payload.id, '单价表');
  assertRequired(payload.itemId, '物料');
  assertRequired(payload.effectiveDate, '生效日期');

  const existing = db.prepare('SELECT id, item_id AS itemId FROM price_sheets WHERE id = ?').get(Number(payload.id));
  if (!existing) {
    throw new Error('未找到单价记录');
  }
  if (Number(payload.itemId) !== existing.itemId) throw new Error('价目记录不能改到其他物料，请在对应物料下新增价目');

  return createPriceSheet(payload);
}

export function deletePriceSheet(id) {
  const target = db.prepare('SELECT item_id AS itemId FROM price_sheets WHERE id = ?').get(Number(id));
  if (!target) throw new Error('未找到单价记录');
  return db.transaction(() => {
    db.prepare('DELETE FROM price_sheets WHERE id = ?').run(Number(id));
    db.prepare('UPDATE inventory_items SET unit_price = 0 WHERE id = ?').run(target.itemId);
    refreshEffectivePrices();
    return { ok: true };
  })();
}

export function getStockOrderDetail(orderId) {
  const order = db.prepare(`
    SELECT
      stock_orders.id,
      stock_orders.order_no AS orderNo,
      stock_orders.type,
      stock_orders.business_type AS businessType,
      stock_orders.delivery_no AS deliveryNo,
      stock_orders.outsource_no AS outsourceNo,
      stock_orders.process_no AS processNo,
      stock_orders.quantity,
      stock_orders.unit_price AS unitPrice,
      stock_orders.total_amount AS totalAmount,
      stock_orders.partner,
      stock_orders.customer_id AS customerId,
      stock_orders.operator,
      stock_orders.order_date AS orderDate,
      COALESCE(NULLIF(stock_orders.plating, ''), inventory_items.plating) AS plating,
      stock_orders.remark,
      inventory_items.code AS itemCode,
      inventory_items.name AS itemName,
      inventory_items.specification AS specification,
      inventory_items.category,
      inventory_items.unit,
      inventory_items.location
    FROM stock_orders
    INNER JOIN inventory_items ON inventory_items.id = stock_orders.item_id
    WHERE stock_orders.id = ?
  `).get(orderId);

  if (!order) {
    throw new Error('未找到单据');
  }

  return order;
}

export function createBill(payload) {
  assertRequired(payload.stockOrderId, '业务单');
  const order = getStockOrderForBilling(Number(payload.stockOrderId));
  if (!order || order.voidedAt || order.type !== '出库') throw new Error('账单必须绑定有效的出库单');
  if (isFreeOutbound(order)) throw new Error('退胚和返工出货不产生加工费账单');
  if (db.prepare('SELECT 1 FROM bills WHERE stock_order_id = ?').get(order.id)) throw new Error('该出库单已存在对应账单（含作废记录）');
  if (payload.status && payload.status !== '未结清') throw new Error('结清状态由收款流水自动计算，请到收款登记操作');
  return db.transaction(() => {
    const derived = deriveBillPayloadFromOrder(order);
    const billNo = formatBillNo();
    const result = db.prepare(`INSERT INTO bills (bill_no, bill_type, partner, statement_month, settlement_method,
      currency, amount, status, bill_date, due_date, remark, stock_order_id, created_at, quantity, unit_price, customer_id, legacy_settled_cents)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`).run(billNo, derived.billType, derived.partner,
      derived.statementMonth, derived.settlementMethod, derived.currency, derived.amount, derived.status, derived.billDate,
      derived.dueDate, payload.remark ?? derived.remark, order.id, nowIso(), derived.quantity, derived.unitPrice, order.customerId || null);
    db.prepare('UPDATE stock_orders SET billing_suppressed = 0 WHERE id = ?').run(order.id);
    refreshBillStatus(result.lastInsertRowid);
    recordBillEvent(result.lastInsertRowid, '创建账单', '按出货开单价保存', payload.actor);
    return { ok: true, id: Number(result.lastInsertRowid), billNo };
  })();
}

export function updateBill(payload) {
  const existing = db.prepare('SELECT * FROM bills WHERE id = ?').get(Number(payload.id));
  if (!existing) throw new Error('未找到账单');
  if (existing.voided_at) throw new Error('账单已作废，请先恢复');
  if (payload.stockOrderId && Number(payload.stockOrderId) !== existing.stock_order_id) throw new Error('账单开立后不可改绑出库单');
  if (payload.status && payload.status !== existing.status) throw new Error('结清状态由收款流水自动计算，请到收款登记操作');
  const dueDate = payload.dueDate ?? existing.due_date;
  validDate(dueDate, '到期日期');
  if (dueDate < existing.bill_date) throw new Error('到期日期不能早于账单日期');
  return db.transaction(() => {
    db.prepare('UPDATE bills SET due_date = ?, remark = ? WHERE id = ?').run(dueDate, payload.remark ?? existing.remark, existing.id);
    recordBillEvent(existing.id, '修改账单备注/到期日', payload.remark ?? '', payload.actor);
    return { ok: true };
  })();
}

export function deleteBill(id, payload = {}) {
  return voidBill(id, payload);
}

export function replaceDatabaseFrom(sourcePath) {
  if (!sourcePath || !fs.existsSync(sourcePath)) throw new Error('备份文件不存在');
  const target = dbFilePath;
  const temporary = `${target}.restore`;
  // Stage the copy before closing the live database, then atomically replace it.
  fs.copyFileSync(sourcePath, temporary);
  closeDatabase();
  for (const suffix of ['-wal', '-shm']) {
    if (fs.existsSync(`${target}${suffix}`)) fs.unlinkSync(`${target}${suffix}`);
  }
  fs.renameSync(temporary, target);
  initializeDatabase(path.dirname(target));
  return { ok: true };
}

export function resetBusinessData() {
  const run = db.transaction(() => {
    for (const table of ['receipts', 'bill_events', 'inventory_ledger']) db.prepare(`DELETE FROM ${table}`).run();
    db.prepare('DELETE FROM bills').run();
    db.prepare('DELETE FROM customers').run();
    db.prepare('DELETE FROM stock_orders').run();
    db.prepare('DELETE FROM price_sheets').run();
    db.prepare('DELETE FROM inventory_items').run();
    db.prepare("DELETE FROM sqlite_sequence WHERE name IN ('bills', 'stock_orders', 'price_sheets', 'inventory_items')").run();
  });
  run();
  return { ok: true };
}
