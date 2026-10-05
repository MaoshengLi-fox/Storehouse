import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, beforeEach, test } from 'node:test';
import Database from 'better-sqlite3';
import * as business from '../server/database.js';
import { effectivePrice, businessToday } from '../server/operations.js';
import { priceAtDate } from '../src/utils/pricing.js';
import { createBackupManager, validateBusinessBackup, backupBeforeUpgrade } from '../server/backups.js';
import { initializeStorageLayout } from '../server/storage.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-operations-'));
let run = 0, storage, manager;
beforeEach(() => { manager?.stop(); storage = initializeStorageLayout(path.join(root, String(++run))); business.initializeDatabase(storage.businessDir); business.createCustomer({ name: '恒丰测试客户' }); manager = createBackupManager(storage); });
after(() => { manager?.stop(); business.closeDatabase(); fs.rmSync(root, { recursive: true, force: true }); });

function material(overrides = {}) {
  return business.createInventoryItem({ code: `MAT-${business.getInventoryItems().length + 1}`, name: '盘点物料', specification: 'φ50', unit: '件', stockQty: 100, unitPrice: 5, ...overrides }).itemId;
}
function sale(overrides = {}) {
  const itemId = overrides.itemId || material();
  return business.createStockOrder({ type: '出库', itemId, quantity: 10, unitPrice: 5, partner: '恒丰测试客户', operator: '测试员', deliveryNo: `D-${Date.now()}`, orderDate: '2020-01-01', ...overrides });
}
function collect(bill, amount, overrides = {}) {
  return business.createReceipt({ billId: bill.id, amount, receiptDate: '2020-01-02', method: '银行转账', requestKey: `test-${Math.random()}`, ...overrides });
}

test('账单作废留档、汇总排除，重复启动不重建；恢复保留原开单价', () => {
  sale(); const original = business.getBills()[0];
  business.deleteBill(original.id, { reason: '重复开单', actor: '测试员' });
  assert.equal(business.getDashboardData().accountStats.receivable, 0);
  business.initializeDatabase(storage.businessDir);
  let bills = business.getBills();
  assert.equal(bills.length, 1); assert.equal(bills[0].status, '已作废');
  assert.equal(bills[0].voidReason, '重复开单');
  assert.throws(() => business.createBill({ stockOrderId: original.stockOrderId }), /已存在/);
  business.restoreBill(original.id);
  bills = business.getBills();
  assert.equal(bills[0].status, '未结清'); assert.equal(bills[0].unitPrice, original.unitPrice);
  assert.equal(business.getBillEvents(original.id).length, 3);
});

test('明确不自动开账的出货在重启后仍不补建，可手动补建', () => {
  const order = sale({ autoCreateBill: false });
  business.initializeDatabase(storage.businessDir);
  assert.equal(business.getBills().length, 0);
  business.createBill({ stockOrderId: order.id });
  assert.equal(business.getBills().length, 1);
});

test('撤销出货回退库存并保留作废账单，不可恢复已撤销出货的账单', () => {
  const order = sale(); const bill = business.getBills()[0];
  business.deleteStockOrder(order.id, { cascadeBill: true, actor: '测试员' });
  assert.equal(business.getStockOrders().length, 0);
  assert.equal(business.getInventoryItems()[0].stockQty, 100);
  assert.equal(business.getBills()[0].status, '已作废');
  assert.throws(() => business.restoreBill(bill.id), /出货记录已撤销/);
  business.initializeDatabase(storage.businessDir);
  assert.equal(business.getBills().length, 1);
  assert.equal(business.getInventoryLedger()[0].eventType, '单据撤销');
});

