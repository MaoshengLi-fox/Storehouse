// Deployment safety defaults (2026-10-05).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

function startServer(env) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-deploy-'));
  const child = spawn(process.execPath, ['server/index.js'], { cwd: path.resolve('.'), env: { ...process.env,
    NODE_ENV: '', FACTORY_SHARED_HOST: '', FACTORY_ADMIN_PASSWORD: '', FACTORY_STORAGE_ROOT: root, FACTORY_SHARED_PORT: '0', ...env },
    stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = '';
  child.stdout.on('data', (c) => { logs += c; });
  child.stderr.on('data', (c) => { logs += c; });
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`服务未启动：${logs}`)), 8000);
    child.once('exit', (code) => { clearTimeout(timer); resolve({ exited: code, logs }); });
    child.stdout.on('data', () => { const m = logs.match(/running at (http:\/\/[\d.]+:\d+)/); if (m) { clearTimeout(timer); resolve({ url: m[1], logs }); } });
  });
  const stop = async () => {
    if (child.exitCode === null && !child.signalCode) { child.kill('SIGTERM'); await new Promise((r) => child.once('exit', r)); }
    fs.rmSync(root, { recursive: true, force: true });
  };
  return { ready, stop, getLogs: () => logs };
}

test('生产环境未设置强管理员密码时拒绝首次启动', { timeout: 15000 }, async () => {
  for (const password of ['', 'admin123!', 'REPLACE_WITH_A_UNIQUE_PASSWORD', 'short']) {
    const server = startServer({ NODE_ENV: 'production', FACTORY_ADMIN_PASSWORD: password });
    const result = await server.ready;
    await server.stop();
    assert.notEqual(result.exited, undefined, `password "${password}" should be refused`);
    assert.match(result.logs, /生产环境首次启动必须设置 FACTORY_ADMIN_PASSWORD/);
  }
});

test('默认只监听本机、不发跨域头；默认密码会提醒管理员，重置后消失', { timeout: 20000 }, async () => {
  const server = startServer({});
  try {
    const { url, logs } = await server.ready;
    assert.ok(url, logs);
    assert.match(url, /^http:\/\/127\.0\.0\.1:/);
    assert.match(server.getLogs(), /default password admin123!/);
    const health = await fetch(`${url}/api/health`);
    assert.equal(health.headers.get('access-control-allow-origin'), null);
    assert.equal(health.headers.get('cache-control'), 'no-store');
    const login = await (await fetch(`${url}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'admin123!' }) })).json();
    const auth = { Authorization: `Bearer ${login.data.token}`, 'Content-Type': 'application/json' };
    const before = await (await fetch(`${url}/api/bootstrap`, { headers: auth })).json();
    assert.equal(before.securityWarnings.length, 1);
    await fetch(`${url}/api/users/1/password`, { method: 'PUT', headers: auth, body: JSON.stringify({ password: 'A-much-stronger-2026' }) });
    const after = await (await fetch(`${url}/api/bootstrap`, { headers: auth })).json();
    assert.deepEqual(after.securityWarnings, []);
  } finally {
    await server.stop();
  }
});

test('FACTORY_TRUSTED_PROXIES 写错时拒绝启动，写对时正常启动', { timeout: 15000 }, async () => {
  const bad = startServer({ FACTORY_TRUSTED_PROXIES: '172.31.240.10,not-an-ip' });
  const badResult = await bad.ready; await bad.stop();
  assert.notEqual(badResult.exited, undefined); assert.match(badResult.logs, /FACTORY_TRUSTED_PROXIES 中的地址无效：not-an-ip/);
  const good = startServer({ FACTORY_TRUSTED_PROXIES: '172.31.240.10, 10.1.0.0/16' });
  const goodResult = await good.ready; await good.stop();
  assert.ok(goodResult.url, goodResult.logs);
});
