import fs from 'node:fs';
import { errorResponse } from './errors.js';
import http from 'node:http';
import path from 'node:path';
import {
  generateDocument, getPrintSettings, updatePrintSettings,
  getCustomers, createCustomer, updateCustomer, getInventoryLedger, adjustInventory,
  getReceipts, createReceipt, voidReceipt, restoreBill, clearLegacySettlement, getBillEvents,
  saveMaterialPrice,
  createBill,
  createInventoryItem,
  createPriceSheet,
  createStockOrder,
  deleteBill,
  deleteInventoryItem,
  deletePriceSheet,
  deleteStockOrder,
  getBills,
  getDashboardData,
  getDatabasePath,
  getInventoryItems,
  getNumberingSettings,
  getPriceSheets,
  resetBusinessData,
  getStockOrderDetail,
  getStockOrders,
  initializeDatabase,
  updateInventoryItem,
  updateNumberingSettings,
  updateBill,
  updatePriceSheet,
  updateStockOrder
} from './database.js';
import {
  createUser,
  getSessionFromToken,
  initializeAuthDatabase,
  listUsers,
  loginByPassword,
  securityWarningsFor,
  resetUserPassword,
  revokeSessionByToken,
  setUserActiveStatus,
  updateUser,
  deleteUser
} from './auth.js';
import { BUSINESS_TIMEZONE, businessToday } from './operations.js';
import { initializeStorageLayout } from './storage.js';
import { backupBeforeUpgrade, createBackupManager } from './backups.js';
import { exportDocumentWorkbook } from './documentExport.js';

// Listen on loopback by default: in production only Nginx on the same machine should reach Node.
const host = process.env.FACTORY_SHARED_HOST || '127.0.0.1';
// Cross-origin access is off unless an explicit origin is configured (same-origin through Nginx needs none).
const corsOrigin = String(process.env.FACTORY_CORS_ORIGIN || '').trim();
const corsHeaders = corsOrigin ? {
  'Access-Control-Allow-Origin': corsOrigin,
  'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  Vary: 'Origin'
} : {};
const port = Number(process.env.FACTORY_SHARED_PORT || 8787);
const storageRoot = process.env.FACTORY_STORAGE_ROOT || process.env.FACTORY_SHARED_DATA_DIR;
const apiBasePath = '/api';
const distDir = path.resolve(process.cwd(), 'dist');

const storage = initializeStorageLayout(storageRoot);
await backupBeforeUpgrade(storage);
initializeDatabase(storage.businessDir);
const backups = createBackupManager(storage);
const authDbPath = initializeAuthDatabase(storage.authDir);

const contentTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon'
};

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...corsHeaders
  });
  res.end(JSON.stringify(payload));
}

function sendError(res, statusCode, message) {
  sendJson(res, statusCode, { ok: false, message });
}

function normalizeQuery(searchParams) {
  const result = {};
  for (const [key, value] of searchParams.entries()) {
    if (value !== '') {
      result[key] = value;
    }
  }
  return result;
}

function parseNumericId(pathname) {
  return Number(pathname.split('/').pop());
}

async function readBuffer(req, limit = 2 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('上传内容超过大小限制');
    chunks.push(chunk);
  }
  if (backups.restoring) throw new Error('业务数据正在恢复，请稍后重试');
  return Buffer.concat(chunks);
}

async function readBody(req) {
  const buffer = await readBuffer(req);
  const chunks = buffer.length ? [buffer] : [];

  if (!chunks.length) {
    return {};
  }

  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) {
    return {};
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new Error('请求体 JSON 格式不正确');
  }
}

function getBearerToken(req) {
  const auth = String(req.headers.authorization || '');
  if (!auth.startsWith('Bearer ')) {
    return '';
  }
  return auth.slice(7).trim();
}

