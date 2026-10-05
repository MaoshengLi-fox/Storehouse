import { validDate, businessToday } from './operations.js';
import { DOCUMENT_KINDS, PRINT_DEFAULTS, groupDocumentRows, statementTitle } from '../shared/documents.js';

let db;
export function initializeDocuments(database) { db = database; }

export function getPrintSettings() {
  const row = db.prepare("SELECT value FROM app_settings WHERE key = 'printSettings'").get();
  return { ...PRINT_DEFAULTS, ...(row ? JSON.parse(row.value) : {}) };
}

export function updatePrintSettings(payload = {}) {
  const next = getPrintSettings();
  for (const key of Object.keys(PRINT_DEFAULTS)) {
    if (payload[key] === undefined) continue;
    const value = String(payload[key]).trim();
    if (value.length > (key.endsWith('Note') ? 1500 : 150)) throw new Error('打印抬头或说明文字过长');
    next[key] = value;
  }
  if (!next.companyName) throw new Error('公司名称不能为空');
  db.prepare("INSERT INTO app_settings(key,value) VALUES ('printSettings',?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(JSON.stringify(next));
  return next;
}

export function generateDocument(payload = {}) {
  const kind = payload.kind;
  if (!Object.hasOwn(DOCUMENT_KINDS, kind)) throw new Error('请选择对账单、出货单或退胚单');
  const customerId = Number(payload.customerId);
  if (!Number.isSafeInteger(customerId) || customerId <= 0) throw new Error('请选择客户');
  const customer = db.prepare('SELECT id, name, contact, phone, address, settlement_days AS settlementDays FROM customers WHERE id = ?').get(customerId);
  if (!customer) throw new Error('客户不存在');
  const startDate = validDate(payload.startDate, '开始日期'), endDate = validDate(payload.endDate, '结束日期');
  if (startDate > endDate) throw new Error('开始日期不能晚于结束日期');
  const issuedDate = validDate(payload.issuedDate || businessToday(), '制单日期');
  const ids = payload.orderIds;
  if (ids !== undefined && (!Array.isArray(ids) || ids.length === 0 || ids.length > 2000 || ids.some(id => !Number.isSafeInteger(id) || id <= 0) || new Set(ids).size !== ids.length)) {
    throw new Error('请选择 1–2000 条有效且不重复的明细');
  }
  return db.transaction(() => {
    const source = db.prepare(`SELECT s.id, s.order_no AS orderNo, s.business_type AS businessType,
      s.customer_id AS customerId, s.partner, s.order_date AS orderDate, s.delivery_no AS deliveryNo,
      s.process_no AS processNo, s.outsource_no AS outsourceNo, i.code AS itemCode,
      i.specification, i.name AS itemName, i.unit, COALESCE(NULLIF(s.plating, ''), i.plating) AS plating,
      s.quantity, s.unit_price AS unitPrice, s.total_amount AS amount, s.remark, s.operator,
      b.id AS billId, b.voided_at AS billVoidedAt, b.bill_type AS billType,
      b.quantity AS billedQuantity, b.unit_price AS billedUnitPrice, b.amount AS billedAmount, b.currency
      FROM stock_orders s JOIN inventory_items i ON i.id = s.item_id
      LEFT JOIN bills b ON b.stock_order_id = s.id
      WHERE s.type = '出库' AND s.voided_at = '' AND s.customer_id = ? AND s.order_date >= ? AND s.order_date <= ?
      ${kind === 'blank-return' ? "AND s.business_type = '退胚'" : kind === 'statement' ? "AND s.business_type NOT IN ('退胚', '返工出货')" : "AND s.business_type != '退胚'"}
      ORDER BY s.order_date, s.delivery_no, s.id`).all(customerId, startDate, endDate);
    let rows = source;
    const warnings = [];
    if (kind === 'statement') {
      const unbilled = source.filter(r => !r.billId).length;
      const voided = source.filter(r => r.billId && r.billVoidedAt).length;
      if (unbilled) warnings.push(`本期有 ${unbilled} 笔出货尚未开账，未计入对账单。可在对账明细中补建账单。`);
      if (voided) warnings.push(`本期有 ${voided} 笔账单已作废，未计入对账单。`);
      rows = source.filter(r => r.billId && !r.billVoidedAt && r.billType === '应收');
      if (rows.some(r => r.currency !== 'RMB')) throw new Error('本期存在非 RMB 账单，请先核对币种，不能合并对账');
      rows = rows.map(r => ({ ...r, quantity: r.billedQuantity, unitPrice: r.billedUnitPrice, amount: r.billedAmount }));
    }
    if (ids) {
      const wanted = new Set(ids);
      rows = rows.filter(r => wanted.has(r.id));
      if (rows.length !== wanted.size) throw new Error('所选记录已变更，或不属于当前客户、日期和单据类型，请重新查询');
    }
    rows = rows.map(({ billedQuantity, billedUnitPrice, billedAmount, billVoidedAt, ...row }, i) => ({ ...row, sequence: i + 1 }));
    const amountCents = rows.reduce((sum, r) => sum + Math.round(r.amount * 100), 0);
    if (!Number.isSafeInteger(amountCents)) throw new Error('对账金额超出可计算范围');
    return { kind, title: kind === 'statement' ? statementTitle(startDate, endDate) : DOCUMENT_KINDS[kind],
      customer, startDate, endDate, issuedDate, preparedBy: String(payload.preparedBy || payload.actor || '').trim().slice(0, 80),
      partial: Boolean(ids && rows.length !== source.filter(r => kind !== 'statement' || (r.billId && !r.billVoidedAt && r.billType === '应收')).length),
      settings: getPrintSettings(), rows, groups: groupDocumentRows(rows, kind), warnings,
      totals: { quantity: Number(rows.reduce((sum, r) => sum + r.quantity, 0).toFixed(6)), amount: amountCents / 100, count: rows.length },
      generatedAt: new Date().toISOString() };
  })();
}
