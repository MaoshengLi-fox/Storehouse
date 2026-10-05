# 登录与存储说明（Factory Desk Web）

相关文档：[项目总览](PROJECT_OVERVIEW.md)、[现状与待办](PROJECT_STATUS.md)、[本地启动](../README.md)。

## 1. 登录报错说明
如果出现：

`Failed to construct 'URL': Invalid base URL`

根因通常是前端拿到的是相对 API 地址（如 `/api`），但代码按绝对 base 处理。

本项目已修复为自动兼容：
- `VITE_FACTORY_API_BASE_URL` 为空：默认使用 `当前域名 + /api`
- `VITE_FACTORY_API_BASE_URL=/api`：自动转为 `http(s)://当前域名/api`
- `VITE_FACTORY_API_BASE_URL=http://x.x.x.x:8787/api`：直接使用

## 2. 多设备是否同一个账号
当前默认策略：可以同一个账号在多设备登录。

- 系统使用 `token session` 模式
- 同一账号可生成多个并行会话（PC、手机、平板都可同时在线）
- 退出登录只会注销当前 token，不会踢掉其他设备会话

如果你需要“一个账号只允许一个设备在线”，可以在服务端改成单会话策略（登录时先使旧会话失效）。

## 2.1 登录与账号安全（2026-09-30）

- 同一账号在同一 IP 连续输错密码 5 次，锁定 15 分钟；同一账号在所有 IP 合计输错 20 次也会锁定 15 分钟。锁定记录保存在服务内存中，重启服务后清零。
- 限流按客户端真实 IP 计算，依赖 Nginx 传入 `X-Real-IP`（见 `deploy/nginx-factory.conf`）。
- 管理员重置某个用户的密码或停用该账号时，该用户所有设备上的登录会立即失效；管理员自己当前的会话不受影响。
- 不能停用当前登录的管理员账号，也不能停用最后一个启用中的管理员。
- 已停用账号输入正确密码时提示“账号已停用，请联系管理员”。
- 密码首尾空格在创建、重置和登录时都会被去掉。

## 3. 账户来源

对应用户名尚不存在时，服务端自动创建默认管理员。未提供初始化环境变量时，代码默认值为：
- 用户名：`admin`
- 密码：`admin123!`

可通过环境变量覆盖：
- `FACTORY_ADMIN_USERNAME`
- `FACTORY_ADMIN_PASSWORD`
- `FACTORY_ADMIN_DISPLAY_NAME`

这些变量用于创建账号，不会覆盖已有账号的密码。已有账号需要在管理员的用户管理页重置密码。

服务端直接读取进程环境变量，不会自动加载 `.env.production`。PM2 部署时按[部署说明](../DEPLOY_SERVER.md)修改 `ecosystem.config.cjs` 的 `env` 字段。

## 4. 整体存储架构
由 `FACTORY_STORAGE_ROOT` 控制根目录，默认会创建：

- `business/`：业务数据库
  - 主要含：库存、入库单、出库单、物料单价、账单、客户、收款、台账和操作记录
- `auth/`：认证数据库
  - 用户表、会话表（token hash、过期时间等）
- `backups/`：在线业务备份及自动备份设置；不包含认证库
- `exports/`：导出目录（预留）

默认根目录为项目下 `.factory-server-data/`。认证库与业务库都使用 SQLite WAL；`.db-wal`、`.db-shm` 是运行数据的一部分。当前 Excel 导出由浏览器下载，不写入服务端 `exports/`。

## 5. 核心业务表语义
虽然底层为关系型结构，但业务语义保持：

1. 入库表：`stock_orders` 中 `type='入库'`
2. 出库表：`stock_orders` 中 `type='出库'`
3. 物料单价表：`price_sheets`
   - 包含物料编码、规格、镀种、单价、生效日期等

## 6. 前后端交互
前端统一走 HTTP API，携带 `Authorization: Bearer <token>`。

关键接口：
- 登录：`POST /api/auth/login`
- 当前用户：`GET /api/auth/me`
- 登出：`POST /api/auth/logout`
- 入库：`GET /api/inbound-orders`
- 出库：`GET /api/outbound-orders`
- 单价：`GET/POST /api/material-prices`、`PUT/DELETE /api/material-prices/:id`
- 账单：`GET/POST /api/bills`、`PUT/DELETE /api/bills/:id`
- 账单汇总：`GET /api/bills/summary`

用户、编号规则和其他接口见[完整接口索引](PROJECT_OVERVIEW.md)。

## 7. 部署后检查清单
1. `curl http://127.0.0.1:8787/api/health`（只返回运行状态，不再返回服务器路径）
2. 浏览器打开 `http://43.136.121.205`
3. 登录后打开开发者工具，确认请求地址是：`http://43.136.121.205/api/...`
4. 多设备测试：同一账号在两台设备分别登录并录入数据，页面刷新后应看到一致数据

## 8. 升级后生效步骤
每次修改前端后需要：

```bash
cd /opt/factory-desk/current
npm run build
pm2 restart factory-desk
```

如果只是文档改动则无需重启。

## 9. 业务备份

管理员进入“备份与恢复”管理手动/自动备份、下载、上传和恢复。默认每 24 小时备份业务库，保留 14 份自动备份；恢复前会保存保护副本。账号库独立保存，需要服务器迁移时另行备份。完整规则见[业务操作说明](BUSINESS_WORKFLOWS.md)。
