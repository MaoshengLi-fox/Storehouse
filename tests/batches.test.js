import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, beforeEach, test } from 'node:test';
import * as business from '../server/database.js';
import { buildDocumentHtml } from '../src/utils/printDocuments.js';
import { summarizeBatch } from '../shared/businessTypes.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-batches-'));
let round = 0, itemId, otherItemId, customerId, otherCustomerId;
beforeEach(() => {
  business.initializeDatabase(path.join(root, String(++round)));
  itemId = business.createInventoryItem({ code: 'BATCH-01', name: '底座', specification: '底座 280', unit: '件', stockQty: 100, unitPrice: 5, plating: '砂镍' }).itemId;
  otherItemId = business.createInventoryItem({ code: 'BATCH-02', name: '面板', specification: '面板 100', unit: '件', stockQty: 100, unitPrice: 5 }).itemId;
  business.createPriceSheet({ itemId, unitPrice: 5, effectiveDate: '2000-01-01' });
  customerId = business.createCustomer({ name: '批次客户', settlementDays: 30 }).id;
  otherCustomerId = business.createCustomer({ name: '另一客户', settlementDays: 30 }).id;
});
after(() => { business.closeDatabase(); fs.rmSync(root, { recursive: true, force: true }); });

const base = () => ({ itemId, customerId, partner: '批次客户', processNo: 'P-001', operator: '测试员', orderDate: '2020-06-10' });
const inbound = (businessType, quantity, extra = {}) => business.createStockOrder({ ...base(), type: '入库', businessType, quantity, deliveryNo: `IN-${Math.random()}`, ...extra });
const outbound = (businessType, quantity, extra = {}) => business.createStockOrder({ ...base(), type: '出库', businessType, quantity, deliveryNo: 'S-001', ...extra });
const order = (id) => business.getStockOrders().find(o => o.id === id);

test('入库三种标签都保留且不计金额，非法标签被拒绝', () => {
  for (const label of ['正常入库', '退胚回库', '不良退回']) {
    const created = inbound(label, 3, { unitPrice: 9 });
    assert.equal(created.totalAmount, 0);
    assert.equal(order(created.id).businessType, label); assert.equal(order(created.id).unitPrice, 0);
  }
  assert.throws(() => inbound('随便写', 1), /业务类型只能是/);
  assert.throws(() => outbound('退货', 1), /业务类型只能是/);
  const first = business.getStockOrders().find(o => o.businessType === '正常入库');
  business.updateStockOrder({ ...first, unitPrice: 8, quantity: 4 });
  assert.equal(order(first.id).totalAmount, 0);
  assert.equal(business.getInventoryItems().find(i => i.id === itemId).stockQty, 110); // 期初 100 属于其他批次
});

test('退胚按客户、物料、加工单号关联收货，不能超过收货减已出货减已退胚', () => {
  inbound('正常入库', 10); inbound('退胚回库', 5);
  outbound('成品出货', 6);
  const blank = outbound('退胚', 9, { deliveryNo: 'TP-1' });
  assert.equal(order(blank.id).totalAmount, 0); assert.equal(business.getBills().length, 1);
  assert.throws(() => outbound('退胚', 1), /退胚合计 10，超出 1/);
  assert.throws(() => outbound('退胚', 1, { processNo: '' }), /须选择原收货批次/);
  assert.throws(() => outbound('退胚', 1, { processNo: 'P-404' }), /没有该客户该物料的收货记录/);
  assert.throws(() => outbound('退胚', 1, { customerId: otherCustomerId, partner: '另一客户' }), /没有该客户该物料的收货记录/);
  inbound('正常入库', 5, { itemId: otherItemId });
  assert.throws(() => outbound('退胚', 6, { itemId: otherItemId }), /超出 1/);
  const summary = summarizeBatch(business.getStockOrders().filter(o => o.itemId === itemId && o.processNo === 'P-001'));
  assert.deepEqual([summary.received, summary.shipped, summary.blankReturned, summary.blankAvailable], [15, 6, 9, 0]);
});

