import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

let db;
let dbFilePath = '';

function nowIso() {
  return new Date().toISOString();
}

function addDays(dateString, days) {
  const date = new Date(dateString);
  date.setDate(date.getDate() + days);
  return date.toISOString().slice(0, 10);
}

function formatStatementMonth(dateString) {
  return String(dateString || '').slice(0, 7);
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

function formatOrderNo(prefix) {
  const stamp = new Date().toISOString().slice(0, 10).replaceAll('-', '');
  const sequence = nextSequenceByLike('stock_orders', 'order_no', `${prefix}-${stamp}-%`);
  return `${prefix}-${stamp}-${String(sequence).padStart(3, '0')}`;
}

function formatSheetNo() {
  const stamp = new Date().toISOString().slice(0, 10).replaceAll('-', '');
  const sequence = nextSequenceByLike('price_sheets', 'sheet_no', `PR-${stamp}-%`);
  return `PR-${stamp}-${String(sequence).padStart(3, '0')}`;
}

function formatBillNo() {
  const stamp = new Date().toISOString().slice(0, 10).replaceAll('-', '');
  const sequence = nextSequenceByLike('bills', 'bill_no', `BL-${stamp}-%`);
  return `BL-${stamp}-${String(sequence).padStart(3, '0')}`;
}

function isReturnInboundOrder(orderLike) {
  return orderLike?.type === '入库' && /退|回/.test(String(orderLike.businessType || ''));
}

function defaultStatusByBillType(billType) {
  return billType === '应付' ? '待付款' : '待回款';
}

function deriveBillPayloadFromOrder(orderLike) {
  const amount = Number(orderLike.totalAmount || 0);
  const returnInbound = isReturnInboundOrder(orderLike);
  const billType = orderLike.type === '出库'
    ? '应收'
    : returnInbound
      ? '应收'
      : '应付';
  const signedAmount = returnInbound ? -Math.abs(amount) : Math.abs(amount);

  return {
    billType,
    partner: orderLike.partner,
    statementMonth: formatStatementMonth(orderLike.orderDate),
    settlementMethod: '月结30',
    currency: 'RMB',
    amount: signedAmount,
    status: defaultStatusByBillType(billType),
    billDate: orderLike.orderDate,
    dueDate: addDays(orderLike.orderDate, 7),
    remark: orderLike.remark || (returnInbound ? '回库冲减自动生成账单' : '业务单自动生成账单')
  };
}

function syncBillForOrder(orderLike) {
  const derived = deriveBillPayloadFromOrder(orderLike);
  const existingBill = db.prepare(`
    SELECT id, status, settlement_method AS settlementMethod, currency, due_date AS dueDate
    FROM bills
    WHERE stock_order_id = ?
  `).get(Number(orderLike.id));

  if (existingBill) {
    db.prepare(`
      UPDATE bills
      SET
        bill_type = ?, partner = ?, statement_month = ?, settlement_method = ?, currency = ?, amount = ?,
        bill_date = ?, due_date = ?, remark = ?
      WHERE stock_order_id = ?
    `).run(
      derived.billType,
      derived.partner,
      derived.statementMonth,
      existingBill.settlementMethod || derived.settlementMethod,
      existingBill.currency || derived.currency,
      derived.amount,
      derived.billDate,
      existingBill.dueDate || derived.dueDate,
      derived.remark,
      Number(orderLike.id)
    );

    const validStatuses = derived.billType === '应付'
      ? ['待付款', '已付款']
      : ['待回款', '部分回款', '已回款'];
    if (!validStatuses.includes(existingBill.status)) {
      db.prepare('UPDATE bills SET status = ? WHERE stock_order_id = ?')
        .run(defaultStatusByBillType(derived.billType), Number(orderLike.id));
    }
    return;
  }

  db.prepare(`
    INSERT INTO bills
      (
        bill_no, bill_type, partner, statement_month, settlement_method, currency, amount, status,
        bill_date, due_date, remark, stock_order_id, created_at
      )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    formatBillNo(),
    derived.billType,
    derived.partner,
    derived.statementMonth,
    derived.settlementMethod,
    derived.currency,
    derived.amount,
    derived.status,
    derived.billDate,
    derived.dueDate,
    derived.remark,
    Number(orderLike.id),
    nowIso()
  );
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

  insertBill.run(formatBillNo(), '应收', '盛发', '2026-04', '月结30', 'RMB', 38.4, '待回款', '2026-04-03', '2026-04-10', '四月第一批对账', 2, timestamp);
  insertBill.run(formatBillNo(), '应收', '盛发', '2026-04', '月结30', 'RMB', 103, '部分回款', '2026-04-03', '2026-04-10', '四月第二批对账', 4, timestamp);
}

export function initializeDatabase(userDataPath) {
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
  `);

  const itemCount = db.prepare('SELECT COUNT(*) AS total FROM inventory_items').get().total;
  if (!itemCount) {
    seedDatabase();
  }

  migrateLegacyPriceSheets();
  migrateBillsForStockOrderLink();
  migrateBusinessColumns();
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
      stock_orders.total_amount AS totalAmount,
      stock_orders.order_date AS orderDate,
      stock_orders.remark
    FROM stock_orders
    LEFT JOIN bills ON bills.stock_order_id = stock_orders.id
    WHERE bills.id IS NULL
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
  `);

  const priceSheetItemIds = db.prepare('SELECT DISTINCT item_id AS itemId FROM price_sheets').all();
  const selectPriceHistory = db.prepare(`
    SELECT id
    FROM price_sheets
    WHERE item_id = ?
    ORDER BY effective_date DESC, id DESC
  `);
  const deactivatePriceRows = db.prepare('UPDATE price_sheets SET is_active = 0 WHERE item_id = ?');
  const activatePriceRow = db.prepare('UPDATE price_sheets SET is_active = 1 WHERE id = ?');

  priceSheetItemIds.forEach(({ itemId }) => {
    const rows = selectPriceHistory.all(itemId);
    if (!rows.length) {
      return;
    }
    deactivatePriceRows.run(itemId);
    activatePriceRow.run(rows[0].id);
  });
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

export function getDatabasePath() {
  return dbFilePath;
}

export async function backupDatabaseTo(targetPath) {
  await db.backup(targetPath);
  return { ok: true, filePath: targetPath };
}

export function getInventoryItems() {
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
  assertRequired(payload.code, '物料编码');
  assertRequired(payload.name, '品名规格');
  assertRequired(payload.unit, '单位');

  const exists = db.prepare('SELECT id FROM inventory_items WHERE code = ?').get(payload.code);
  if (exists) {
    throw new Error('物料编码已存在');
  }

  const stockQty = Number(payload.stockQty || 0);
  const safetyStock = Number(payload.safetyStock || 0);
  const unitPrice = Number(payload.unitPrice || 0);
  const timestamp = nowIso();

  const result = db.prepare(`
    INSERT INTO inventory_items
      (
        code, name, category, unit, safety_stock, location, stock_qty, unit_price,
        created_at, updated_at, specification, plating, process_note
      )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    payload.code.trim(),
    payload.name.trim(),
    (payload.category || '标准件').trim(),
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

  return { ok: true, itemId: result.lastInsertRowid };
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
      inventory_items.unit,
      stock_orders.quantity,
      stock_orders.unit_price AS unitPrice,
      stock_orders.total_amount AS totalAmount,
      stock_orders.partner,
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

  return db.prepare(`${sql} ORDER BY stock_orders.order_date DESC, stock_orders.id DESC`).all(...values);
}

export function getPriceSheets(filters = {}) {
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
      price_sheets.remark
    FROM price_sheets
    INNER JOIN inventory_items ON inventory_items.id = price_sheets.item_id
  `, filters, 'effective_date');

  return db.prepare(`${query.sql} ORDER BY price_sheets.is_active DESC, price_sheets.effective_date DESC, price_sheets.id DESC`).all(...query.values);
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
      bills.bill_date AS billDate,
      bills.due_date AS dueDate,
      bills.remark,
      bills.stock_order_id AS stockOrderId,
      stock_orders.order_no AS stockOrderNo,
      stock_orders.type AS stockOrderType,
      stock_orders.business_type AS businessType,
      stock_orders.delivery_no AS deliveryNo,
      stock_orders.outsource_no AS outsourceNo,
      stock_orders.process_no AS processNo,
      stock_orders.order_date AS orderDate,
      stock_orders.quantity,
      stock_orders.unit_price AS unitPrice,
      COALESCE(NULLIF(stock_orders.plating, ''), inventory_items.plating) AS plating,
      inventory_items.code AS itemCode,
      inventory_items.name AS itemName,
      inventory_items.specification AS specification
    FROM bills
    INNER JOIN stock_orders ON stock_orders.id = bills.stock_order_id
    INNER JOIN inventory_items ON inventory_items.id = stock_orders.item_id
  `, filters, 'bill_date');

  return db.prepare(`${query.sql} ORDER BY bills.bill_date DESC, bills.id DESC`).all(...query.values);
}

