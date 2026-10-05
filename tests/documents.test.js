import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, beforeEach, test } from 'node:test';
import XLSX from 'xlsx';
import * as business from '../server/database.js';
import { exportDocumentWorkbook } from '../server/documentExport.js';
import { normalizePaper, groupDocumentRows, PAPER_PRESETS } from '../shared/documents.js';
import { buildDocumentHtml } from '../src/utils/printDocuments.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-documents-'));
let round = 0, dir, itemId, customerId;
beforeEach(() => {
  dir = path.join(root, String(++round)); business.initializeDatabase(dir);
  itemId = business.createInventoryItem({ code: '000503003701052', name: '底座', specification: '底座 280*30*T0.8MM', unit: '件', stockQty: 1000, unitPrice: 7.03, plating: '黄古铜' }).itemId;
  customerId = business.createCustomer({ name: '模板测试客户', settlementDays: 30 }).id;
});
after(() => { business.closeDatabase(); fs.rmSync(root, { recursive: true, force: true }); });
function sale(overrides = {}) { return business.createStockOrder({ type: '出库', businessType: '成品出货', itemId, customerId, partner: '模板测试客户', quantity: 2, unitPrice: 7.03, deliveryNo: '00002600001', processNo: '0060600168', operator: '测试员', orderDate: '2020-06-15', ...overrides }); }
function receive(overrides = {}) { return business.createStockOrder({ type: '入库', businessType: '正常入库', itemId, customerId, partner: '模板测试客户', quantity: 20, deliveryNo: 'R-0001', processNo: '0060600168', operator: '测试员', orderDate: '2020-06-01', ...overrides }); }
function doc(overrides = {}) { return business.generateDocument({ kind: 'statement', customerId, startDate: '2020-06-01', endDate: '2020-06-30', preparedBy: '测试员', ...overrides }); }
function zipText(bytes, name) { const zip = XLSX.CFB.read(bytes, { type: 'buffer' }); return Buffer.from(zip.FileIndex[zip.FullPaths.findIndex(p => p.endsWith('/' + name))].content).toString(); }

test('按客户及送货日期闭区间对账，使用开单金额，已收款记录仍在单内', () => {
  sale({ orderDate: '2020-05-31' }); const first = sale({ orderDate: '2020-06-01' }); sale({ orderDate: '2020-06-30' }); sale({ orderDate: '2020-07-01' });
  business.createCustomer({ name: '另一客户' }); sale({ customerId: undefined, partner: '另一客户' });
  const bill = business.getBills().find(b => b.stockOrderId === first.id);
  business.createReceipt({ billId: bill.id, amount: 14.06, receiptDate: '2020-06-02', method: '现金', requestKey: 'paid' });
  business.createPriceSheet({ itemId, unitPrice: 99, effectiveDate: '2020-01-01' });
  const result = doc();
  assert.equal(result.title, '2020年6月对账单'); assert.equal(result.rows.length, 2);
  assert.equal(result.totals.amount, 28.12); assert.equal(result.rows[0].unitPrice, 7.03);
  assert.equal(result.rows[0].orderDate, '2020-06-01'); assert.equal(result.rows[1].orderDate, '2020-06-30');
  assert.equal(doc({ startDate: '2020-06-01', endDate: '2020-06-01' }).title, '2020-06-01 至 2020-06-01 对账单');
});

test('退胚扣库存且金额为零，不自动或手动开账；重启、修改和撤销保持一致', () => {
  business.createPriceSheet({ itemId, unitPrice: 100, effectiveDate: '2999-01-01' });
  receive({ quantity: 10 });
  const result = sale({ businessType: '退胚', unitPrice: undefined });
  assert.equal(result.totalAmount, 0); assert.equal(business.getBills().length, 0);
  assert.equal(business.getInventoryItems()[0].stockQty, 1008); assert.equal(business.getInventoryLedger()[0].eventType, '退胚');
  assert.throws(() => business.createBill({ stockOrderId: result.id }), /退胚/);
  business.initializeDatabase(dir); assert.equal(business.getBills().length, 0);
  const record = business.getStockOrders()[0]; business.updateStockOrder({ ...record, quantity: 3 });
  assert.equal(business.getInventoryItems()[0].stockQty, 1007); assert.equal(business.getBills().length, 0);
  assert.throws(() => business.updateStockOrder({ ...record, businessType: '成品出货' }), /不能互相修改/);
  assert.equal(doc().rows.length, 0); assert.equal(doc({ kind: 'delivery' }).rows.length, 0);
  assert.equal(doc({ kind: 'blank-return' }).rows[0].quantity, 3);
  business.deleteStockOrder(result.id); assert.equal(business.getInventoryItems()[0].stockQty, 1010);
  assert.equal(doc({ kind: 'blank-return' }).rows.length, 0);
});

test('作废、撤销、未开账及退胚不混入对账；未开账有明确提示', () => {
  receive(); sale(); sale({ autoCreateBill: false }); const voided = sale(); const canceled = sale(); sale({ businessType: '退胚' });
  business.deleteBill(business.getBills().find(b => b.stockOrderId === voided.id).id, { reason: '测试作废' });
  business.deleteStockOrder(canceled.id, { cascadeBill: true });
  const result = doc(); assert.equal(result.rows.length, 1); assert.equal(result.totals.amount, 14.06);
  assert.equal(result.warnings.length, 2); assert.match(result.warnings[0], /1 笔出货尚未开账/);
  assert.equal(doc({ kind: 'delivery' }).rows.length, 3);
});

