import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

test('HTTP 全流程：权限、档案、价目、库存、收款及备份恢复', { timeout: 20000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-http-'));
  const child = spawn(process.execPath, ['server/index.js'], { cwd: path.resolve('.'), env: { ...process.env,
    FACTORY_STORAGE_ROOT: root, FACTORY_SHARED_HOST: '127.0.0.1', FACTORY_SHARED_PORT: '0',
    FACTORY_ADMIN_USERNAME: 'test-admin', FACTORY_ADMIN_PASSWORD: 'Test-only-password-2026', FACTORY_ADMIN_DISPLAY_NAME: '测试管理员' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = '';
  child.stderr.on('data', c => { logs += c; });
  try {
    const base = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`服务未启动：${logs}`)), 8000);
      child.once('exit', code => { clearTimeout(timer); reject(new Error(`服务退出 ${code}：${logs}`)); });
      child.stdout.on('data', chunk => { logs += chunk; const match = logs.match(/Factory server running at (http:\/\/127\.0\.0\.1:\d+)/); if (match) { clearTimeout(timer); resolve(`${match[1]}/api`); } });
    });
    let token = '';
    async function call(route, method = 'GET', body, expected = 200, auth = token) {
      const response = await fetch(`${base}${route}`, { method, headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${auth}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
      const json = await response.json(); assert.equal(response.status, expected, `${route}: ${JSON.stringify(json)}`); return json.data ?? json;
    }
    await call('/admin/backups', 'GET', undefined, 401);
    await call('/documents/preview', 'POST', {}, 401);
    const login = await call('/auth/login', 'POST', { username: 'test-admin', password: 'Test-only-password-2026' }); token = login.token;
    await call('/users', 'POST', { username: 'worker', displayName: '仓管', password: 'Worker-only-2026!', role: 'operator' });
    const worker = await call('/auth/login', 'POST', { username: 'worker', password: 'Worker-only-2026!' });
    await call('/admin/backups', 'GET', undefined, 403, worker.token);
    await call('/admin/backups/upload', 'POST', {}, 403, worker.token);
    await call('/admin/print-settings', 'PUT', { companyName: '越权' }, 403, worker.token);
    await call('/admin/bills/1/clear-legacy', 'POST', { reason: 'test' }, 403, worker.token);
    const customer = await call('/customers', 'POST', { name: '接口客户', contact: '李小姐', settlementDays: 15 });
    const material = await call('/material-prices/save', 'POST', { code: 'HTTP-MAT', specification: '接口物料', unit: '件', unitPrice: 5, effectiveDate: '2000-01-01', vendor: '接口客户' });
    await call(`/inventory/${material.itemId}`, 'PUT', { stockQty: 999, safetyStock: 5, location: 'B-1' });
    assert.equal((await call('/inventory'))[0].stockQty, 0); // stock cannot be overwritten through item edits
    await call('/inventory-adjustments', 'POST', { itemId: material.itemId, expectedStockQty: 0, actualQty: 20, reason: '期初盘点' });
    const order = await call('/stock-orders', 'POST', { type: '出库', itemId: material.itemId, quantity: 2, partner: '接口客户', customerId: customer.id,
      operator: '测试管理员', orderDate: '2020-01-01', deliveryNo: 'HTTP-001', processNo: 'PROCESS-001' });
    let bill = (await call('/bills'))[0]; assert.equal(bill.amount, 10); assert.equal(bill.dueDate, '2020-01-16');
    const documentQuery = { kind: 'statement', customerId: customer.id, startDate: '2020-01-01', endDate: '2020-01-31' };
    const document = await call('/documents/preview', 'POST', documentQuery, 200, worker.token);
    assert.equal(document.totals.amount, 10); assert.equal(document.preparedBy, '仓管');
    const excel = await fetch(`${base}/documents/export`, { method: 'POST', headers: { Authorization: `Bearer ${worker.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(documentQuery) });
    assert.equal(excel.status, 200); assert.match(excel.headers.get('Content-Type'), /spreadsheetml/);
    assert.equal(Buffer.from(await excel.arrayBuffer()).subarray(0, 2).toString(), 'PK');
    const receipt = await call('/receipts', 'POST', { billId: bill.id, amount: 4, receiptDate: '2020-01-02', method: '银行转账', requestKey: 'http-once', actor: '伪造名字' });
    assert.equal((await call('/receipts'))[0].operator, '测试管理员');
    assert.equal((await call('/bills'))[0].balanceAmount, 6);
    assert.equal((await call('/customers'))[0].balanceAmount, 6);
    assert.equal((await call('/inventory-ledger'))[0].quantityDelta, -2);
    assert.ok((await call(`/bills/${bill.id}/events`)).some(e => e.action === '登记收款'));
    await call('/admin/backups/settings', 'PUT', { enabled: false, intervalHours: 24, retention: 14 });
    // Startup backup may still be finishing; wait within the test's bounded deadline.
    for (let i = 0; i < 50 && (await call('/admin/backups')).busy; i++) await new Promise(r => setTimeout(r, 20));
    const backup = await call('/admin/backups', 'POST');
    const download = await fetch(`${base}/admin/backups/${backup.id}/download`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(download.status, 200); const data = Buffer.from(await download.arrayBuffer());
    assert.equal(data.subarray(0, 16).toString(), 'SQLite format 3\0');
    const uploadResponse = await fetch(`${base}/admin/backups/upload`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/octet-stream' }, body: data });
    assert.equal(uploadResponse.status, 200); const upload = (await uploadResponse.json()).data;
    await call(`/receipts/${receipt.id}/void`, 'POST', { reason: '测试回退' });
    await call(`/bills/${bill.id}`, 'DELETE', { reason: '测试作废' });
    assert.equal((await call('/bills/summary')).receivable, 0);
    await call(`/bills/${bill.id}/restore`, 'POST');
    await call(`/admin/backups/${upload.id}/restore`, 'POST', { confirmation: '恢复业务数据' });
    bill = (await call('/bills'))[0]; assert.equal(bill.balanceAmount, 6); assert.equal(bill.status, '部分收款');
    assert.equal((await call('/inventory'))[0].stockQty, 18);
    assert.equal((await call('/auth/me')).user.username, 'test-admin');
    assert.ok((await call('/admin/backups')).backups.some(b => b.kind === 'before-restore'));
    assert.equal((await call('/stock-orders'))[0].id, order.id);
  } finally {
    child.kill('SIGTERM');
    await new Promise(resolve => { if (child.exitCode !== null || child.signalCode) resolve(); else child.once('exit', resolve); });
    fs.rmSync(root, { recursive: true, force: true });
  }
});