export function getDashboardData() {
  const today = new Date().toISOString().slice(0, 10);
  const monthStart = `${today.slice(0, 7)}-01`;

  const inboundToday = db.prepare(`
    SELECT COALESCE(SUM(quantity), 0) AS total
    FROM stock_orders
    WHERE type = '入库' AND order_date = ?
  `).get(today).total;

  const outboundToday = db.prepare(`
    SELECT COALESCE(SUM(quantity), 0) AS total
    FROM stock_orders
    WHERE type = '出库' AND order_date = ?
  `).get(today).total;

  const warningCount = db.prepare(`
    SELECT COUNT(*) AS total
    FROM inventory_items
    WHERE stock_qty < safety_stock
  `).get().total;

  const monthReceivable = db.prepare(`
    SELECT COALESCE(SUM(amount), 0) AS total
    FROM bills
    WHERE bill_type = '应收' AND bill_date >= ?
  `).get(monthStart).total;

  const accountStats = db.prepare(`
    SELECT
      SUM(CASE WHEN bill_type = '应收' THEN amount ELSE 0 END) AS receivable,
      SUM(CASE WHEN bill_type = '应付' THEN amount ELSE 0 END) AS payable,
      SUM(CASE WHEN bill_type = '应收' AND status = '已回款' THEN amount ELSE 0 END)
        - SUM(CASE WHEN bill_type = '应付' AND status = '已付款' THEN amount ELSE 0 END) AS cashBalance
    FROM bills
  `).get();

  const totalInbound = db.prepare(`
    SELECT COALESCE(SUM(total_amount), 0) AS total
    FROM stock_orders
    WHERE type = '入库'
  `).get().total;

  const totalOutbound = db.prepare(`
    SELECT COALESCE(SUM(total_amount), 0) AS total
    FROM stock_orders
    WHERE type = '出库'
  `).get().total;

  const lowStockItems = db.prepare(`
    SELECT code, name, unit, stock_qty AS stockQty, safety_stock AS safetyStock
    FROM inventory_items
    WHERE stock_qty < safety_stock
    ORDER BY (safety_stock - stock_qty) DESC
    LIMIT 5
  `).all();

  const recentOrders = getStockOrders({}).slice(0, 5);

  const monthlyTrend = db.prepare(`
    SELECT
      substr(order_date, 1, 7) AS month,
      SUM(CASE WHEN type = '入库' THEN total_amount ELSE 0 END) AS inboundAmount,
      SUM(CASE WHEN type = '出库' THEN total_amount ELSE 0 END) AS outboundAmount
    FROM stock_orders
    GROUP BY substr(order_date, 1, 7)
    ORDER BY month ASC
  `).all().map((row) => ({
    month: row.month,
    inboundAmount: row.inboundAmount,
    outboundAmount: row.outboundAmount,
    profit: row.outboundAmount - row.inboundAmount
  }));

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
      cashBalance: Number(accountStats.cashBalance || 0),
      profit: Number(totalOutbound - totalInbound)
    },
    monthlyTrend
  };
}

