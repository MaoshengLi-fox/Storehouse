# Factory Desk V2

工厂出入库与对账管理系统。当前运行形态为 Web 应用：浏览器访问 Vue 页面，Node.js 提供接口和静态资源，SQLite 在服务端保存共享数据。

## 文档导航

| 文档 | 内容 |
| --- | --- |
| [项目总览](docs/PROJECT_OVERVIEW.md) | 目录职责、业务流程、数据表、接口和配置 |
| [业务操作说明](docs/BUSINESS_WORKFLOWS.md) | 账单、价格、库存、客户、收款与备份使用规则 |
| [现状与待办](docs/PROJECT_STATUS.md) | 本次核验结果、已确认问题、后续整理顺序 |
| [登录与存储](docs/LOGIN_AND_STORAGE.md) | 账号初始化、多设备会话、数据位置 |
| [服务器部署](DEPLOY_SERVER.md) | Docker Compose 部署（Nginx + 应用）、HTTPS、备份、更新与回滚 |
| [V2 重构背景](docs/REBUILD_V2.md) | 从桌面版迁移到 Web 版的设计背景 |

## 功能入口

| 模块 | 当前能力 |
| --- | --- |
| 登录 | 账号密码登录、退出、多设备会话 |
| 经营总览 | 今日出入库、本月应收、库存预警、最近单据 |
| 辅助价目 | 物料建档、规格与镀种、厂商、按日期生效的单价历史、Excel 导出 |
| 入库明细 | 正常入库、退胚回库（均为收货）、不良退回（客户退货）；不计金额；新增、修改、撤销、打印、Excel 导出 |
| 出货明细 | 成品出货、退胚、返工出货三种类型；退胚/返工出货须选原批次并校验可用数量、免费不开账；成品出货自动生成账单；勾选明细打印、Excel 导出 |
| 对账明细 | 开单价快照、作废/恢复、自动结清、未收余额、客户/逾期筛选、Excel 导出 |
| 对账与打印 | 按客户和日期生成客户对账单、出货单、退胚单；勾选明细、纸张规格（连续纸/A4/A5/自定义）、打印预览、按原表版式导出 Excel；管理员维护公司抬头 |
| 库存台账 | 库存余额、流转记录、安全库存/库位、盘点调整、Excel 导出 |
| 客户档案 | 联系资料、结算账期、启停、欠款汇总 |
| 收款登记 | 部分收款、自动结清、凭证、作废冲回、Excel 导出 |
| 备份与恢复 | 管理员手动/自动业务备份、下载/上传、校验与保护恢复 |
| 经营分析 | 月度成品出货金额，以及按六个业务类型标签分别统计的月度数量 |
| 用户管理 | 管理员创建账号、重置密码、启停账号、配置编码规则、清空业务数据 |

建议按“客户/物料建档 → 收货 → 退胚 → 出货 → 退货/返工出货 → 对账 → 收款”的顺序了解业务，批次规则见[业务操作说明](docs/BUSINESS_WORKFLOWS.md#业务类型与批次)。历史账单保存开单价格，后续调整价目不会改变旧账单。修复与验证记录见[现状与待办](docs/PROJECT_STATUS.md)。

## 本地运行

在项目根目录执行：

```bash
npm ci
npm run build
FACTORY_SHARED_HOST=127.0.0.1 npm run server
```

访问 [本地系统](http://127.0.0.1:8787)，健康检查为 [本地健康接口](http://127.0.0.1:8787/api/health)。

全新认证库且未配置初始化环境变量时，代码默认账号为 `admin`，密码为 `admin123!`。已有认证库沿用原账号；修改初始化环境变量不会更新已有账号密码，详见[登录与存储](docs/LOGIN_AND_STORAGE.md)。

## 本地开发

```bash
FACTORY_SHARED_HOST=127.0.0.1 npm run dev:full
```

前端开发地址为 [Vite 开发页面](http://127.0.0.1:5173)，Vite 将 `/api` 代理到 `127.0.0.1:8787`。连接其他 API 地址时，可在启动前设置 `VITE_FACTORY_API_BASE_URL`。

| 命令 | 作用 |
| --- | --- |
| `npm start` / `npm run server` | 启动 Node.js 服务，提供 API 和已构建的 `dist/` |
| `npm run dev` | 只启动 Vite 前端开发服务 |
| `npm run dev:full` | 同时启动 API 和 Vite，API 地址按上面的示例配置 |
| `npm run build` | 构建前端到 `dist/`，需要安装开发依赖 |
| `npm test` | 执行业务回归和 HTTP 集成测试；使用独立临时库与本机随机端口 |
| `npm run preview` | 预览前端构建产物，不启动 API |
| `npm run package:server` | 归档项目到 `release/factory-desk-v2.tar.gz`，不会自动构建 |

## 项目布局

- `src/`：当前 Web 前端，Vue 3 + Vue Router + Element Plus；`xlsx` 用于浏览器导出。
- `server/`：Node.js HTTP 服务、认证、SQLite 业务逻辑与存储布局；`server/templates/` 为单据 Excel 样式模板。
- `shared/`：前后端共用的业务类型与批次规则、单据类型、纸张规格和分单规则。
- `Dockerfile`、`docker-compose.yml`、`deploy/`：Docker 部署与 Nginx 配置；`ecosystem.config.cjs` 为不用 Docker 时的 PM2 配置。
- `docs/`：项目说明与整理记录。
- `electron/`：旧桌面版代码，当前 npm 脚本未接入。
- `.factory-server-data/`：默认运行数据目录；`dist/`、`release/`、`node_modules/` 为构建、发布和依赖产物。

系统默认业务时区为 `Asia/Shanghai`，可用 `FACTORY_BUSINESS_TIMEZONE` 修改。备份页面只管理业务库，账号库独立保存。

完整目录说明及环境变量见[项目总览](docs/PROJECT_OVERVIEW.md)。Node.js 服务直接读取进程环境变量；生产环境的敏感配置写在服务器 `/opt/factory-desk/factory.env`（模板 `deploy/factory.env.example`），由 docker compose（或 PM2）读取，见[服务器部署](DEPLOY_SERVER.md)。