test('未来价格不提前启用，回填历史价不覆盖当前价，同日最后修订优先', () => {
  const itemId = material();
  business.createPriceSheet({ itemId, unitPrice: 6, effectiveDate: '2001-01-01' });
  business.createPriceSheet({ itemId, unitPrice: 12, effectiveDate: '2999-01-01' });
  business.createPriceSheet({ itemId, unitPrice: 4, effectiveDate: '2000-01-01' });
  assert.equal(business.getInventoryItems()[0].unitPrice, 6);
  assert.equal(effectivePrice(itemId, '2000-10-01'), 4);
  assert.equal(effectivePrice(itemId, '2999-01-01'), 12);
  const revision = business.createPriceSheet({ itemId, unitPrice: 7, effectiveDate: '2001-01-01' });
  assert.equal(business.getInventoryItems()[0].unitPrice, 7);
  business.initializeDatabase(storage.businessDir);
  assert.equal(business.getPriceSheets().filter(p => p.isActive).length, 1);
  assert.equal(business.getInventoryItems()[0].unitPrice, 7);
  business.deletePriceSheet(revision.id);
  assert.equal(business.getInventoryItems()[0].unitPrice, 6);
  const uiPrice = priceAtDate(business.getPriceSheets(), business.getInventoryItems()[0], '2000-10-01');
  assert.equal(uiPrice.unitPrice, 4);
});

test('只存在未来价目的物料显示未生效，开单不能静默使用零价', () => {
  const itemId = material();
  business.createPriceSheet({ itemId, unitPrice: 12, effectiveDate: '2999-01-01' });
  assert.equal(business.getInventoryItems()[0].unitPrice, 0);
  assert.throws(() => sale({ itemId, unitPrice: undefined }), /没有已生效/);
  assert.equal(business.getStockOrders().length, 0);
});

test('新单按业务日期取价，出货价不改写标准价，调价不影响旧账单', () => {
  const itemId = material();
  business.createPriceSheet({ itemId, unitPrice: 4, effectiveDate: '2000-01-01' });
  business.createPriceSheet({ itemId, unitPrice: 6, effectiveDate: '2001-01-01' });
  sale({ itemId, unitPrice: undefined, orderDate: '2000-06-01' });
  assert.equal(business.getBills()[0].unitPrice, 4);
  assert.equal(business.getInventoryItems()[0].unitPrice, 6);
  business.createPriceSheet({ itemId, unitPrice: 8, effectiveDate: '2002-01-01' });
  assert.equal(business.getBills()[0].amount, 40);
});

test('物料与价目原子保存，校验失败不残留半条物料；未来调价保持当前价', () => {
  assert.throws(() => business.saveMaterialPrice({ code: 'A', specification: '测试', unit: '件', unitPrice: 1, effectiveDate: '2025-02-30' }), /生效日期/);
  assert.equal(business.getInventoryItems().length, 0);
  const saved = business.saveMaterialPrice({ code: 'A', specification: '测试', unit: '件', unitPrice: 1, effectiveDate: '2000-01-01' });
  business.saveMaterialPrice({ itemId: saved.itemId, specification: '测试新版', unit: '件', unitPrice: 3, effectiveDate: '2999-01-01' });
  assert.equal(business.getInventoryItems()[0].unitPrice, 1);
});

test('库存台账覆盖期初、出库、修正、盘点和撤销，结余与库存一致', () => {
  const order = sale();
  business.updateStockOrder({ ...business.getStockOrders()[0], quantity: 12 });
  const item = business.getInventoryItems()[0];
  assert.equal(item.stockQty, 88);
  business.adjustInventory({ itemId: item.id, expectedStockQty: 88, actualQty: 90, reason: '盘盈 2 件', actor: '仓管' });
  business.deleteStockOrder(order.id, { cascadeBill: true });
  const ledger = business.getInventoryLedger({ itemId: item.id });
  assert.equal(ledger.length, 5);
  assert.equal(ledger.reduce((sum, row) => sum + row.quantityDelta, 0), 102);
  assert.equal(ledger[0].balanceAfter, business.getInventoryItems()[0].stockQty);
  assert.equal(ledger[1].operator, '仓管');
});

