import crypto from 'node:crypto';

let db;
const now = () => new Date().toISOString();
export const BUSINESS_TIMEZONE = process.env.FACTORY_BUSINESS_TIMEZONE || 'Asia/Shanghai';
const businessDateFormat = new Intl.DateTimeFormat('sv-SE', { timeZone: BUSINESS_TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' });
export const businessToday = (date = new Date()) => businessDateFormat.format(date);

export function validDate(value, label = '日期') {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value)) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) {
    throw new Error(`${label}不正确`);
  }
  return value;
}

export function nonnegative(value, label) {
  const number = Number(value);
  if (value === '' || value === null || !Number.isFinite(number) || number < 0 || number > 1e12) throw new Error(`${label}必须是有效的非负数`);
  return number;
}

export function quantityNumber(value, label = '数量') {
  const number = nonnegative(value, label);
  const rounded = Number(number.toFixed(6));
  if (Math.abs(rounded - number) > 1e-10) throw new Error(`${label}最多保留六位小数`);
  return rounded;
}

// Line amount (quantity × unit price) rounded half-up to the cent. Float products such as
// 0.5 × 0.73 = 0.36499999… are first normalised to 12 significant digits so 0.365 → 0.37.
export function lineAmount(quantity, unitPrice) {
  return Math.round(Number((Number(quantity || 0) * Number(unitPrice || 0) * 100).toPrecision(12))) / 100;
}

export function toBool(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return value === true || value === 1 || value === '1' || value === 'true';
}

export function moneyCents(value) {
  const number = nonnegative(value, '金额');
  const cents = Math.round(number * 100);
  if (!Number.isSafeInteger(cents) || Math.abs(cents / 100 - number) > 1e-7) throw new Error('金额最多保留两位小数');
  return cents;
}