function getRequestOrigin(req) {
  const protocol = String(req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim();
  const hostHeader = String(req.headers['x-forwarded-host'] || req.headers.host || `127.0.0.1:${port}`).split(',')[0].trim();
  try {
    return new URL(`${protocol}://${hostHeader}`).origin; // reject malformed headers instead of crashing
  } catch {
    return `http://127.0.0.1:${port}`;
  }
}

// Reverse proxies whose X-Real-IP header is trusted: always loopback (Nginx on the same machine),
// plus FACTORY_TRUSTED_PROXIES — comma-separated IPv4 addresses or CIDR ranges, e.g. the fixed
// address of the Nginx container in docker-compose.yml. A client reaching Node from anywhere else
// cannot fake its address to dodge the login throttle.
function ipv4ToNumber(ip) {
  const parts = String(ip).split('.');
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part) || Number(part) > 255)) return null;
  return parts.reduce((total, part) => total * 256 + Number(part), 0);
}
const trustedProxies = String(process.env.FACTORY_TRUSTED_PROXIES || '').split(',').map((entry) => entry.trim()).filter(Boolean).map((entry) => {
  const [address, bits = '32'] = entry.split('/');
  const base = ipv4ToNumber(address), size = Number(bits);
  if (base === null || !Number.isInteger(size) || size < 0 || size > 32) throw new Error(`FACTORY_TRUSTED_PROXIES 中的地址无效：${entry}`);
  const span = 2 ** (32 - size);
  return { start: base - (base % span), span };
});
function isTrustedProxy(socketIp) {
  const ip = socketIp.startsWith('::ffff:') ? socketIp.slice(7) : socketIp;
  if (ip === '::1' || ip.startsWith('127.')) return true;
  const value = ipv4ToNumber(ip);
  return value !== null && trustedProxies.some(({ start, span }) => value >= start && value < start + span);
}
function getClientIp(req) {
  const socketIp = String(req.socket?.remoteAddress || '');
  if (isTrustedProxy(socketIp) && req.headers['x-real-ip']) return String(req.headers['x-real-ip']).trim();
  return socketIp;
}

function buildBootstrap(req, session) {
  const isAdmin = session?.user?.role === 'admin';
  return {
    ok: true,
    storageMode: 'shared',
    businessTimeZone: BUSINESS_TIMEZONE,
    businessDate: businessToday(),
    // Server file paths are only shown to administrators.
    databasePath: isAdmin ? getDatabasePath() : '',
    apiBaseUrl: `${getRequestOrigin(req)}${apiBasePath}`,
    storage: isAdmin ? {
      rootDir: storage.rootDir,
      businessDir: storage.businessDir,
      authDir: storage.authDir,
      backupsDir: storage.backupsDir,
      exportsDir: storage.exportsDir,
      authDbPath
    } : {},
    numberingSettings: getNumberingSettings(),
    securityWarnings: securityWarningsFor(session?.user),
    user: session?.user || null
  };
}

function authRequired(req, res) {
  const token = getBearerToken(req);
  const session = getSessionFromToken(token);
  if (!session) {
    sendError(res, 401, '未登录或登录已过期');
    return null;
  }
  return { token, session };
}