test('已有退胚的批次，修改或撤销收货、继续出货都不能让退胚超出', () => {
  const receipt = inbound('正常入库', 10);
  const blank = outbound('退胚', 4, { deliveryNo: 'TP-1' });
  outbound('成品出货', 6);
  assert.throws(() => outbound('成品出货', 1), /此操作后.*退胚将超出可退数量.*请先调整或撤销该批次的退胚/);
  assert.throws(() => business.updateStockOrder({ ...order(receipt.id), quantity: 9 }), /此操作后.*退胚将超出可退数量.*请先调整或撤销该批次的退胚/);
  assert.throws(() => business.updateStockOrder({ ...order(receipt.id), processNo: 'P-999' }), /将没有对应的收货记录/);
  assert.throws(() => business.deleteStockOrder(receipt.id), /退胚将超出可退数量|将没有对应的收货记录/);
  assert.throws(() => business.updateStockOrder({ ...order(blank.id), quantity: 5 }), /超出 1/);
  business.updateStockOrder({ ...order(blank.id), quantity: 3 });
  assert.equal(order(blank.id).quantity, 3);
  business.deleteStockOrder(blank.id);
  business.updateStockOrder({ ...order(receipt.id), quantity: 6 }); // no blank return left, so receipts can shrink freely
  assert.equal(business.getInventoryItems().find(i => i.id === itemId).stockQty, 100);
});

test('返工出货免费：不开账单、不进对账单，数量不超过不良退回，类型不可互改', () => {
  inbound('正常入库', 10); outbound('成品出货', 10);
  assert.throws(() => outbound('返工出货', 1), /没有该客户该物料的不良退回记录/);
  inbound('不良退回', 4, { orderDate: '2020-06-12' });
  const rework = outbound('返工出货', 3, { deliveryNo: 'S-002', orderDate: '2020-06-15', unitPrice: 5 });
  assert.equal(rework.totalAmount, 0); assert.equal(order(rework.id).unitPrice, 0);
  assert.equal(business.getBills().length, 1);
  assert.throws(() => business.createBill({ stockOrderId: rework.id }), /返工出货不产生加工费账单/);
  assert.throws(() => outbound('返工出货', 2, { deliveryNo: 'S-003' }), /返工出货超出退货数量：不良退回 4，返工出货合计 5，超出 1/);
  assert.throws(() => business.updateStockOrder({ ...order(rework.id), businessType: '成品出货' }), /不能互相修改/);
  const statement = business.generateDocument({ kind: 'statement', customerId, startDate: '2020-06-01', endDate: '2020-06-30' });
  assert.equal(statement.rows.length, 1); assert.equal(statement.warnings.length, 0); assert.equal(statement.totals.amount, 50);
  const delivery = business.generateDocument({ kind: 'delivery', customerId, startDate: '2020-06-15', endDate: '2020-06-15' });
  assert.equal(delivery.rows.length, 1);
  assert.match(buildDocumentHtml(delivery, { preset: 'continuous-241-half' }), /出货单（返工）/);
});

test('经营分析按业务标签统计数量，出货金额只计成品出货', () => {
  inbound('正常入库', 10); inbound('退胚回库', 2); inbound('不良退回', 1);
  outbound('成品出货', 4); outbound('退胚', 3, { deliveryNo: 'TP-1' }); outbound('返工出货', 1, { deliveryNo: 'S-002' });
  const [month] = business.getDashboardData().monthlyTrend;
  assert.equal(month.month, '2020-06'); assert.equal(month.outboundAmount, 20);
  assert.deepEqual(month.quantities, { 正常入库: 10, 退胚回库: 2, 不良退回: 1, 成品出货: 4, 退胚: 3, 返工出货: 1 });
  assert.equal('profit' in business.getDashboardData().accountStats, false);
});
