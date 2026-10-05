// User management: edit account details and delete accounts (2026-10-06).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, test } from 'node:test';
import * as auth from '../server/auth.js';

let admin, root = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-users-')), round = 0;
const userByName = (name) => auth.listUsers(admin).find((u) => u.username === name);

beforeEach(async () => {
  process.env.FACTORY_ADMIN_PASSWORD = 'Admin-only-2026!';
  auth.initializeAuthDatabase(path.join(root, String(++round)));
  admin = (await auth.loginByPassword('admin', 'Admin-only-2026!')).user;
  auth.createUser(admin, { username: 'clerk', displayName: '仓管小王', password: 'secret1', role: 'operator' });
});

test('管理员可修改用户名、显示名称和角色；改名后用新用户名登录，旧会话不受影响', async () => {
  const clerk = userByName('clerk');
  const session = await auth.loginByPassword('clerk', 'secret1');
  auth.updateUser(admin, clerk.id, { username: 'wang', displayName: '王师傅', role: 'admin' });
  const updated = auth.listUsers(admin).find((u) => u.id === clerk.id);
  assert.deepEqual([updated.username, updated.displayName, updated.role], ['wang', '王师傅', 'admin']);
  assert.equal(auth.getSessionFromToken(session.token).user.role, 'admin');      // role applies at once
  await assert.rejects(auth.loginByPassword('clerk', 'secret1'), /账号或密码错误/);
  assert.ok((await auth.loginByPassword('wang', 'secret1')).token);
});

test('编辑校验：重名、空值、含空格、无效角色都被拒绝；普通用户无权编辑', () => {
  const clerk = userByName('clerk');
  assert.throws(() => auth.updateUser(admin, clerk.id, { username: 'admin' }), /用户名已存在/);
  assert.throws(() => auth.updateUser(admin, clerk.id, { username: '  ' }), /用户名不能为空/);
  assert.throws(() => auth.updateUser(admin, clerk.id, { username: 'a b' }), /不能包含空格/);
  assert.throws(() => auth.updateUser(admin, clerk.id, { displayName: '' }), /显示名称不能为空/);
  assert.throws(() => auth.updateUser(admin, clerk.id, { role: 'root' }), /角色无效/);
  assert.throws(() => auth.updateUser(admin, 9999, { displayName: 'x' }), /用户不存在/);
  assert.throws(() => auth.updateUser({ ...clerk, role: 'operator' }, clerk.id, { displayName: 'x' }), /仅管理员/);
  auth.updateUser(admin, admin.id, { displayName: '老板' });                       // admins may rename themselves
  assert.equal(userByName('admin').displayName, '老板');
});

test('不能取消自己的管理员角色，也不能让系统失去最后一个启用的管理员', () => {
  assert.throws(() => auth.updateUser(admin, admin.id, { role: 'operator' }), /自己的管理员角色/);
  auth.createUser(admin, { username: 'boss2', displayName: '副总', password: 'secret2', role: 'admin' });
  const boss2 = userByName('boss2');
  auth.updateUser(admin, boss2.id, { role: 'operator' });                          // another admin remains
  assert.equal(userByName('boss2').role, 'operator');
});

test('删除用户：立即下线且不能再登录；不能删除自己或最后一个管理员', async () => {
  const clerk = userByName('clerk');
  const session = await auth.loginByPassword('clerk', 'secret1');
  auth.deleteUser(admin, clerk.id);
  assert.equal(userByName('clerk'), undefined);
  assert.equal(auth.getSessionFromToken(session.token), null);
  await assert.rejects(auth.loginByPassword('clerk', 'secret1'), /账号或密码错误/);
  assert.throws(() => auth.deleteUser(admin, admin.id), /不能删除当前登录的账号/);
  assert.throws(() => auth.deleteUser(admin, clerk.id), /用户不存在/);

  auth.createUser(admin, { username: 'boss2', displayName: '副总', password: 'secret2', role: 'admin' });
  const boss2 = (await auth.loginByPassword('boss2', 'secret2')).user;
  auth.setUserActiveStatus(boss2, admin.id, false);                                 // only boss2 is an active admin now
  assert.throws(() => auth.deleteUser({ ...admin, id: -1, role: 'admin' }, boss2.id), /至少需要保留一个启用中的管理员/);
  auth.deleteUser(boss2, admin.id);                                                 // a disabled admin can be removed
  assert.equal(userByName('admin'), undefined);
  auth.createUser(boss2, { username: 'clerk2', displayName: '新仓管', password: 'secret3' });
  assert.ok(auth.listUsers(boss2).some((u) => u.username === 'clerk2'));
});

test('改名或删除初始管理员后重启服务，不会用初始密码重新建出 admin 账号', async () => {
  const dir = path.join(root, 'restart');
  auth.initializeAuthDatabase(dir);
  const first = (await auth.loginByPassword('admin', 'Admin-only-2026!')).user;
  auth.updateUser(first, first.id, { username: 'owner' });
  auth.initializeAuthDatabase(dir);                                                 // simulated restart
  const names = auth.listUsers({ ...first, role: 'admin' }).map((u) => u.username);
  assert.deepEqual(names, ['owner']);
  await assert.rejects(auth.loginByPassword('admin', 'Admin-only-2026!'), /账号或密码错误/);
});