function sendStaticFile(res, filePath) {
  if (!fs.existsSync(filePath)) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
    return;
  }

  const ext = path.extname(filePath);
  const contentType = contentTypes[ext] || 'application/octet-stream';
  // Built assets carry a content hash in their name and never change; index.html must always be revalidated.
  const cacheControl = filePath.includes(`${path.sep}assets${path.sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache';
  res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': cacheControl, 'X-Content-Type-Options': 'nosniff' });
  fs.createReadStream(filePath).pipe(res);
}

function handleStaticSite(req, res, pathname) {
  if (!fs.existsSync(distDir)) {
    res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('前端构建产物不存在，请先执行 npm run build');
    return;
  }

  const safePath = pathname === '/' ? '/index.html' : pathname;
  const filePath = path.join(distDir, safePath);

  if (filePath.startsWith(distDir + path.sep) && fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    sendStaticFile(res, filePath);
    return;
  }

  sendStaticFile(res, path.join(distDir, 'index.html'));
}

const server = http.createServer(async (req, res) => {
  if (!req.url) {
    sendError(res, 400, '无效请求');
    return;
  }

  if (req.method === 'OPTIONS') {
    sendJson(res, 204, { ok: true });
    return;
  }

  try {
    // A fixed base keeps malformed Host / forwarded headers from breaking URL parsing.
    const url = new URL(req.url, 'http://localhost');
    const pathname = url.pathname;

    if (pathname === `${apiBasePath}/health` && req.method === 'GET') {
      sendJson(res, 200, { ok: true, storageMode: 'shared' });
      return;
    }

    if (pathname === `${apiBasePath}/auth/login` && req.method === 'POST') {
      const body = await readBody(req);
      const result = await loginByPassword(body.username, body.password, getClientIp(req));
      sendJson(res, 200, { ok: true, data: result });
      return;
    }

    if (pathname === `${apiBasePath}/auth/me` && req.method === 'GET') {
      const authed = authRequired(req, res);
      if (!authed) {
        return;
      }
      sendJson(res, 200, { ok: true, data: { user: authed.session.user, expiresAt: authed.session.expiresAt } });
      return;
    }

      if (pathname === `${apiBasePath}/auth/logout` && req.method === 'POST') {
        const token = getBearerToken(req);
        revokeSessionByToken(token);
        sendJson(res, 200, { ok: true });
        return;
      }

      if (pathname === `${apiBasePath}/users` && req.method === 'GET') {
        const authed = authRequired(req, res);
        if (!authed) {
          return;
        }
        sendJson(res, 200, { ok: true, data: listUsers(authed.session.user) });
        return;
      }

      if (pathname === `${apiBasePath}/users` && req.method === 'POST') {
        const authed = authRequired(req, res);
        if (!authed) {
          return;
        }
        const body = await readBody(req);
        sendJson(res, 200, { ok: true, data: createUser(authed.session.user, body) });
        return;
      }

      if (pathname.match(/^\/api\/users\/\d+\/password$/) && req.method === 'PUT') {
        const authed = authRequired(req, res);
        if (!authed) {
          return;
        }
        const userId = Number(pathname.split('/')[3]);
        const body = await readBody(req);
        sendJson(res, 200, { ok: true, data: resetUserPassword(authed.session.user, userId, body.password, authed.token) });
        return;
      }

      if (pathname.match(/^\/api\/users\/\d+$/) && (req.method === 'PUT' || req.method === 'DELETE')) {
        const authed = authRequired(req, res);
        if (!authed) {
          return;
        }
        const userId = Number(pathname.split('/')[3]);
        const data = req.method === 'PUT'
          ? updateUser(authed.session.user, userId, await readBody(req))
          : deleteUser(authed.session.user, userId);
        sendJson(res, 200, { ok: true, data });
        return;
      }

      if (pathname.match(/^\/api\/users\/\d+\/status$/) && req.method === 'PUT') {
        const authed = authRequired(req, res);
        if (!authed) {
          return;
        }
        const userId = Number(pathname.split('/')[3]);
        const body = await readBody(req);
        sendJson(res, 200, { ok: true, data: setUserActiveStatus(authed.session.user, userId, body.isActive) });
        return;
      }

    if (pathname.startsWith(apiBasePath)) {
      const authed = authRequired(req, res);
      if (!authed) {
        return;
      }

      if (pathname.startsWith('/api/admin/') && authed.session.user.role !== 'admin') {
        sendError(res, 403, '仅管理员可执行该操作');
        return;
      }
      if (backups.restoring && !['GET', 'HEAD'].includes(req.method)) {
        sendError(res, 503, '业务数据正在恢复，请稍后重试');
        return;
      }
      const actor = authed.session.user.displayName || authed.session.user.username;
      const bodyWithActor = async () => ({ ...await readBody(req), actor });
      const ok = (data) => sendJson(res, 200, { ok: true, data });

      if (pathname === '/api/print-settings' && req.method === 'GET') { ok(getPrintSettings()); return; }
      if (pathname === '/api/admin/print-settings' && req.method === 'PUT') { ok(updatePrintSettings(await readBody(req))); return; }
      if (pathname === '/api/documents/preview' && req.method === 'POST') { ok(generateDocument(await bodyWithActor())); return; }
      if (pathname === '/api/documents/export' && req.method === 'POST') {
        const body = await bodyWithActor(), document = generateDocument(body);
        const data = exportDocumentWorkbook(document, body.paper);
        const name = encodeURIComponent(`${document.customer.name}-${document.title}.xlsx`);
        res.writeHead(200, { 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Content-Disposition': `attachment; filename*=UTF-8''${name}`, 'Cache-Control': 'no-store', ...corsHeaders });
        res.end(data); return;
      }

      if (pathname === '/api/material-prices/save' && req.method === 'POST') { ok(saveMaterialPrice(await bodyWithActor())); return; }
      if (pathname === '/api/customers') {
        if (req.method === 'GET') { ok(getCustomers()); return; }
        if (req.method === 'POST') { ok(createCustomer(await bodyWithActor())); return; }
      }
      if (/^\/api\/customers\/\d+$/.test(pathname) && req.method === 'PUT') {
        ok(updateCustomer({ ...await bodyWithActor(), id: parseNumericId(pathname) })); return;
      }
      if (pathname === '/api/inventory-ledger' && req.method === 'GET') { ok(getInventoryLedger(normalizeQuery(url.searchParams))); return; }
      if (pathname === '/api/inventory-adjustments' && req.method === 'POST') { ok(adjustInventory(await bodyWithActor())); return; }
      if (pathname === '/api/receipts') {
        if (req.method === 'GET') { ok(getReceipts(normalizeQuery(url.searchParams))); return; }
        if (req.method === 'POST') { ok(createReceipt(await bodyWithActor())); return; }
      }
      if (/^\/api\/receipts\/\d+\/void$/.test(pathname) && req.method === 'POST') {
        ok(voidReceipt(Number(pathname.split('/')[3]), await bodyWithActor())); return;
      }
      if (/^\/api\/bills\/\d+\/events$/.test(pathname) && req.method === 'GET') {
        ok(getBillEvents(Number(pathname.split('/')[3]))); return;
      }
      if (/^\/api\/bills\/\d+\/restore$/.test(pathname) && req.method === 'POST') {
        ok(restoreBill(Number(pathname.split('/')[3]), await bodyWithActor())); return;
      }
      if (/^\/api\/admin\/bills\/\d+\/clear-legacy$/.test(pathname) && req.method === 'POST') {
        ok(clearLegacySettlement(Number(pathname.split('/')[4]), await bodyWithActor())); return;
      }
      if (pathname === '/api/admin/backups') {
        if (req.method === 'GET') { ok(backups.list()); return; }
        if (req.method === 'POST') { ok(await backups.create()); return; }
      }
      if (pathname === '/api/admin/backups/settings' && req.method === 'PUT') {
        ok(backups.updateSettings(await readBody(req))); return;
      }
      if (pathname === '/api/admin/backups/upload' && req.method === 'POST') {
        ok(backups.upload(await readBuffer(req, 100 * 1024 * 1024))); return;
      }
      const backupRoute = pathname.match(/^\/api\/admin\/backups\/([^/]+)\/(download|restore)$/);
      if (backupRoute) {
        const id = decodeURIComponent(backupRoute[1]);
        if (backupRoute[2] === 'download' && req.method === 'GET') {
          const file = backups.filePath(id);
          res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="${id}"`, 'Cache-Control': 'no-store', ...corsHeaders });
          const stream = fs.createReadStream(file);
          stream.on('error', () => res.destroy());
          stream.pipe(res); return;
        }
        if (backupRoute[2] === 'restore' && req.method === 'POST') {
          const body = await bodyWithActor();
          ok(await backups.restore(id, body.confirmation)); return;
        }
      }

      if (pathname === `${apiBasePath}/bootstrap` && req.method === 'GET') {
        sendJson(res, 200, buildBootstrap(req, authed.session));
        return;
      }

      if (pathname === `${apiBasePath}/dashboard` && req.method === 'GET') {
        sendJson(res, 200, { ok: true, data: getDashboardData() });
        return;
      }

      if (pathname === `${apiBasePath}/admin/reset-business-data` && req.method === 'POST') {
        if (authed.session?.user?.role !== 'admin') {
          sendError(res, 403, '仅管理员可执行该操作');
          return;
        }
        sendJson(res, 200, { ok: true, data: (await backups.create('before-restore'), resetBusinessData()) });
        return;
      }

      if (pathname === `${apiBasePath}/admin/numbering-settings` && req.method === 'GET') {
        if (authed.session?.user?.role !== 'admin') {
          sendError(res, 403, '仅管理员可执行该操作');
          return;
        }
        sendJson(res, 200, { ok: true, data: getNumberingSettings() });
        return;
      }

      if (pathname === `${apiBasePath}/admin/numbering-settings` && req.method === 'PUT') {
        if (authed.session?.user?.role !== 'admin') {
          sendError(res, 403, '仅管理员可执行该操作');
          return;
        }
        const body = await bodyWithActor();
        sendJson(res, 200, { ok: true, data: updateNumberingSettings(body || {}) });
        return;
      }

      if (pathname === `${apiBasePath}/inventory` && req.method === 'GET') {
        sendJson(res, 200, { ok: true, data: getInventoryItems() });
        return;
      }

      if (pathname === `${apiBasePath}/inventory` && req.method === 'POST') {
        const body = await bodyWithActor();
        sendJson(res, 200, { ok: true, data: createInventoryItem(body) });
        return;
      }

      if (pathname.match(/^\/api\/inventory\/\d+$/) && req.method === 'PUT') {
        const id = parseNumericId(pathname);
        const body = await bodyWithActor();
        sendJson(res, 200, { ok: true, data: updateInventoryItem({ ...body, id }) });
        return;
      }

      if (pathname.match(/^\/api\/inventory\/\d+$/) && req.method === 'DELETE') {
        const id = parseNumericId(pathname);
        sendJson(res, 200, { ok: true, data: deleteInventoryItem(id) });
        return;
      }

      if (pathname === `${apiBasePath}/stock-orders` && req.method === 'GET') {
        sendJson(res, 200, { ok: true, data: getStockOrders(normalizeQuery(url.searchParams)) });
        return;
      }

      if (pathname === `${apiBasePath}/inbound-orders` && req.method === 'GET') {
        const filters = normalizeQuery(url.searchParams);
        sendJson(res, 200, { ok: true, data: getStockOrders({ ...filters, type: '入库' }) });
        return;
      }

      if (pathname === `${apiBasePath}/outbound-orders` && req.method === 'GET') {
        const filters = normalizeQuery(url.searchParams);
        sendJson(res, 200, { ok: true, data: getStockOrders({ ...filters, type: '出库' }) });
        return;
      }

      if (pathname === `${apiBasePath}/stock-orders` && req.method === 'POST') {
        const body = await bodyWithActor();
        sendJson(res, 200, { ok: true, data: createStockOrder(body) });
        return;
      }

      if (pathname.match(/^\/api\/stock-orders\/\d+$/) && req.method === 'GET') {
        const id = parseNumericId(pathname);
        sendJson(res, 200, { ok: true, data: getStockOrderDetail(id) });
        return;
      }

      if (pathname.match(/^\/api\/stock-orders\/\d+$/) && req.method === 'PUT') {
        const id = parseNumericId(pathname);
        const body = await bodyWithActor();
        sendJson(res, 200, { ok: true, data: updateStockOrder({ ...body, id }) });
        return;
      }

      if (pathname.match(/^\/api\/stock-orders\/\d+$/) && req.method === 'DELETE') {
        const id = parseNumericId(pathname);
        const body = await bodyWithActor();
        sendJson(res, 200, {
          ok: true,
          data: deleteStockOrder(id, { ...body.options, actor })
        });
        return;
      }

      if (pathname === `${apiBasePath}/price-sheets` && req.method === 'GET') {
        sendJson(res, 200, { ok: true, data: getPriceSheets(normalizeQuery(url.searchParams)) });
        return;
      }

      if (pathname === `${apiBasePath}/material-prices` && req.method === 'GET') {
        sendJson(res, 200, { ok: true, data: getPriceSheets(normalizeQuery(url.searchParams)) });
        return;
      }

      if (pathname === `${apiBasePath}/price-sheets` && req.method === 'POST') {
        const body = await bodyWithActor();
        sendJson(res, 200, { ok: true, data: createPriceSheet(body) });
        return;
      }

      if (pathname === `${apiBasePath}/material-prices` && req.method === 'POST') {
        const body = await bodyWithActor();
        sendJson(res, 200, { ok: true, data: createPriceSheet(body) });
        return;
      }

      if (pathname.match(/^\/api\/price-sheets\/\d+$/) && req.method === 'PUT') {
        const id = parseNumericId(pathname);
        const body = await bodyWithActor();
        sendJson(res, 200, { ok: true, data: updatePriceSheet({ ...body, id }) });
        return;
      }

      if (pathname.match(/^\/api\/material-prices\/\d+$/) && req.method === 'PUT') {
        const id = parseNumericId(pathname);
        const body = await bodyWithActor();
        sendJson(res, 200, { ok: true, data: updatePriceSheet({ ...body, id }) });
        return;
      }

      if (pathname.match(/^\/api\/price-sheets\/\d+$/) && req.method === 'DELETE') {
        const id = parseNumericId(pathname);
        sendJson(res, 200, { ok: true, data: deletePriceSheet(id) });
        return;
      }

      if (pathname.match(/^\/api\/material-prices\/\d+$/) && req.method === 'DELETE') {
        const id = parseNumericId(pathname);
        sendJson(res, 200, { ok: true, data: deletePriceSheet(id) });
        return;
      }

      if (pathname === `${apiBasePath}/bills` && req.method === 'GET') {
        sendJson(res, 200, { ok: true, data: getBills(normalizeQuery(url.searchParams)) });
        return;
      }

      if (pathname === `${apiBasePath}/bills/summary` && req.method === 'GET') {
        const list = getBills(normalizeQuery(url.searchParams)).filter((bill) => !bill.voidedAt);
        // Sum in cents so totals never show floating-point noise such as 0.30000000000000004.
        const cents = list.reduce((acc, row) => {
          const amount = Math.round(Number(row.amount || 0) * 100);
          if (row.billType === '应收') acc.receivable += amount; else acc.payable += amount;
          return acc;
        }, { receivable: 0, payable: 0 });
        const summary = { receivable: cents.receivable / 100, payable: cents.payable / 100, net: (cents.receivable - cents.payable) / 100 };
        sendJson(res, 200, { ok: true, data: summary });
        return;
      }

      if (pathname === `${apiBasePath}/bills` && req.method === 'POST') {
        const body = await bodyWithActor();
        sendJson(res, 200, { ok: true, data: createBill(body) });
        return;
      }

      if (pathname.match(/^\/api\/bills\/\d+$/) && req.method === 'PUT') {
        const id = parseNumericId(pathname);
        const body = await bodyWithActor();
        sendJson(res, 200, { ok: true, data: updateBill({ ...body, id }) });
        return;
      }

      if (pathname.match(/^\/api\/bills\/\d+$/) && req.method === 'DELETE') {
        const id = parseNumericId(pathname);
        sendJson(res, 200, { ok: true, data: deleteBill(id, await bodyWithActor()) });
        return;
      }

      sendError(res, 404, '未找到接口');
      return;
    }

    handleStaticSite(req, res, pathname);
  } catch (error) {
    const { status, message } = errorResponse(error);
    if (status >= 500) console.error('[server] unexpected error', req.method, req.url, error);
    if (res.headersSent) { res.destroy(); return; }
    sendError(res, status, message);
  }
});

// Last-resort guards: log instead of letting one bad request take the service down.
process.on('unhandledRejection', (reason) => console.error('[server] unhandled rejection', reason));
process.on('uncaughtException', (error) => {
  console.error('[server] uncaught exception, exiting so PM2 can restart cleanly', error);
  process.exit(1);
});

backups.start();

server.listen(port, host, () => {
  console.log(`Factory server running at http://${host}:${server.address().port}`);
  console.log(`API base: http://${host}:${port}${apiBasePath}`);
  console.log(`Storage root: ${storage.rootDir}`);
  console.log(`Business DB: ${getDatabasePath()}`);
  console.log(`Auth DB: ${authDbPath}`);
});
