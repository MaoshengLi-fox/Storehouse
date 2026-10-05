import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, beforeEach, test } from 'node:test';
import Database from 'better-sqlite3';
import * as XLSX from 'xlsx';
import {
  initializeDatabase, closeDatabase, getDatabasePath, createInventoryItem, updateInventoryItem,
  getInventoryItems, createPriceSheet, createStockOrder, updateStockOrder, getStockOrders,
  getBills, createBill, updateBill, getDashboardData, updateNumberingSettings, createReceipt, createCustomer
} from '../server/database.js';
import { buildWorkbook } from '../src/utils/exporters.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-business-tests-'));
let run = 0;
let dataDir;

beforeEach(() => {
  dataDir = path.join(root, String(++run));
  initializeDatabase(dataDir);
  createCustomer({ name: '原厂商' }); // orders must reference an existing customer profile
});

after(() => {
  closeDatabase();
  fs.rmSync(root, { recursive: true, force: true });
});

function itemWithStock() {
  const { itemId } = createInventoryItem({
    code: 'MAT-TEST', name: '测试物料', specification: 'φ50', unit: '件', category: '管件',
    stockQty: 10, safetyStock: 5, location: 'A-01', unitPrice: 5, plating: '砂镍', processNote: '原厂商'
  });
  createPriceSheet({ itemId, unitPrice: 5, effectiveDate: '2020-09-01', remark: '原厂商' });
  return itemId;
}

function outbound(itemId, overrides = {}) {
  return createStockOrder({
    type: '出库', itemId, quantity: 3, unitPrice: 5, partner: '原厂商', operator: '测试员',
    orderDate: '2020-09-21', deliveryNo: 'DEL-TEST', processNo: 'PRC-TEST', ...overrides
  });
}

function changePrice(itemId, unitPrice = 6) {
  updateInventoryItem({ id: itemId, specification: '更新规格', unit: '件', unitPrice });
  createPriceSheet({ itemId, unitPrice, effectiveDate: '2020-09-22', remark: '新厂商' });
}

test('编辑物料或价目保留未提供的库存、安全库存、库位及基础资料', () => {
  const itemId = itemWithStock();
  outbound(itemId);
  changePrice(itemId);
  const item = getInventoryItems()[0];
  assert.equal(item.stockQty, 7);
  assert.equal(item.safetyStock, 5);
  assert.equal(item.location, 'A-01');
  assert.equal(item.category, '管件');
  assert.equal(item.plating, '砂镍');
  assert.equal(item.processNote, '原厂商');
  assert.equal(item.unitPrice, 6);
});

test('显式传入零值或空库位仍可以清除对应字段', () => {
  const itemId = itemWithStock();
  updateInventoryItem({ id: itemId, specification: 'φ50', unit: '件', stockQty: 0, safetyStock: 0, location: '', unitPrice: 0 });
  const item = getInventoryItems()[0];
  assert.equal(item.stockQty, 10); // stock only changes through orders and 盘点, never through item edits
  assert.equal(item.safetyStock, 0);
  assert.equal(item.location, '');
  assert.equal(item.unitPrice, 5); // Existing dated prices remain authoritative.
});

test('自动编码允许空编码且连续生成不同物料号；手动模式仍要求编码', () => {
  const payload = { code: '', name: '自动编码物料', specification: 'φ20', unit: '件' };
  assert.throws(() => createInventoryItem(payload), /物料编码不能为空/);
  updateNumberingSettings({ inventoryCodeMode: 'auto' });
  createInventoryItem(payload);
  createInventoryItem(payload);
  const codes = getInventoryItems().map((item) => item.code).sort();
  assert.match(codes[0], /^MAT-\d{8}-001$/);
  assert.match(codes[1], /^MAT-\d{8}-002$/);
});

test('账单按出库开单价创建，之后调价不改变数量、单价、金额或厂商', () => {
  const itemId = itemWithStock();
  outbound(itemId, { unitPrice: 4 });
  changePrice(itemId, 9);
  const bill = getBills()[0];
  assert.equal(bill.quantity, 3);
  assert.equal(bill.unitPrice, 4);
  assert.equal(bill.amount, 12);
  assert.equal(bill.vendor, '原厂商');
  assert.equal(getDashboardData().accountStats.receivable, 12);
});