test('明确选择记录，拒绝跨客户、跨日期、重复、过期和空选择', () => {
  const a = sale(), b = sale({ orderDate: '2020-06-16' });
  business.createCustomer({ name: '他人客户' }); const other = sale({ customerId: undefined, partner: '他人客户' });
  assert.equal(doc({ orderIds: [a.id] }).partial, true);
  assert.equal(doc({ orderIds: [a.id, b.id] }).partial, false);
  for (const ids of [[], [a.id, a.id], [other.id], [123456], ['1']]) assert.throws(() => doc({ orderIds: ids }), /选择|记录|明细/);
  assert.throws(() => doc({ orderIds: [a.id], startDate: '2020-06-16' }), /记录/);
  business.deleteStockOrder(a.id, { cascadeBill: true }); assert.throws(() => doc({ orderIds: [a.id] }), /记录/);
  assert.throws(() => doc({ startDate: '2020-02-30' }), /日期/);
  assert.throws(() => doc({ startDate: '2020-07-01' }), /不能晚于/);
  assert.throws(() => doc({ kind: '__proto__' }), /请选择/);
  assert.throws(() => doc({ customerId: 0 }), /请选择客户/);
});

test('同号跨日期分单，客户改名后仍按稳定客户 ID 归集', () => {
  sale(); sale(); sale({ orderDate: '2020-06-16' });
  business.updateCustomer({ id: customerId, name: '新名称', isActive: false });
  const result = doc({ kind: 'delivery' }); assert.equal(result.customer.name, '新名称');
  assert.equal(result.groups.length, 2); assert.equal(result.groups[0].rows.length, 2);
  assert.equal(groupDocumentRows([{ customerId: 1, orderDate: '2020-06-01', deliveryNo: 'S' }, { customerId: 2, orderDate: '2020-06-01', deliveryNo: 'S' }], 'delivery').length, 2);
});

test('抬头配置保存及重启可读，HTML 转义客户和物料，连续纸尺寸受校验', () => {
  business.updatePrintSettings({ companyName: '测试公司 <script>alert(1)</script>' }); sale({ remark: '<img src=x onerror=alert(1)>' });
  business.initializeDatabase(dir);
  const html = buildDocumentHtml(doc({ kind: 'delivery' }), { preset: 'continuous-241-half' });
  assert.match(html, /241mm 139.7mm/); assert.match(html, /&lt;script&gt;/); assert.doesNotMatch(html, /<script>|<img/);
  assert.match(html, /000503003701052/); assert.match(html, /客户：/); assert.match(html, /1存根（白）/);
  for (const preset of PAPER_PRESETS) assert.ok(normalizePaper({ preset: preset.id }).height >= 80);
  assert.throws(() => normalizePaper({ preset: 'custom', width: 0, height: 90 }), /纸宽/);
  assert.throws(() => normalizePaper({ margin: '0; color:red' }), /页边距/);
  assert.throws(() => business.updatePrintSettings({ companyName: '' }), /不能为空/);
});

test('Excel 对账单保留版式、日期数值、文本编码、开单金额及合计公式', () => {
  sale({ remark: '=HYPERLINK("malicious")' }); sale();
  const result = doc(), bytes = exportDocumentWorkbook(result);
  const workbook = XLSX.read(bytes, { type: 'buffer', cellStyles: true, cellNF: true }); const s = workbook.Sheets['客户对账单'];
  assert.ok(s); assert.equal(s.E6.t, 's'); assert.equal(s.E6.v, '000503003701052');
  assert.equal(s.D6.v, '0060600168'); assert.equal(s.B6.t, 'n'); assert.equal(s.J6.v, 14.06);
  assert.equal(s.B6.z, 'yyyy/mm/dd'); assert.equal(s.J6.z, '0.00');
  assert.equal(s.K6.t, 's'); assert.equal(s.K6.f, undefined);
  assert.equal(s.J8.f, 'SUM(J6:J7)'); assert.equal(s.J8.v, 28.12); assert.ok(s['!merges'].length >= 7);
  const raw = zipText(bytes, 'xl/worksheets/sheet1.xml'); assert.match(raw, /paperWidth="297mm"/); assert.match(raw, /paperHeight="210mm"/);
  assert.doesNotMatch(raw, /undefined/);
  assert.match(zipText(bytes, 'xl/workbook.xml'), /_xlnm.Print_Titles/);
  assert.match(zipText(bytes, 'xl/styles.xml'), /SimSun/);
});

test('Excel 出货超过八条分页，退胚使用独立表头、签收栏和纸张尺寸', () => {
  for (let i = 0; i < 9; i++) sale();
  const bytes = exportDocumentWorkbook(doc({ kind: 'delivery' }), { preset: 'continuous-241-third' });
  const raw = zipText(bytes, 'xl/worksheets/sheet1.xml'); assert.match(raw, /rowBreaks count="1"/); assert.match(raw, /paperHeight="93.1mm"/);
  assert.equal((raw.match(/NO:00002600001/g) || []).length, 2);
  receive(); sale({ businessType: '退胚' });
  const returned = exportDocumentWorkbook(doc({ kind: 'blank-return' }));
  const sheet = XLSX.read(returned, { type: 'buffer' }).Sheets['退胚单'];
  assert.equal(sheet.F5.v, '退货数量'); assert.equal(sheet.C5.v, '型号'); assert.match(sheet.A14.v, /审核/);
  assert.equal(sheet.F6.v, 2);
});