export function createStockOrder(payload) {
  assertRequired(payload.type, '单据类型');
  assertRequired(payload.partner, '客户');
  assertRequired(payload.operator, '制表人');
  assertRequired(payload.orderDate, '业务日期');
  assertRequired(payload.deliveryNo, payload.type === '出库' ? '送货单号' : '回库单号');

  const item = db.prepare(`
    SELECT id, code, name, stock_qty AS stockQty, unit, unit_price AS unitPrice, plating
    FROM inventory_items
    WHERE id = ?
  `).get(payload.itemId);

  if (!item) {
    throw new Error('未找到对应库存物料');
  }

  const quantity = Number(payload.quantity);
  const unitPrice = Number(payload.unitPrice || item.unitPrice || 0);

  if (!quantity || quantity <= 0) {
    throw new Error('数量必须大于 0');
  }

  if (payload.type === '出库' && Number(item.stockQty) < quantity) {
    throw new Error(`库存不足，当前仅剩 ${item.stockQty}${item.unit}`);
  }

  const totalAmount = Number((quantity * unitPrice).toFixed(2));
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
      (payload.businessType || (payload.type === '出库' ? '成品出货' : '正常入库')).trim(),
      payload.itemId,
      String(payload.deliveryNo || '').trim(),
      String(payload.outsourceNo || '').trim(),
      String(payload.processNo || '').trim(),
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

    const delta = payload.type === '入库' ? quantity : -quantity;
    db.prepare(`
      UPDATE inventory_items
      SET
        stock_qty = stock_qty + ?,
        unit_price = ?,
        updated_at = ?
      WHERE id = ?
    `).run(delta, unitPrice, timestamp, payload.itemId);

    if (payload.autoCreateBill !== false) {
      syncBillForOrder({
        id: createdOrderId,
        type: payload.type,
        businessType: payload.businessType || (payload.type === '出库' ? '成品出货' : '正常入库'),
        partner: payload.partner,
        totalAmount,
        orderDate: payload.orderDate,
        remark: payload.remark || ''
      });
    }
  });

  run();

  return {
    ok: true,
    id: createdOrderId,
    orderNo,
    totalAmount
  };
}