test('登记收款和编辑备注不重新计价，表格导出与汇总使用同一金额', () => {
  const itemId = itemWithStock();
  outbound(itemId);
  const before = getBills()[0];
  changePrice(itemId);
  createReceipt({ billId: before.id, amount: 15, receiptDate: '2020-09-21', method: '银行转账', requestKey: 'regression-receipt' });
  updateBill({ id: before.id, stockOrderId: before.stockOrderId, remark: '' });
  const bill = getBills()[0];
  assert.equal(bill.amount, 15);
  assert.equal(bill.unitPrice, 5);
  assert.equal(bill.status, '已结算');
  assert.equal(bill.remark, '');
  assert.equal(getDashboardData().accountStats.cashBalance, 15);
  const book = buildWorkbook('bills', [bill]);
  const [row] = XLSX.utils.sheet_to_json(book.Sheets['账单']);
  assert.equal(row['单价'], 5);
  assert.equal(row['总价'], 15);
});

test('价目调整后补建账单仍使用出库开单价', () => {
  const itemId = itemWithStock();
  const order = outbound(itemId, { autoCreateBill: false });
  changePrice(itemId);
  createBill({ stockOrderId: order.id });
  assert.equal(getBills()[0].unitPrice, 5);
  assert.equal(getBills()[0].amount, 15);
});

test('零单价单据和账单不被当前价目覆盖，重启后仍保持零值', () => {
  const itemId = itemWithStock();
  outbound(itemId, { unitPrice: 0 });
  assert.equal(getStockOrders()[0].unitPrice, 0);
  assert.equal(getBills()[0].amount, 0);
  changePrice(itemId);
  initializeDatabase(dataDir);
  assert.equal(getBills()[0].unitPrice, 0);
  assert.equal(getBills()[0].amount, 0);
});

test('修正出库数量会调整库存和账单数量，同时保留账单开单价', () => {
  const itemId = itemWithStock();
  outbound(itemId);
  changePrice(itemId);
  const order = getStockOrders()[0];
  updateStockOrder({ ...order, quantity: 4 });
  assert.equal(getInventoryItems()[0].stockQty, 6);
  const bill = getBills()[0];
  assert.equal(bill.quantity, 4);
  assert.equal(bill.unitPrice, 5);
  assert.equal(bill.amount, 20);
});

test('迁移旧账单保留原有金额，回填对应开单价且重复启动不重算', () => {
  const itemId = itemWithStock();
  outbound(itemId);
  const file = getDatabasePath();
  closeDatabase();
  const legacy = new Database(file);
  legacy.exec('ALTER TABLE bills DROP COLUMN quantity; ALTER TABLE bills DROP COLUMN unit_price;');
  legacy.prepare('UPDATE bills SET amount = 21').run();
  legacy.close();
  initializeDatabase(dataDir);
  assert.equal(getBills()[0].unitPrice, 7);
  assert.equal(getBills()[0].amount, 21);
  changePrice(itemId, 20);
  initializeDatabase(dataDir);
  const bill = getBills()[0];
  assert.equal(bill.unitPrice, 7);
  assert.equal(bill.amount, 21);
  updateBill({ id: bill.id, stockOrderId: bill.stockOrderId, remark: '迁移后编辑备注' });
  assert.equal(getBills()[0].amount, 21);
});

test('账单开立后禁止改绑、手动结清和重复开账', () => {
  const itemId = itemWithStock();
  outbound(itemId);
  const bill = getBills()[0];
  const next = outbound(itemId, { unitPrice: 8, quantity: 2, autoCreateBill: false });
  assert.throws(() => updateBill({ id: bill.id, stockOrderId: next.id }), /不可改绑/);
  assert.throws(() => updateBill({ id: bill.id, status: '已结算' }), /收款流水/);
  assert.throws(() => createBill({ stockOrderId: bill.stockOrderId }), /已存在/);
  assert.throws(() => updateBill({ id: 999, stockOrderId: next.id }), /未找到账单/);
});