test('盘点防止覆盖并发变化，负数/无穷值/空原因不写入', () => {
  const itemId = material(); sale({ itemId });
  assert.throws(() => business.adjustInventory({ itemId, expectedStockQty: 100, actualQty: 99, reason: '盘点' }), /库存已被/);
  assert.throws(() => business.adjustInventory({ itemId, expectedStockQty: 90, actualQty: -1, reason: '盘点' }), /非负数/);
  assert.throws(() => sale({ itemId, quantity: Infinity }), /非负数/);
  assert.throws(() => business.adjustInventory({ itemId, expectedStockQty: 90, actualQty: 91, reason: '' }), /原因/);
  assert.equal(business.getInventoryItems()[0].stockQty, 90);
  assert.equal(business.getInventoryLedger().length, 2);
});

test('撤销已消耗的入库不能让库存变负，失败时流水与库存保持不变', () => {
  const itemId = material({ stockQty: 0 });
  const inbound = sale({ itemId, type: '入库', quantity: 10 });
  sale({ itemId, quantity: 9 });
  assert.throws(() => business.deleteStockOrder(inbound.id), /库存不足/);
  assert.equal(business.getInventoryItems()[0].stockQty, 1);
  assert.equal(business.getInventoryLedger().length, 3);
});

test('客户账期应用到新账单，改名保留历史快照，停用后禁止新单但可收款', () => {
  const { id } = business.createCustomer({ name: '统一客户', contact: '陈先生', settlementDays: 45 });
  sale({ customerId: id, partner: '统一客户' });
  let bill = business.getBills()[0];
  assert.equal(bill.dueDate, '2020-02-15'); assert.equal(bill.customerId, id);
  business.updateCustomer({ id, name: '更名后的客户', settlementDays: 10, isActive: false });
  assert.equal(business.getBills()[0].partner, '统一客户');
  assert.equal(business.getBills()[0].dueDate, '2020-02-15');
  assert.throws(() => sale({ customerId: id }), /已停用/);
  collect(bill, 20);
  const customer = business.getCustomers().find(c => c.id === id);
  assert.equal(customer.balanceAmount, 30); assert.equal(customer.receivedAmount, 20);
  assert.throws(() => business.createCustomer({ name: '更名后的客户' }), /已存在/);
});

test('分次收款自动部分/全额结清，作废收款回退余额，重启保持状态', () => {
  sale(); const bill = business.getBills()[0];
  collect(bill, 20);
  assert.equal(business.getBills()[0].status, '部分收款');
  assert.equal(business.getBills()[0].balanceAmount, 30);
  const second = collect(bill, 30);
  assert.equal(business.getBills()[0].status, '已结算');
  assert.equal(business.getDashboardData().accountStats.cashBalance, 50);
  business.voidReceipt(second.id, { reason: '录入重复', actor: '财务' });
  business.initializeDatabase(storage.businessDir);
  assert.equal(business.getBills()[0].status, '部分收款');
  assert.equal(business.getBills()[0].balanceAmount, 30);
  assert.equal(business.getReceipts().length, 2);
  assert.equal(business.getCustomers()[0].balanceAmount, 30);
});

test('收款按分计算，幂等请求不重复入账，超额/精度/未来日期拒绝', () => {
  sale({ quantity: 1, unitPrice: 0.3 }); const bill = business.getBills()[0];
  collect(bill, 0.1, { requestKey: 'once' }); collect(bill, 0.1, { requestKey: 'once' });
  assert.equal(business.getReceipts().length, 1);
  assert.throws(() => collect(bill, 0.2, { requestKey: 'once' }), /重复请求/);
  assert.throws(() => collect(bill, 0.3), /超过/);
  assert.throws(() => collect(bill, 0.001), /两位小数/);
  assert.throws(() => collect(bill, 0.1, { receiptDate: '2999-01-01' }), /晚于今天/);
  collect(bill, 0.2);
  assert.equal(business.getBills()[0].balanceAmount, 0);
  assert.equal(business.getBills()[0].status, '已结算');
});