function adjustInventoryForOrder(itemId, quantityDelta, unitPrice) {
  db.prepare(`
    UPDATE inventory_items
    SET
      stock_qty = stock_qty + ?,
      unit_price = ?,
      updated_at = ?
    WHERE id = ?
  `).run(quantityDelta, unitPrice, nowIso(), itemId);
}

export function updateStockOrder(payload) {
  assertRequired(payload.id, '单据');
  assertRequired(payload.type, '单据类型');
  assertRequired(payload.partner, '客户');
  assertRequired(payload.operator, '制表人');
  assertRequired(payload.orderDate, '业务日期');
  assertRequired(payload.deliveryNo, payload.type === '出库' ? '送货单号' : '回库单号');

  const existing = db.prepare(`
    SELECT id, type, item_id AS itemId, quantity, unit_price AS unitPrice
    FROM stock_orders
    WHERE id = ?
  `).get(payload.id);

  if (!existing) {
    throw new Error('未找到单据');
  }

  const targetItem = db.prepare(`
    SELECT id, stock_qty AS stockQty, unit, unit_price AS unitPrice, plating
    FROM inventory_items
    WHERE id = ?
  `).get(Number(payload.itemId));

  if (!targetItem) {
    throw new Error('未找到对应库存物料');
  }

  const quantity = Number(payload.quantity);
  const unitPrice = Number(payload.unitPrice || targetItem.unitPrice || 0);
  const totalAmount = Number((quantity * unitPrice).toFixed(2));

  const run = db.transaction(() => {
    const rollbackDelta = existing.type === '入库' ? -Number(existing.quantity) : Number(existing.quantity);
    adjustInventoryForOrder(existing.itemId, rollbackDelta, existing.unitPrice);

    const currentTarget = db.prepare('SELECT stock_qty AS stockQty, unit FROM inventory_items WHERE id = ?').get(Number(payload.itemId));
    if (payload.type === '出库' && Number(currentTarget.stockQty) < quantity) {
      throw new Error(`库存不足，当前仅剩 ${currentTarget.stockQty}${currentTarget.unit}`);
    }

    const applyDelta = payload.type === '入库' ? quantity : -quantity;
    adjustInventoryForOrder(Number(payload.itemId), applyDelta, unitPrice);

    db.prepare(`
      UPDATE stock_orders
      SET
        type = ?, business_type = ?, item_id = ?, delivery_no = ?, outsource_no = ?, process_no = ?,
        quantity = ?, unit_price = ?, total_amount = ?, partner = ?, operator = ?, order_date = ?, plating = ?, remark = ?
      WHERE id = ?
    `).run(
      payload.type,
      (payload.businessType || (payload.type === '出库' ? '成品出货' : '正常入库')).trim(),
      Number(payload.itemId),
      String(payload.deliveryNo || '').trim(),
      String(payload.outsourceNo || '').trim(),
      String(payload.processNo || '').trim(),
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

    syncBillForOrder({
      id: Number(payload.id),
      type: payload.type,
      businessType: payload.businessType || (payload.type === '出库' ? '成品出货' : '正常入库'),
      partner: payload.partner,
      totalAmount,
      orderDate: payload.orderDate,
      remark: payload.remark || ''
    });
  });

  run();
  return { ok: true };
}

export function deleteStockOrder(orderId, options = {}) {
  const existing = db.prepare(`
    SELECT id, type, item_id AS itemId, quantity, unit_price AS unitPrice
    FROM stock_orders
    WHERE id = ?
  `).get(orderId);

  if (!existing) {
    throw new Error('未找到单据');
  }

  const linkedBill = db.prepare('SELECT id FROM bills WHERE stock_order_id = ?').get(orderId);
  if (linkedBill && !options.cascadeBill) {
    throw new Error('该出库单已绑定账单，请先删除对应账单');
  }

  const run = db.transaction(() => {
    if (linkedBill) {
      db.prepare('DELETE FROM bills WHERE stock_order_id = ?').run(orderId);
    }
    const rollbackDelta = existing.type === '入库' ? -Number(existing.quantity) : Number(existing.quantity);
    adjustInventoryForOrder(existing.itemId, rollbackDelta, existing.unitPrice);
    db.prepare('DELETE FROM stock_orders WHERE id = ?').run(orderId);
  });

  run();
  return { ok: true };
}

export function createPriceSheet(payload) {
  assertRequired(payload.itemId, '物料');
  assertRequired(payload.effectiveDate, '生效日期');
  if (Number(payload.unitPrice) < 0) {
    throw new Error('单价不能小于 0');
  }

  const sheetNo = formatSheetNo();
  const timestamp = nowIso();
  const run = db.transaction(() => {
    db.prepare(`
      UPDATE price_sheets
      SET is_active = 0
      WHERE item_id = ?
    `).run(Number(payload.itemId));

    db.prepare(`
      INSERT INTO price_sheets
        (sheet_no, partner, item_id, unit_price, effective_date, is_active, remark, created_at)
      VALUES (?, ?, ?, ?, ?, 1, ?, ?)
    `).run(
      sheetNo,
      payload.partner || '标准价',
      Number(payload.itemId),
      Number(payload.unitPrice),
      payload.effectiveDate,
      payload.remark || '',
      timestamp
    );

    db.prepare(`
      UPDATE inventory_items
      SET unit_price = ?, updated_at = ?
      WHERE id = ?
    `).run(Number(payload.unitPrice), timestamp, Number(payload.itemId));
  });

  run();

  return { ok: true, sheetNo };
}

export function updatePriceSheet(payload) {
  assertRequired(payload.id, '单价表');
  assertRequired(payload.itemId, '物料');
  assertRequired(payload.effectiveDate, '生效日期');

  const existing = db.prepare('SELECT id FROM price_sheets WHERE id = ?').get(Number(payload.id));
  if (!existing) {
    throw new Error('未找到单价记录');
  }

  return createPriceSheet(payload);
}

export function deletePriceSheet(id) {
  const target = db.prepare(`
    SELECT id, item_id AS itemId, is_active AS isActive
    FROM price_sheets
    WHERE id = ?
  `).get(Number(id));

  if (!target) {
    throw new Error('未找到单价记录');
  }

  const run = db.transaction(() => {
    db.prepare('DELETE FROM price_sheets WHERE id = ?').run(Number(id));

    if (Number(target.isActive) === 1) {
      db.prepare(`
        UPDATE inventory_items
        SET unit_price = 0, updated_at = ?
        WHERE id = ?
      `).run(nowIso(), Number(target.itemId));
    }
  });

  run();
  return { ok: true };
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
  assertRequired(payload.billType, '账单类型');
  assertRequired(payload.partner, '客户');
  assertRequired(payload.status, '状态');
  assertRequired(payload.billDate, '账单日期');
  assertRequired(payload.dueDate, '到期日期');
  if (!Number.isFinite(Number(payload.amount))) {
    throw new Error('金额格式不正确');
  }

  assertRequired(payload.stockOrderId, '业务单');
  const stockOrder = db.prepare(`
    SELECT id, type, business_type AS businessType, partner, total_amount AS totalAmount, order_date AS orderDate, remark
    FROM stock_orders
    WHERE id = ?
  `).get(Number(payload.stockOrderId));

  if (!stockOrder) {
    throw new Error('账单必须绑定业务单');
  }

  const existingBill = db.prepare('SELECT id FROM bills WHERE stock_order_id = ?').get(Number(payload.stockOrderId));
  if (existingBill) {
    throw new Error('该出库单已存在对应账单');
  }

  const billNo = formatBillNo();
  db.prepare(`
    INSERT INTO bills
      (
        bill_no, bill_type, partner, statement_month, settlement_method, currency, amount, status,
        bill_date, due_date, remark, stock_order_id, created_at
      )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    billNo,
    payload.billType,
    payload.partner,
    payload.statementMonth || formatStatementMonth(payload.billDate || stockOrder.orderDate),
    payload.settlementMethod || '月结30',
    payload.currency || 'RMB',
    Number(payload.amount),
    payload.status,
    payload.billDate,
    payload.dueDate,
    payload.remark || '',
    Number(payload.stockOrderId),
    nowIso()
  );

  return { ok: true, billNo };
}

export function updateBill(payload) {
  assertRequired(payload.id, '账单');
  assertRequired(payload.stockOrderId, '业务单');

  const stockOrder = db.prepare('SELECT id, type FROM stock_orders WHERE id = ?').get(Number(payload.stockOrderId));
  if (!stockOrder) {
    throw new Error('账单必须绑定业务单');
  }

  const conflict = db.prepare('SELECT id FROM bills WHERE stock_order_id = ? AND id != ?').get(Number(payload.stockOrderId), Number(payload.id));
  if (conflict) {
    throw new Error('该出库单已被其他账单绑定');
  }

  db.prepare(`
    UPDATE bills
    SET
      bill_type = ?, partner = ?, statement_month = ?, settlement_method = ?, currency = ?, amount = ?, status = ?,
      bill_date = ?, due_date = ?, remark = ?, stock_order_id = ?
    WHERE id = ?
  `).run(
    payload.billType,
    payload.partner,
    payload.statementMonth || formatStatementMonth(payload.billDate),
    payload.settlementMethod || '月结30',
    payload.currency || 'RMB',
    Number(payload.amount),
    payload.status,
    payload.billDate,
    payload.dueDate,
    payload.remark || '',
    Number(payload.stockOrderId),
    Number(payload.id)
  );

  return { ok: true };
}

export function deleteBill(id) {
  db.prepare('DELETE FROM bills WHERE id = ?').run(id);
  return { ok: true };
}

export function replaceDatabaseFrom(sourcePath) {
  if (!sourcePath || !fs.existsSync(sourcePath)) {
    throw new Error('备份文件不存在');
  }

  db.close();
  if (fs.existsSync(`${dbFilePath}-wal`)) {
    fs.unlinkSync(`${dbFilePath}-wal`);
  }
  if (fs.existsSync(`${dbFilePath}-shm`)) {
    fs.unlinkSync(`${dbFilePath}-shm`);
  }
  fs.copyFileSync(sourcePath, dbFilePath);
  db = new Database(dbFilePath);
  db.pragma('journal_mode = WAL');
  return { ok: true };
}
