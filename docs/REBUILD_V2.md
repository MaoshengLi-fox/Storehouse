# Factory Desk V2 重构架构说明

本文保留 V2 重构时的目标和设计背景。当前功能、接口与目录以[项目总览](PROJECT_OVERVIEW.md)为准，已确认问题及后续工作见[现状与待办](PROJECT_STATUS.md)。

## 1. 重构目标
在保留关键业务表语义的前提下，重构为标准 Web 架构：
- 用户通过链接访问并登录系统
- 登录后处理入库、出库、物料单价与账单
- 前后端分离，服务端统一鉴权和存储
- 支持多设备并发访问

## 2. 关键业务表（保持核心语义）
核心仍围绕以下三类业务表：
1. 入库表（通过 `stock_orders` + `type='入库'` 语义承载）
2. 出库表（通过 `stock_orders` + `type='出库'` 语义承载）
3. 物料单价表（`price_sheets`，含物料编码、规格、镀种、单价）

注：当前系统在数据库层维持兼容结构，API 层新增了业务语义化路由。

## 3. 存储架构
服务端使用分层目录，默认在 `FACTORY_STORAGE_ROOT` 下：
- `business/`：业务库（库存、入库、出库、账单、单价）
- `auth/`：用户与会话
- `backups/`：备份文件
- `exports/`：导出文件

## 4. 前后端交互模型
鉴权后统一通过 Bearer Token 访问 API。

### 4.1 认证接口
- `POST /api/auth/login`
- `GET /api/auth/me`
- `POST /api/auth/logout`

### 4.2 业务接口（V2 语义）
- `GET /api/inbound-orders`
- `GET /api/outbound-orders`
- `GET/POST /api/stock-orders`、`GET/PUT/DELETE /api/stock-orders/:id`
- `GET/POST /api/material-prices`、`PUT/DELETE /api/material-prices/:id`
- `GET/POST /api/bills`、`PUT/DELETE /api/bills/:id`
- `GET /api/bills/summary`
- `GET/POST /api/inventory`、`PUT/DELETE /api/inventory/:id`

## 5. UI 设计策略
- 登录页与业务系统分离，先登录再进入工作台
- 顶栏统一显示当前连接服务器信息
- 保留工作台大表格交互（适合仓储/财务操作）
- 新增移动端断点，手机上支持基础浏览与录入

## 6. 部署方式
- Node.js 服务承载 API + 前端静态资源
- Nginx 反向代理对外暴露
- PM2 托管进程与开机自启