test('已有收款禁止修改出货数量、撤销出货或作废账单，失败操作完全回滚', () => {
  const order = sale(); const bill = business.getBills()[0]; collect(bill, 10);
  assert.throws(() => business.updateStockOrder({ ...business.getStockOrders()[0], quantity: 1 }), /已有收款/);
  assert.throws(() => business.deleteStockOrder(order.id, { cascadeBill: true }), /已有收款/);
  assert.throws(() => business.deleteBill(bill.id, { reason: '作废' }), /已有收款/);
  assert.equal(business.getInventoryItems()[0].stockQty, 90);
  assert.equal(business.getBills()[0].amount, 50);
  assert.equal(business.getBills()[0].voidedAt, '');
});

test('旧结清账单迁移为独立历史结清金额，不伪造收款且升级幂等', async () => {
  sale(); const file = business.getDatabasePath(); business.closeDatabase();
  const old = new Database(file);
  old.prepare("UPDATE bills SET status = '已结算', legacy_settled_cents = NULL").run();
  old.prepare("DELETE FROM app_settings WHERE key = 'operationsMigrationV1'").run();
  old.exec('DROP TABLE customers; DROP TABLE inventory_ledger;');
  old.pragma('user_version = 0'); old.close();
  await backupBeforeUpgrade(storage);
  assert.equal(manager.list().backups[0].kind, 'before-upgrade');
  business.initializeDatabase(storage.businessDir); business.initializeDatabase(storage.businessDir);
  const bill = business.getBills()[0];
  assert.equal(bill.legacySettledAmount, 50); assert.equal(bill.balanceAmount, 0);
  assert.equal(business.getReceipts().length, 0); assert.equal(business.getDashboardData().accountStats.cashBalance, 0);
  assert.equal(business.getInventoryLedger().length, 1);
  assert.equal(business.getInventoryLedger()[0].balanceAfter, 90);
  business.clearLegacySettlement(bill.id, { reason: '核实历史标记有误', actor: '管理员' });
  assert.equal(business.getBills()[0].balanceAmount, 50);
});

test('业务备份完整恢复账单、库存、客户和收款，恢复前保留保护副本', async () => {
  sale(); collect(business.getBills()[0], 10);
  const snapshot = await manager.create();
  business.adjustInventory({ itemId: business.getInventoryItems()[0].id, expectedStockQty: 90, actualQty: 80, reason: '测试盘点' });
  collect(business.getBills()[0], 10);
  const result = await manager.restore(snapshot.id, '恢复业务数据');
  assert.equal(business.getInventoryItems()[0].stockQty, 90);
  assert.equal(business.getReceipts().length, 1);
  assert.equal(business.getBills()[0].balanceAmount, 40);
  assert.equal(business.getCustomers()[0].balanceAmount, 40);
  assert.equal(business.getInventoryLedger()[0].balanceAfter, 90);
  assert.ok(manager.list().backups.some(b => b.id === result.safetyBackupId));
  await manager.restore(result.safetyBackupId, '恢复业务数据');
  assert.equal(business.getInventoryItems()[0].stockQty, 80);
  assert.equal(business.getReceipts().length, 2);
});

test('恢复拒绝错误确认、损坏数据库、非业务库和路径穿越，不影响现有数据', async () => {
  sale(); const snapshot = await manager.create();
  await assert.rejects(manager.restore(snapshot.id, '确认'), /请输入/);
  assert.throws(() => manager.filePath('../business/factory-desk.db'), /编号/);
  assert.throws(() => manager.upload(Buffer.from('not sqlite')), /SQLite/);
  const otherPath = path.join(root, 'unrelated.db');
  const other = new Database(otherPath); other.exec('CREATE TABLE unrelated (id INTEGER)'); other.close();
  assert.throws(() => validateBusinessBackup(otherPath), /不是有效/);
  assert.throws(() => manager.upload(fs.readFileSync(otherPath)), /不是有效/);
  assert.equal(business.getInventoryItems()[0].stockQty, 90);
  assert.equal(manager.list().backups.length, 1);
});

