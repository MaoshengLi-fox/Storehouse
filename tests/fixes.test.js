// Regression tests for the 2026-09-30 end-to-end review findings.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, beforeEach, test } from 'node:test';
import * as business from '../server/database.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-fixes-'));
let round = 0, itemId, customerId;
beforeEach(() => {
  business.initializeDatabase(path.join(root, String(++round)));
  itemId = business.createInventoryItem({ code: 'FIX-01', name: '直管件', specification: '直管 φ50', unit: '件', stockQty: 100 }).itemId;
  customerId = business.createCustomer({ name: '盛发', settlementDays: 30 }).id;
});
after(() => { business.closeDatabase(); fs.rmSync(root, { recursive: true, force: true }); });

const order = (overrides = {}) => business.createStockOrder({ type: '出库', businessType: '成品出货', itemId, customerId, partner: '盛发',
  quantity: 1, deliveryNo: 'S-1', operator: '测试员', orderDate: '2020-06-10', ...overrides });

test('编辑安全库存/库位不改物料品名，也不能绕过盘点直接改库存', () => {
  const ledgerBefore = business.getInventoryLedger().length;
  business.updateInventoryItem({ id: itemId, safetyStock: 5, location: 'A-1' });
  business.updateInventoryItem({ id: itemId, stockQty: 3 });
  const item = business.getInventoryItems()[0];
  assert.equal(item.name, '直管件'); assert.equal(item.specification, '直管 φ50');
  assert.equal(item.stockQty, 100); assert.equal(item.safetyStock, 5); assert.equal(item.location, 'A-1');
  assert.equal(business.getInventoryLedger().length, ledgerBefore);
});

test('金额按分四舍五入，半分进位', () => {
  business.createPriceSheet({ itemId, unitPrice: 0.73, effectiveDate: '2000-01-01' });
  order({ quantity: 0.5 });
  order({ quantity: 3, unitPrice: 1.005, deliveryNo: 'S-2' });
  const amounts = business.getBills().map(b => b.amount).sort();
  assert.deepEqual(amounts, [0.37, 3.02]);
});

test('没有有效价格时拒绝开单，不再静默生成 0 元已结算账单；显式 0 价仍允许', () => {
  assert.throws(() => order(), /没有有效单价/);
  assert.equal(business.getBills().length, 0);
  order({ unitPrice: 0 });
  assert.equal(business.getBills()[0].amount, 0);
});

test('录单必须对应已有客户档案，不会把名称自动建成新客户', () => {
  business.createPriceSheet({ itemId, unitPrice: 5, effectiveDate: '2000-01-01' });
  assert.throws(() => order({ customerId: undefined, partner: '宏发' }), /未找到客户档案“宏发”/);
  assert.throws(() => order({ customerId: undefined, partner: '' }), /客户不能为空|请选择客户档案/);
  assert.equal(business.getCustomers().length, 1);
});

test('客户改名后改单不带客户编号，仍归属原客户，不分裂出新客户', () => {
  business.createPriceSheet({ itemId, unitPrice: 5, effectiveDate: '2000-01-01' });
  const created = order({ quantity: 2 });
  business.updateCustomer({ id: customerId, name: '盛发五金' });
  const record = business.getStockOrders().find(o => o.id === created.id);
  business.updateStockOrder({ ...record, customerId: undefined, partner: '盛发', quantity: 3 });
  const after = business.getStockOrders().find(o => o.id === created.id);
  assert.equal(after.customerId, customerId); assert.equal(business.getCustomers().length, 1);
  assert.equal(business.getBills()[0].customerId ?? customerId, customerId);
  assert.equal(business.generateDocument({ kind: 'statement', customerId, startDate: '2020-06-01', endDate: '2020-06-30' }).totals.amount, 15);
});