function column(table, name, definition) {
  if (!db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
}

export function initializeOperations(database) {
  db = database;
  db.transaction(() => {
    column('stock_orders', 'voided_at', "TEXT NOT NULL DEFAULT ''");
    column('stock_orders', 'billing_suppressed', 'INTEGER NOT NULL DEFAULT 0');
    column('stock_orders', 'customer_id', 'INTEGER');
    column('bills', 'customer_id', 'INTEGER');
    column('bills', 'voided_at', "TEXT NOT NULL DEFAULT ''");
    column('bills', 'void_reason', "TEXT NOT NULL DEFAULT ''");
    column('bills', 'voided_by', "TEXT NOT NULL DEFAULT ''");
    column('bills', 'legacy_settled_cents', 'INTEGER');
    db.exec(`
      CREATE TABLE IF NOT EXISTS customers (
        id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE,
        contact TEXT NOT NULL DEFAULT '', phone TEXT NOT NULL DEFAULT '', address TEXT NOT NULL DEFAULT '',
        settlement_days INTEGER NOT NULL DEFAULT 30, remark TEXT NOT NULL DEFAULT '',
        is_active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS inventory_ledger (
        id INTEGER PRIMARY KEY AUTOINCREMENT, item_id INTEGER NOT NULL, order_id INTEGER,
        event_type TEXT NOT NULL, quantity_delta REAL NOT NULL, balance_after REAL NOT NULL,
        business_date TEXT NOT NULL, reference TEXT NOT NULL DEFAULT '', remark TEXT NOT NULL DEFAULT '',
        operator TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS receipts (
        id INTEGER PRIMARY KEY AUTOINCREMENT, receipt_no TEXT NOT NULL UNIQUE, bill_id INTEGER NOT NULL,
        amount_cents INTEGER NOT NULL CHECK(amount_cents > 0), receipt_date TEXT NOT NULL,
        method TEXT NOT NULL, reference TEXT NOT NULL DEFAULT '', remark TEXT NOT NULL DEFAULT '',
        operator TEXT NOT NULL DEFAULT '', request_key TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL,
        voided_at TEXT NOT NULL DEFAULT '', void_reason TEXT NOT NULL DEFAULT '', voided_by TEXT NOT NULL DEFAULT ''
      );
      CREATE TABLE IF NOT EXISTS bill_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, bill_id INTEGER NOT NULL, action TEXT NOT NULL,
        reason TEXT NOT NULL, operator TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_ledger_item ON inventory_ledger(item_id, id);
      CREATE INDEX IF NOT EXISTS idx_receipts_bill ON receipts(bill_id, voided_at);
      CREATE INDEX IF NOT EXISTS idx_bills_customer ON bills(customer_id);
      CREATE INDEX IF NOT EXISTS idx_prices_effective ON price_sheets(item_id, effective_date, id);
      UPDATE bills SET legacy_settled_cents = CASE WHEN status = '已结算' THEN ROUND(amount * 100) ELSE 0 END
        WHERE legacy_settled_cents IS NULL;
    `);
    if (!db.prepare("SELECT 1 FROM app_settings WHERE key = 'operationsMigrationV1'").get()) {
      const parties = db.prepare("SELECT DISTINCT trim(partner) AS name FROM stock_orders WHERE trim(partner) != '' UNION SELECT DISTINCT trim(partner) FROM bills WHERE trim(partner) != ''").all();
      for (const party of parties) createCustomer({ name: party.name });
      db.exec(`UPDATE stock_orders SET customer_id = (SELECT id FROM customers WHERE name = trim(stock_orders.partner));
        UPDATE bills SET customer_id = (SELECT id FROM customers WHERE name = trim(bills.partner));`);
      for (const item of db.prepare('SELECT id, stock_qty FROM inventory_items').all()) {
        recordInventoryMovement(item.id, item.stock_qty, { type: '期初结转', remark: '台账启用时的库存；此前业务见出入库明细', actor: '系统迁移' });
      }
      db.prepare('INSERT INTO app_settings(key, value) VALUES (?, ?)').run('operationsMigrationV1', '1');
    }
    db.pragma('user_version = 2');
  })();
  refreshEffectivePrices();
}

export function refreshEffectivePrices(asOf = businessToday()) {
  validDate(asOf);
  db.transaction(() => {
    db.prepare(`UPDATE price_sheets SET is_active = CASE WHEN id = (
      SELECT p.id FROM price_sheets p WHERE p.item_id = price_sheets.item_id AND p.effective_date <= ?
      ORDER BY p.effective_date DESC, p.id DESC LIMIT 1) THEN 1 ELSE 0 END`).run(asOf);
    db.exec(`UPDATE inventory_items SET unit_price = COALESCE((SELECT unit_price FROM price_sheets
      WHERE item_id = inventory_items.id AND is_active = 1), 0)
      WHERE EXISTS (SELECT 1 FROM price_sheets WHERE item_id = inventory_items.id);`);
  })();
}

export function effectivePrice(itemId, asOf = businessToday()) {
  validDate(asOf, '业务日期');
  const price = db.prepare(`SELECT unit_price AS unitPrice FROM price_sheets WHERE item_id = ? AND effective_date <= ?
    ORDER BY effective_date DESC, id DESC LIMIT 1`).get(Number(itemId), asOf);
  if (price) return Number(price.unitPrice);
  if (db.prepare('SELECT 1 FROM price_sheets WHERE item_id = ?').get(Number(itemId))) throw new Error('该业务日期没有已生效的价格，请先维护价目');
  return Number(db.prepare('SELECT unit_price FROM inventory_items WHERE id = ?').get(Number(itemId))?.unit_price || 0);
}

export function createCustomer(payload) {
  const name = String(payload.name || '').trim();
  if (!name) throw new Error('客户名称不能为空');
  if (db.prepare('SELECT 1 FROM customers WHERE name = ?').get(name)) throw new Error('客户名称已存在');
  const days = nonnegative(payload.settlementDays ?? 30, '账期天数');
  if (!Number.isInteger(days) || days > 3650) throw new Error('账期必须为 0 至 3650 的整数天数');
  const result = db.prepare(`INSERT INTO customers (name, contact, phone, address, settlement_days, remark, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(name, String(payload.contact || '').trim(), String(payload.phone || '').trim(),
    String(payload.address || '').trim(), days, String(payload.remark || '').trim(), now(), now());
  return { ok: true, id: Number(result.lastInsertRowid) };
}

export function updateCustomer(payload) {
  const previous = db.prepare('SELECT * FROM customers WHERE id = ?').get(Number(payload.id));
  if (!previous) throw new Error('客户不存在');
  const name = String(payload.name ?? previous.name).trim();
  if (!name) throw new Error('客户名称不能为空');
  if (db.prepare('SELECT 1 FROM customers WHERE name = ? AND id != ?').get(name, previous.id)) throw new Error('客户名称已存在');
  const days = nonnegative(payload.settlementDays ?? previous.settlement_days, '账期天数');
  if (!Number.isInteger(days) || days > 3650) throw new Error('账期必须为 0 至 3650 的整数天数');
  db.prepare(`UPDATE customers SET name = ?, contact = ?, phone = ?, address = ?, settlement_days = ?, remark = ?,
    is_active = ?, updated_at = ? WHERE id = ?`).run(name, payload.contact ?? previous.contact, payload.phone ?? previous.phone,
    payload.address ?? previous.address, days, payload.remark ?? previous.remark,
    toBool(payload.isActive, Boolean(previous.is_active)) ? 1 : 0, now(), previous.id);
  return { ok: true };
}

export function getCustomers() {
  return db.prepare(`SELECT id, name, contact, phone, address, settlement_days AS settlementDays, remark,
    is_active AS isActive, created_at AS createdAt FROM customers ORDER BY is_active DESC, name`).all().map((customer) => {
    const amounts = db.prepare(`SELECT COALESCE(SUM(ROUND(amount * 100)), 0) AS billed,
      COALESCE(SUM(legacy_settled_cents), 0) AS legacy FROM bills WHERE customer_id = ? AND bill_type = '应收' AND voided_at = ''`).get(customer.id);
    const received = db.prepare(`SELECT COALESCE(SUM(r.amount_cents), 0) AS total FROM receipts r
      JOIN bills b ON b.id = r.bill_id WHERE b.customer_id = ? AND b.bill_type = '应收' AND b.voided_at = '' AND r.voided_at = ''`).get(customer.id).total;
    return { ...customer, totalAmount: amounts.billed / 100, receivedAmount: received / 100,
      legacySettledAmount: amounts.legacy / 100, balanceAmount: (amounts.billed - amounts.legacy - received) / 100 };
  });
}

// Business records must point at an existing customer profile. Customers are never created
// implicitly here (that used to turn material vendor names into customers). When editing,
// the record keeps its current customer unless another customerId is given explicitly.
export function resolveCustomer(payload, existingCustomerId) {
  const id = payload.customerId || existingCustomerId;
  const name = String(payload.partner || '').trim();
  const customer = id
    ? db.prepare('SELECT * FROM customers WHERE id = ?').get(Number(id))
    : name ? db.prepare('SELECT * FROM customers WHERE name = ?').get(name) : null;
  if (!customer) throw new Error(id ? '客户档案不存在' : name ? `未找到客户档案“${name}”，请先在客户档案中新增` : '请选择客户档案');
  if (!customer.is_active && customer.id !== existingCustomerId) throw new Error('客户已停用，请选择启用中的客户');
  return { customerId: customer.id, partner: customer.name, settlementDays: customer.settlement_days };
}

export function recordInventoryMovement(itemId, delta, details = {}) {
  const item = db.prepare('SELECT stock_qty FROM inventory_items WHERE id = ?').get(Number(itemId));
  if (!item) throw new Error('物料不存在');
  db.prepare(`INSERT INTO inventory_ledger (item_id, order_id, event_type, quantity_delta, balance_after,
    business_date, reference, remark, operator, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    Number(itemId), details.orderId || null, details.type || '库存调整', Number(delta), item.stock_qty,
    details.date || businessToday(), details.reference || '', details.remark || '', details.actor || '业务操作', now());
}

export function getInventoryLedger(filters = {}) {
  const clauses = [], values = [];
  for (const [key, sql] of [['itemId', 'l.item_id = ?'], ['startDate', 'l.business_date >= ?'], ['endDate', 'l.business_date <= ?']]) {
    if (filters[key]) { clauses.push(sql); values.push(filters[key]); }
  }
  return db.prepare(`SELECT l.id, l.item_id AS itemId, i.code AS itemCode, i.specification, i.unit,
    l.event_type AS eventType, l.quantity_delta AS quantityDelta, l.balance_after AS balanceAfter,
    l.business_date AS businessDate, l.reference, l.remark, l.operator, l.created_at AS createdAt
    FROM inventory_ledger l JOIN inventory_items i ON i.id = l.item_id
    ${clauses.length ? 'WHERE ' + clauses.join(' AND ') : ''} ORDER BY l.id DESC`).all(...values);
}

export function adjustInventory(payload) {
  const actual = quantityNumber(payload.actualQty, '实盘数量');
  const expected = quantityNumber(payload.expectedStockQty, '盘点前库存');
  const reason = String(payload.reason || '').trim();
  if (!reason) throw new Error('请填写盘点调整原因');
  return db.transaction(() => {
    const item = db.prepare('SELECT stock_qty FROM inventory_items WHERE id = ?').get(Number(payload.itemId));
    if (!item) throw new Error('物料不存在');
    if (Number(item.stock_qty) !== expected) throw new Error('库存已被其他业务更新，请刷新后重新盘点');
    const delta = Number((actual - expected).toFixed(6));
    if (!delta) throw new Error('实盘数量与库存一致，无需调整');
    db.prepare('UPDATE inventory_items SET stock_qty = ?, updated_at = ? WHERE id = ?').run(actual, now(), Number(payload.itemId));
    recordInventoryMovement(payload.itemId, delta, { type: '盘点调整', remark: reason, actor: payload.actor });
    return { ok: true, delta, stockQty: actual };
  })();
}

export function billPayment(bill) {
  const receivedCents = db.prepare("SELECT COALESCE(SUM(amount_cents), 0) AS total FROM receipts WHERE bill_id = ? AND voided_at = ''").get(bill.id).total;
  const legacyCents = Number(bill.legacy_settled_cents || 0);
  const balanceCents = Math.round(bill.amount * 100) - receivedCents - legacyCents;
  return { receivedCents, legacyCents, balanceCents };
}

export function refreshBillStatus(id) {
  const bill = db.prepare('SELECT * FROM bills WHERE id = ?').get(Number(id));
  if (!bill) throw new Error('未找到账单');
  const payment = billPayment(bill);
  const status = bill.voided_at ? '已作废' : payment.balanceCents <= 0 ? '已结算'
    : payment.receivedCents + payment.legacyCents > 0 ? '部分收款' : '未结清';
  db.prepare('UPDATE bills SET status = ? WHERE id = ?').run(status, bill.id);
  return status;
}

export function recordBillEvent(billId, action, reason = '', actor = '业务操作') {
  db.prepare('INSERT INTO bill_events (bill_id, action, reason, operator, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(Number(billId), action, reason, actor, now());
}

export function getBillEvents(id) {
  return db.prepare('SELECT id, action, reason, operator, created_at AS createdAt FROM bill_events WHERE bill_id = ? ORDER BY id DESC').all(Number(id));
}

export function voidBill(id, payload = {}) {
  const reason = String(payload.reason || '').trim();
  if (!reason) throw new Error('请填写账单作废原因');
  return db.transaction(() => {
    const bill = db.prepare('SELECT * FROM bills WHERE id = ?').get(Number(id));
    if (!bill) throw new Error('未找到账单');
    if (bill.voided_at) throw new Error('账单已经作废');
    const paid = billPayment(bill);
    if (paid.receivedCents || paid.legacyCents) throw new Error('账单已有收款或历史结清金额，须先撤销相应记录');
    db.prepare("UPDATE bills SET voided_at = ?, void_reason = ?, voided_by = ?, status = '已作废' WHERE id = ?")
      .run(now(), reason, payload.actor || '业务操作', bill.id);
    recordBillEvent(bill.id, '作废账单', reason, payload.actor);
    return { ok: true };
  })();
}

export function restoreBill(id, payload = {}) {
  return db.transaction(() => {
    const bill = db.prepare('SELECT * FROM bills WHERE id = ?').get(Number(id));
    if (!bill?.voided_at) throw new Error('账单未作废');
    const order = db.prepare('SELECT voided_at FROM stock_orders WHERE id = ?').get(bill.stock_order_id);
    if (!order || order.voided_at) throw new Error('关联出货记录已撤销，无法恢复账单');
    db.prepare("UPDATE bills SET voided_at = '', void_reason = '', voided_by = '' WHERE id = ?").run(bill.id);
    refreshBillStatus(bill.id);
    recordBillEvent(bill.id, '恢复账单', String(payload.reason || '恢复原账单，保留开单价格'), payload.actor);
    return { ok: true };
  })();
}

export function clearLegacySettlement(id, payload = {}) {
  const reason = String(payload.reason || '').trim();
  if (!reason) throw new Error('请填写撤销历史结清的原因');
  return db.transaction(() => {
    const bill = db.prepare('SELECT * FROM bills WHERE id = ?').get(Number(id));
    if (!bill?.legacy_settled_cents || bill.voided_at) throw new Error('账单没有可撤销的历史结清金额');
    db.prepare('UPDATE bills SET legacy_settled_cents = 0 WHERE id = ?').run(bill.id);
    refreshBillStatus(bill.id);
    recordBillEvent(bill.id, '撤销历史结清', reason, payload.actor);
    return { ok: true };
  })();
}

export function getReceipts(filters = {}) {
  const clauses = [], values = [];
  for (const [key, sql] of [['billId', 'r.bill_id = ?'], ['customerId', 'b.customer_id = ?'], ['startDate', 'r.receipt_date >= ?'], ['endDate', 'r.receipt_date <= ?']]) {
    if (filters[key]) { clauses.push(sql); values.push(filters[key]); }
  }
  return db.prepare(`SELECT r.id, r.receipt_no AS receiptNo, r.bill_id AS billId, b.bill_no AS billNo,
    b.partner, b.customer_id AS customerId, r.amount_cents / 100.0 AS amount, r.receipt_date AS receiptDate,
    r.method, r.reference, r.remark, r.operator, r.voided_at AS voidedAt, r.void_reason AS voidReason,
    r.voided_by AS voidedBy, r.created_at AS createdAt FROM receipts r JOIN bills b ON b.id = r.bill_id
    ${clauses.length ? 'WHERE ' + clauses.join(' AND ') : ''} ORDER BY r.receipt_date DESC, r.id DESC`).all(...values);
}

export function createReceipt(payload) {
  const cents = moneyCents(payload.amount);
  if (!cents) throw new Error('收款金额必须大于零');
  validDate(payload.receiptDate, '收款日期');
  if (payload.receiptDate > businessToday()) throw new Error('收款日期不能晚于今天');
  const method = String(payload.method || '').trim();
  const key = String(payload.requestKey || '').trim();
  if (!method || !key || key.length > 100) throw new Error('收款方式与请求标识不能为空');
  return db.transaction(() => {
    const previous = db.prepare('SELECT * FROM receipts WHERE request_key = ?').get(key);
    if (previous) {
      if (previous.bill_id !== Number(payload.billId) || previous.amount_cents !== cents || previous.receipt_date !== payload.receiptDate
        || previous.method !== method || previous.reference !== String(payload.reference || '').trim() || previous.remark !== String(payload.remark || '').trim()) throw new Error('重复请求与原收款内容不一致');
      if (previous.voided_at) throw new Error('这笔收款已登记过并已作废，请刷新页面后重新登记');
      return { ok: true, id: previous.id, receiptNo: previous.receipt_no };
    }
    const bill = db.prepare('SELECT * FROM bills WHERE id = ?').get(Number(payload.billId));
    if (!bill || bill.voided_at || bill.bill_type !== '应收') throw new Error('请选择有效的应收账单');
    if (payload.receiptDate < bill.bill_date) throw new Error('收款日期不能早于账单日期');
    if (cents > billPayment(bill).balanceCents) throw new Error('收款金额超过账单未收余额，请刷新账单');
    const receiptNo = `RC-${businessToday().replaceAll('-', '')}-${crypto.randomUUID().replaceAll('-', '').slice(0, 12).toUpperCase()}`;
    const result = db.prepare(`INSERT INTO receipts (receipt_no, bill_id, amount_cents, receipt_date, method,
      reference, remark, operator, request_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(receiptNo,
      bill.id, cents, payload.receiptDate, method, String(payload.reference || '').trim(), String(payload.remark || '').trim(), payload.actor || '业务操作', key, now());
    refreshBillStatus(bill.id);
    recordBillEvent(bill.id, '登记收款', `${receiptNo} · ${(cents / 100).toFixed(2)} 元`, payload.actor);
    return { ok: true, id: Number(result.lastInsertRowid), receiptNo };
  })();
}

export function voidReceipt(id, payload = {}) {
  const reason = String(payload.reason || '').trim();
  if (!reason) throw new Error('请填写收款作废原因');
  return db.transaction(() => {
    const row = db.prepare('SELECT * FROM receipts WHERE id = ?').get(Number(id));
    if (!row || row.voided_at) throw new Error('收款不存在或已经作废');
    db.prepare('UPDATE receipts SET voided_at = ?, void_reason = ?, voided_by = ? WHERE id = ?')
      .run(now(), reason, payload.actor || '业务操作', row.id);
    refreshBillStatus(row.bill_id);
    recordBillEvent(row.bill_id, '作废收款', `${row.receipt_no} · ${reason}`, payload.actor);
    return { ok: true };
  })();
}