test('自动备份按间隔运行、保留份数有效，手动备份不被清理', async () => {
  manager.updateSettings({ intervalHours: 1, retention: 2 });
  const manual = await manager.create();
  await manager.tick(); const firstCount = manager.list().backups.length;
  await manager.tick(); assert.equal(manager.list().backups.length, firstCount);
  await manager.create('auto'); await manager.create('auto');
  assert.equal(manager.list().backups.filter(b => b.kind === 'auto').length, 2);
  assert.ok(fs.existsSync(manager.filePath(manual.id)));
  manager.updateSettings({ enabled: false });
  assert.equal(createBackupManager(storage).list().settings.enabled, false);
  assert.throws(() => manager.updateSettings({ retention: 0 }), /1 至 90/);
});

test('上传有效备份后可恢复，新模块随业务重置清空', async () => {
  sale(); collect(business.getBills()[0], 10);
  const original = await manager.create();
  const upload = manager.upload(fs.readFileSync(manager.filePath(original.id)));
  business.resetBusinessData();
  assert.equal(business.getInventoryLedger().length, 0); assert.equal(business.getReceipts().length, 0); assert.equal(business.getCustomers().length, 0);
  await manager.restore(upload.id, '恢复业务数据');
  assert.equal(business.getReceipts().length, 1);
  assert.equal(business.getBills()[0].amount, 50);
});

test('业务日按明确的业务时区跨日，价格生效与客户端一致', () => {
  assert.equal(businessToday(new Date('2026-09-21T16:30:00Z')), '2026-09-22');
  assert.equal(businessToday(new Date('2026-09-21T15:59:00Z')), '2026-09-21');
});

test('库存台账已经发生变动的物料不能删除，空白物料仍可删除', () => {
  const itemId = material();
  assert.throws(() => business.deleteInventoryItem(itemId), /库存或库存变动/);
  const empty = material({ stockQty: 0 });
  business.deleteInventoryItem(empty);
  assert.equal(business.getInventoryItems().length, 1);
});

test('小数库存按数量精度计算，连续出库与撤销不会产生浮点负库存', () => {
  const itemId = material({ stockQty: 0.3, unit: 'kg' });
  const first = sale({ itemId, quantity: 0.1 });
  sale({ itemId, quantity: 0.2 });
  assert.equal(business.getInventoryItems()[0].stockQty, 0);
  business.deleteStockOrder(first.id, { cascadeBill: true });
  assert.equal(business.getInventoryItems()[0].stockQty, 0.1);
  assert.throws(() => business.adjustInventory({ itemId, expectedStockQty: 0.1, actualQty: 0.1234567, reason: '盘点' }), /六位小数/);
});

test('修正未收款出货日期时保留开单账期，到期日不早于新账单日', () => {
  sale();
  const original = business.getStockOrders()[0];
  business.updateStockOrder({ ...original, orderDate: '2020-03-01' });
  const bill = business.getBills()[0];
  assert.equal(bill.billDate, '2020-03-01');
  assert.equal(bill.dueDate, '2020-03-31');
  assert.equal(bill.unitPrice, 5);
});

test('已有库存流水的物料不允许变更计量单位，历史数量含义保持一致', () => {
  const itemId = material();
  assert.throws(() => business.updateInventoryItem({ id: itemId, unit: 'kg' }), /不能变更计量单位/);
  assert.equal(business.getInventoryItems()[0].unit, '件');
  assert.equal(business.getInventoryLedger()[0].unit, '件');
  const empty = material({ stockQty: 0 });
  business.updateInventoryItem({ id: empty, unit: 'kg' });
  assert.equal(business.getInventoryItems().find(i => i.id === empty).unit, 'kg');
});