test('入库与出库不能互改类型；价目不能改挂到别的物料', () => {
  const receipt = business.createStockOrder({ type: '入库', itemId, customerId, partner: '盛发', quantity: 5, deliveryNo: 'R-1', processNo: 'P-1', operator: '测试员', orderDate: '2020-06-10' });
  const record = business.getStockOrders().find(o => o.id === receipt.id);
  assert.throws(() => business.updateStockOrder({ ...record, type: '出库', businessType: '成品出货' }), /入库与出库不能互相修改/);
  const other = business.createInventoryItem({ code: 'FIX-02', name: '面板', specification: '面板', unit: '件' }).itemId;
  const sheet = business.createPriceSheet({ itemId, unitPrice: 5, effectiveDate: '2000-01-01' });
  assert.throws(() => business.updatePriceSheet({ id: sheet.id, itemId: other, unitPrice: 9, effectiveDate: '2000-01-01' }), /不能改到其他物料/);
});

test('入库加工单号只跟加工单号自己的编码规则', () => {
  business.updateNumberingSettings({ deliveryNoMode: 'auto', processNoMode: 'manual' });
  const created = business.createStockOrder({ type: '入库', itemId, customerId, partner: '盛发', quantity: 5, processNo: '客户原单-001', operator: '测试员', orderDate: '2020-06-10' });
  const record = business.getStockOrders().find(o => o.id === created.id);
  assert.equal(record.processNo, '客户原单-001'); assert.match(record.deliveryNo, /^INB-/);
  const blank = business.createStockOrder({ type: '入库', itemId, customerId, partner: '盛发', quantity: 1, operator: '测试员', orderDate: '2020-06-10' });
  assert.equal(business.getStockOrders().find(o => o.id === blank.id).processNo, '');
});

test('作废后的收款不能用同一请求标识“重放成功”；字符串布尔值按字面解析', () => {
  business.createPriceSheet({ itemId, unitPrice: 5, effectiveDate: '2000-01-01' });
  order({ quantity: 2 });
  const bill = business.getBills()[0];
  const payload = { billId: bill.id, amount: 4, receiptDate: '2020-06-11', method: '现金', requestKey: 'k-1' };
  const receipt = business.createReceipt(payload);
  business.voidReceipt(receipt.id, { reason: '录错' });
  assert.throws(() => business.createReceipt(payload), /已作废/);
  business.updateCustomer({ id: customerId, isActive: 'false' });
  assert.equal(business.getCustomers()[0].isActive, 0);
});

test('月度出货金额与应收口径一致，不含已作废账单', () => {
  business.createPriceSheet({ itemId, unitPrice: 0.1, effectiveDate: '2000-01-01' });
  order(); order({ quantity: 2, deliveryNo: 'S-2' });
  const toVoid = business.getBills().find(b => b.amount === 0.2);
  business.deleteBill(toVoid.id, { reason: '测试作废' });
  const month = business.getDashboardData().monthlyTrend.find(m => m.month === '2020-06');
  assert.equal(month.outboundAmount, 0.1);
});

function rawRequest(port, lines) {
  return new Promise((resolve) => {
    let data = '';
    const socket = net.createConnection(port, '127.0.0.1', () => socket.end(lines.join('\r\n') + '\r\n\r\n'));
    socket.on('data', (chunk) => { data += chunk; });
    socket.on('close', () => resolve(data));
    socket.on('error', () => resolve(data));
  });
}

