# 43.136.121.205 逐步部署方案（V2）

本文保留项目现有目标地址与目录约定，未核验服务器当前部署状态。项目入口见 [README](README.md)，代码结构见[项目总览](docs/PROJECT_OVERVIEW.md)。

## 0. 目标
在服务器 `43.136.121.205` 部署 Factory Desk V2：
- 访问地址：`http://43.136.121.205`
- 登录后进入系统处理出入库、单价表、账单汇总

## 1. 服务器准备

服务器需要 Node.js、npm、PM2、Nginx。项目尚未固定 Node.js 版本；2026-09-21 本地构建及 SQLite 模块核验使用 Node.js `v24.12.0`，服务器安装后也需核验原生依赖。

```bash
# Ubuntu / Debian
apt update
apt install -y nginx curl tar
# 安装 Node.js 和 npm 后，检查版本并安装 PM2
node --version
npm --version
npm i -g pm2
```

## 2. 上传与解压项目
建议目录结构：
- 程序目录：`/opt/factory-desk/current`
- 数据目录：`/opt/factory-desk/data`

```bash
mkdir -p /opt/factory-desk/current /opt/factory-desk/data
cd /opt/factory-desk/current
# 将项目代码或打包文件上传到这里后解压
```

## 3. 安装依赖与构建

构建工具 Vite 位于开发依赖中，先安装完整依赖再构建。不要在构建前使用 `--omit=dev`。

```bash
cd /opt/factory-desk/current
npm ci --include=dev
npm run build
```

## 4. 配置运行环境

当前 PM2 配置从 `ecosystem.config.cjs` 的 `env` 字段读取运行环境。修改该文件，核对 `cwd`，至少设置以下字段：

```js
env: {
  NODE_ENV: 'production',
  FACTORY_SHARED_HOST: '0.0.0.0',
  FACTORY_SHARED_PORT: '8787',
  FACTORY_STORAGE_ROOT: '/opt/factory-desk/data',
  FACTORY_ADMIN_USERNAME: 'admin',
  FACTORY_ADMIN_PASSWORD: '替换为实际的独立密码'
}
```

`.env.production.example` 是变量参考模板。服务端没有 `.env` 加载逻辑，仅复制成 `.env.production` 不会让这些服务端变量生效。管理员初始化变量仅在对应用户名不存在时生效；已有账号改密请通过用户管理完成。

## 5. 使用 PM2 启动
```bash
cd /opt/factory-desk/current
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup
```

## 6. 配置 Nginx
```bash
cp /opt/factory-desk/current/deploy/nginx-factory.conf /etc/nginx/sites-available/factory-desk
ln -sf /etc/nginx/sites-available/factory-desk /etc/nginx/sites-enabled/factory-desk
nginx -t
systemctl restart nginx
```

## 7. 放行防火墙端口
```bash
ufw allow 80/tcp
ufw allow 22/tcp
ufw reload
```

## 8. 验证
```bash
curl http://127.0.0.1:8787/api/health
curl http://43.136.121.205/api/health
# 只返回 {"ok":true,"storageMode":"shared"}，不再暴露服务器路径
pm2 status
```

浏览器打开：
- `http://43.136.121.205`

首次登录：
- 用户名：`FACTORY_ADMIN_USERNAME`
- 密码：`FACTORY_ADMIN_PASSWORD`

## 9. 数据目录说明
`/opt/factory-desk/data` 下会自动创建：
- `business/`
- `auth/`
- `backups/`
- `exports/`

## 10. 更新发布流程

```bash
cd /opt/factory-desk/current
# 替换代码后
npm ci --include=dev
npm run build
pm2 restart ecosystem.config.cjs --update-env
```

发布时保留服务器上配置的实际运行参数。`npm run package:server` 只归档，不会先构建，也不会读取 `.gitignore`；当前脚本未排除私有 `.env` 文件，发布前需检查归档内容。

## 11. 清空业务数据（测试前重置为空）
当前版本默认不再写入示例数据，首次启动即为空库。

此步骤仅用于主动重置测试数据，不属于正常部署或更新流程。会先保存保护备份，再清空物料、出入库、价目、账单、客户、库存流水、收款及操作记录，保留账号与编号设置。

如需将现有业务数据清空：
```bash
curl -X POST http://127.0.0.1:8787/api/admin/reset-business-data \
  -H "Authorization: Bearer <管理员Token>" \
  -H "Content-Type: application/json"
```

获取 `<管理员Token>` 示例：
```bash
curl -s -X POST http://127.0.0.1:8787/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"你的管理员密码"}'
```

## 2026-09-30 更新须知

- `deploy/nginx-factory.conf` 增加了 `proxy_set_header X-Real-IP $remote_addr;`，登录失败限流按真实 IP 计算。已有站点需要把这一行加到 `/etc/nginx/sites-available/factory-desk` 后执行 `nginx -t && systemctl reload nginx`。
- 出入库必须对应已有客户档案，服务端不再按名称自动建客户；通过接口批量导入的脚本需先建好客户。
- 物料修改接口不再改库存，期初库存请用盘点（`POST /api/inventory-adjustments`）录入。

## 业务规则与备份升级

- 本版增加客户、库存流水、收款、账单作废字段。首次启动旧库前会用 SQLite 在线备份保存 `before-upgrade` 保护副本；备份失败时不会继续升级。
- `FACTORY_BUSINESS_TIMEZONE` 默认 `Asia/Shanghai`，按实际经营时区配置。价格生效和业务日期使用同一时区。
- 管理员可在“备份与恢复”设置自动备份（默认 24 小时、保留 14 份），以及手动备份、上传、下载和恢复。
- Web 备份只包含业务库。完整服务器迁移还需另行保存认证库 `auth/auth.db` 和运行配置。在线数据库请使用 SQLite 备份方式；整目录复制前停止服务，避免遗漏 WAL 中的数据。
- 恢复前自动保存保护副本，恢复期间暂停业务写入；完成后让所有客户端刷新。自动备份只在服务运行时执行。
- 随项目提供的 Nginx 配置已设置 `client_max_body_size 100m;`，与应用备份上传上限一致。更新已有站点时同步此设置并重新加载 Nginx。
- 验证命令：`npm test`（会启动本机随机端口的临时 HTTP 服务）及 `npm run build`。请先在独立测试库验证；本次开发没有操作远程服务器或工作区正式业务库。

更多规则见[业务操作说明](docs/BUSINESS_WORKFLOWS.md)。