test('HTTP：畸形请求不打挂服务；状态码、会话、管理员与路径保护', { timeout: 30000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-fixes-http-'));
  const child = spawn(process.execPath, ['server/index.js'], { cwd: path.resolve('.'), env: { ...process.env,
    FACTORY_STORAGE_ROOT: dir, FACTORY_SHARED_HOST: '127.0.0.1', FACTORY_SHARED_PORT: '0',
    FACTORY_ADMIN_USERNAME: 'boss', FACTORY_ADMIN_PASSWORD: 'Boss-only-2026' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = '';
  child.stderr.on('data', c => { logs += c; });
  try {
    const origin = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`服务未启动：${logs}`)), 8000);
      child.once('exit', code => { clearTimeout(timer); reject(new Error(`服务退出 ${code}：${logs}`)); });
      child.stdout.on('data', chunk => { logs += chunk; const m = logs.match(/running at (http:\/\/127\.0\.0\.1:(\d+))/); if (m) { clearTimeout(timer); resolve({ url: m[1], port: Number(m[2]) }); } });
    });
    const base = `${origin.url}/api`;
    async function call(route, method = 'GET', body, auth, headers = {}) {
      const response = await fetch(`${base}${route}`, { method, headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${auth}` } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: response.status, json: await response.json() };
    }
    // 1. malformed headers / paths used to crash the process
    await new Promise((resolve) => http.get({ host: '127.0.0.1', port: origin.port, path: '/api/health', headers: { 'X-Forwarded-Host': 'a b', Host: '[x' } }, (r) => { r.resume(); r.on('end', resolve); }).on('error', resolve));
    await rawRequest(origin.port, ['GET //[x HTTP/1.1', 'Host: 127.0.0.1']);
    const health = await call('/health');
    assert.equal(health.status, 200); assert.equal(child.exitCode, null);
    assert.equal(health.json.databasePath, undefined);
    // 2. status codes
    assert.equal((await call('/auth/login', 'POST', { username: 'boss', password: 'wrong' })).status, 401);
    const admin = (await call('/auth/login', 'POST', { username: 'boss', password: 'Boss-only-2026' })).json.data.token;
    assert.equal((await call('/customers', 'POST', { name: '甲' }, admin)).status, 200);
    const duplicate = await call('/customers', 'POST', { name: '甲' }, admin);
    assert.equal(duplicate.status, 400); assert.equal(duplicate.json.message, '客户名称已存在');
    assert.equal((await call('/users', 'POST', { username: 'op', displayName: '仓管', password: 'secret1', role: 'operator' }, admin)).status, 200);
    const op = (await call('/auth/login', 'POST', { username: 'op', password: ' secret1 ' })).json.data.token;
    assert.equal((await call('/users', 'GET', undefined, op)).status, 403);
    const bootstrap = (await call('/bootstrap', 'GET', undefined, op)).json;
    assert.equal(bootstrap.databasePath, ''); assert.deepEqual(bootstrap.storage, {});
    const internal = await call('/auth/login', 'POST', null);
    assert.ok([400, 500].includes(internal.status)); assert.doesNotMatch(internal.json.message, /Cannot read|properties/);
    // 3. password reset signs the user out; admin keeps own session
    assert.equal((await call('/users/2/password', 'PUT', { password: 'newpass1' }, admin)).status, 200);
    assert.equal((await call('/auth/me', 'GET', undefined, op)).status, 401);
    assert.equal((await call('/auth/me', 'GET', undefined, admin)).status, 200);
    // 4. cannot disable yourself / the last admin
    const self = await call('/users/1/status', 'PUT', { isActive: false }, admin);
    assert.equal(self.status, 400); assert.match(self.json.message, /不能停用当前登录/);
    assert.equal((await call('/users/2/status', 'PUT', { isActive: 'false' }, admin)).status, 200);
    const disabled = await call('/auth/login', 'POST', { username: 'op', password: 'newpass1' });
    assert.equal(disabled.status, 403); assert.match(disabled.json.message, /已停用/);
    // 5. login throttling
    for (let i = 0; i < 5; i++) assert.equal((await call('/auth/login', 'POST', { username: 'boss', password: `bad-${i}` })).status, 401);
    const throttled = await call('/auth/login', 'POST', { username: 'boss', password: 'Boss-only-2026' });
    assert.equal(throttled.status, 429); assert.match(throttled.json.message, /分钟后再试/);
    assert.equal(child.exitCode, null);
  } finally {
    child.kill('SIGTERM');
    await new Promise(resolve => { if (child.exitCode !== null || child.signalCode) resolve(); else child.once('exit', resolve); });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
