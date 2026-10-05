const AUTH_TOKEN_KEY = 'factory_auth_token';
const AUTH_USER_KEY = 'factory_auth_user';

function toPlainPayload(value) {
  if (value === undefined) {
    return undefined;
  }

  return JSON.parse(JSON.stringify(value));
}

function readStorage(key) {
  if (typeof window === 'undefined' || !window.localStorage) {
    return '';
  }
  return window.localStorage.getItem(key) || '';
}

function writeStorage(key, value) {
  if (typeof window === 'undefined' || !window.localStorage) {
    return;
  }

  if (!value) {
    window.localStorage.removeItem(key);
    return;
  }

  window.localStorage.setItem(key, value);
}

let runtimeConfigPromise = null;

function resolveApiBaseUrl() {
  const configured = String(import.meta.env.VITE_FACTORY_API_BASE_URL || '').trim();
  if (!configured) {
    if (typeof window !== 'undefined' && window.location?.origin) {
      return `${window.location.origin}/api`;
    }
    return '/api';
  }

  if (/^https?:\/\//i.test(configured)) {
    return configured;
  }

  if (configured.startsWith('/')) {
    if (typeof window !== 'undefined' && window.location?.origin) {
      return `${window.location.origin}${configured}`;
    }
  }

  return configured;
}

async function getRuntimeConfig() {
  if (!runtimeConfigPromise) {
    runtimeConfigPromise = Promise.resolve({
      apiBaseUrl: resolveApiBaseUrl(),
      storageMode: 'shared'
    });
  }

  return runtimeConfigPromise;
}

function getAuthToken() {
  return readStorage(AUTH_TOKEN_KEY);
}

function setAuthToken(token) {
  writeStorage(AUTH_TOKEN_KEY, token || '');
}

function setAuthUser(user) {
  if (!user) {
    writeStorage(AUTH_USER_KEY, '');
    return;
  }
  writeStorage(AUTH_USER_KEY, JSON.stringify(user));
}

function getAuthUser() {
  const raw = readStorage(AUTH_USER_KEY);
  if (!raw) {
    return null;
  }

  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function clearAuth() {
  setAuthToken('');
  setAuthUser(null);
}

function buildUrl(baseUrl, path, query) {
  let normalizedBase = String(baseUrl || '').trim();
  if (!/^https?:\/\//i.test(normalizedBase)) {
    if (typeof window !== 'undefined' && window.location?.origin) {
      normalizedBase = new URL(normalizedBase || '/api', window.location.origin).toString();
    } else {
      normalizedBase = 'http://127.0.0.1/api';
    }
  }

  let url;
  try {
    url = new URL(path, normalizedBase.endsWith('/') ? normalizedBase : `${normalizedBase}/`);
  } catch {
    const origin = typeof window !== 'undefined' && window.location?.origin
      ? window.location.origin
      : 'http://127.0.0.1';
    const safeBase = `${origin}/api/`;
    url = new URL(String(path || '').replace(/^\/+/, ''), safeBase);
  }
  Object.entries(query || {}).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(key, String(value));
    }
  });
  return url.toString();
}

async function requestRemote(path, options = {}) {
  const config = await getRuntimeConfig();
  const token = getAuthToken();
  const headers = {
    'Content-Type': options.binary ? 'application/octet-stream' : 'application/json'
  };

  if (token && !options.skipAuth) {
    headers.Authorization = `Bearer ${token}`;
  }

  const response = await fetch(buildUrl(config.apiBaseUrl, path, options.query), {
    method: options.method || 'GET',
    headers,
    body: options.binary || (options.body === undefined ? undefined : JSON.stringify(toPlainPayload(options.body)))
  });

  if (options.download && response.ok) return response.blob();
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error(`服务器暂时无法响应（HTTP ${response.status}），请稍后重试`);
  }

  if (response.status === 401) {
    clearAuth();
    const unauthorized = new Error(payload.message || '未登录或登录已过期');
    unauthorized.code = 401;
    throw unauthorized;
  }

  if (!response.ok || payload.ok === false) {
    throw new Error(payload.message || '请求失败');
  }

  return payload.data ?? payload;
}

function toDateTag() {
  // Local calendar date (UTC would name a file after yesterday in the early morning).
  return new Intl.DateTimeFormat('sv-SE').format(new Date());
}

async function downloadWorkbook(type, records) {
  const [{ buildWorkbook }, XLSX] = await Promise.all([
    import('../utils/exporters.js'),
    import('xlsx')
  ]);
  const workbook = buildWorkbook(type, records || []);
  const fileNameMap = {
    stockOrders: '出入库明细',
    priceSheets: '物料价目',
    bills: '对账明细',
    inventory: '库存余额',
    inventoryLedger: '库存流水',
    receipts: '收款登记'
  };
  XLSX.writeFile(workbook, `${fileNameMap[type] || '导出数据'}-${toDateTag()}.xlsx`);
  return { ok: true, canceled: false, count: Array.isArray(records) ? records.length : 0 };
}

function buildPrintableHtml(order) {
  const esc = (value) => String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');

  return `
    <html>
      <head>
        <meta charset="UTF-8" />
        <title>${esc(order.type)}单打印</title>
        <style>
          body { font-family: "Microsoft YaHei", sans-serif; padding: 24px; color: #1e2430; }
          h1 { margin: 0 0 18px; font-size: 28px; }
          .meta { display: grid; grid-template-columns: repeat(2, 1fr); gap: 10px 24px; margin-bottom: 24px; }
          .meta p { margin: 0; font-size: 14px; }
          table { width: 100%; border-collapse: collapse; margin-top: 12px; }
          th, td { border: 1px solid #444; padding: 10px 12px; text-align: left; font-size: 14px; }
        </style>
      </head>
      <body>
        <h1>${esc(order.type)}单</h1>
        <div class="meta">
          <p>单号：${esc(order.orderNo)}</p>
          <p>日期：${esc(order.orderDate)}</p>
          <p>${esc(order.type === '出库' ? '客户' : '回库对象')}：${esc(order.partner)}</p>
          <p>制表人：${esc(order.operator)}</p>
          <p>送货/回库单号：${esc(order.deliveryNo)}</p>
          <p>委外单号：${esc(order.outsourceNo)}</p>
          <p>加工单号：${esc(order.processNo)}</p>
          <p>物料编码：${esc(order.itemCode)}</p>
          <p>品名规格：${esc(order.specification || order.itemName)}</p>
        </div>
        <table>
          <thead>
            <tr>
              <th>业务类型</th>
              <th>单位</th>
              <th>镀种</th>
              <th>数量</th>
              ${order.type === '入库' ? '' : '<th>单价</th><th>金额</th>'}
              <th>库位</th>
              <th>备注</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>${esc(order.businessType || order.type)}</td>
              <td>${esc(order.unit)}</td>
              <td>${esc(order.plating)}</td>
              <td>${esc(order.quantity)}</td>
              ${order.type === '入库' ? '' : `<td>${esc(order.unitPrice)}</td><td>${esc(order.totalAmount)}</td>`}
              <td>${esc(order.location)}</td>
              <td>${esc(order.remark)}</td>
            </tr>
          </tbody>
        </table>
      </body>
    </html>
  `;
}

export const desktopApi = {
  getRuntimeConfig,
  getAuthToken,
  getAuthUser,
  clearAuth,
  login: async (payload) => {
    const result = await requestRemote('auth/login', {
      method: 'POST',
      body: payload,
      skipAuth: true
    });

    setAuthToken(result.token || '');
    setAuthUser(result.user || null);
    return result;
  },
  logout: async () => {
    try {
      await requestRemote('auth/logout', { method: 'POST' });
    } finally {
      clearAuth();
    }
    return { ok: true };
  },
  getCurrentSession: async () => requestRemote('auth/me'),
  getUsers: () => requestRemote('users'),
  createUser: (payload) => requestRemote('users', { method: 'POST', body: payload }),
  resetUserPassword: (userId, password) => requestRemote(`users/${userId}/password`, { method: 'PUT', body: { password } }),
  setUserActiveStatus: (userId, isActive) => requestRemote(`users/${userId}/status`, { method: 'PUT', body: { isActive } }),
  resetBusinessData: () => requestRemote('admin/reset-business-data', { method: 'POST' }),
  getNumberingSettings: () => requestRemote('admin/numbering-settings'),
  updateNumberingSettings: (payload) => requestRemote('admin/numbering-settings', { method: 'PUT', body: payload }),
  getBootstrapData: async () => {
    const config = await getRuntimeConfig();
    const bootstrap = await requestRemote('bootstrap');
    return {
      ...bootstrap,
      apiBaseUrl: config.apiBaseUrl,
      storageMode: 'shared'
    };
  },
  getCustomers: () => requestRemote('customers'),
  generateDocument: (payload) => requestRemote('documents/preview', { method: 'POST', body: payload }),
  exportDocument: async (payload) => {
    const blob = await requestRemote('documents/export', { method: 'POST', body: payload, download: true });
    const url = URL.createObjectURL(blob), link = document.createElement('a');
    const names = { statement: '客户对账单', delivery: '出货单', 'blank-return': '退胚单' };
    link.href = url; link.download = `${names[payload.kind]}-${payload.startDate}-${payload.endDate}.xlsx`; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  },
  getPrintSettings: () => requestRemote('print-settings'),
  updatePrintSettings: (payload) => requestRemote('admin/print-settings', { method: 'PUT', body: payload }),
  createCustomer: (payload) => requestRemote('customers', { method: 'POST', body: payload }),
  updateCustomer: (payload) => requestRemote(`customers/${payload.id}`, { method: 'PUT', body: payload }),
  getInventoryLedger: (filters) => requestRemote('inventory-ledger', { query: filters }),
  adjustInventory: (payload) => requestRemote('inventory-adjustments', { method: 'POST', body: payload }),
  getReceipts: (filters) => requestRemote('receipts', { query: filters }),
  createReceipt: (payload) => requestRemote('receipts', { method: 'POST', body: payload }),
  voidReceipt: (id, reason) => requestRemote(`receipts/${id}/void`, { method: 'POST', body: { reason } }),
  getBillEvents: (id) => requestRemote(`bills/${id}/events`),
  restoreBill: (id) => requestRemote(`bills/${id}/restore`, { method: 'POST' }),
  clearLegacySettlement: (id, reason) => requestRemote(`admin/bills/${id}/clear-legacy`, { method: 'POST', body: { reason } }),
  getBackups: () => requestRemote('admin/backups'),
  updateBackupSettings: (payload) => requestRemote('admin/backups/settings', { method: 'PUT', body: payload }),
  uploadBackup: (file) => requestRemote('admin/backups/upload', { method: 'POST', binary: file }),
  downloadBackup: async (id) => {
    const blob = await requestRemote(`admin/backups/${encodeURIComponent(id)}/download`, { download: true });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url; anchor.download = id; anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  },
  getDashboardData: () => requestRemote('dashboard'),
  getInventoryItems: () => requestRemote('inventory'),
  createInventoryItem: (payload) => requestRemote('inventory', { method: 'POST', body: payload }),
  updateInventoryItem: (payload) => requestRemote(`inventory/${payload.id}`, { method: 'PUT', body: payload }),
  deleteInventoryItem: (id) => requestRemote(`inventory/${id}`, { method: 'DELETE' }),
  getInboundOrders: (filters) => requestRemote('inbound-orders', { query: filters }),
  getOutboundOrders: (filters) => requestRemote('outbound-orders', { query: filters }),
  getStockOrders: (filters) => requestRemote('stock-orders', { query: filters }),
  getStockOrderDetail: (orderId) => requestRemote(`stock-orders/${orderId}`),
  createStockOrder: (payload) => requestRemote('stock-orders', { method: 'POST', body: payload }),
  updateStockOrder: (payload) => requestRemote(`stock-orders/${payload.id}`, { method: 'PUT', body: payload }),
  deleteStockOrder: (payload) => {
    const body = typeof payload === 'object' && payload !== null ? payload : {};
    const orderId = typeof payload === 'object' && payload !== null ? payload.orderId : payload;
    return requestRemote(`stock-orders/${orderId}`, { method: 'DELETE', body });
  },
  printStockOrder: async (orderId) => {
    const order = await requestRemote(`stock-orders/${orderId}`);
    const popup = window.open('', '_blank');
    if (!popup) {
      throw new Error('浏览器阻止了打印窗口，请允许弹窗后重试');
    }

    popup.document.open();
    popup.document.write(buildPrintableHtml(order));
    popup.document.close();
    popup.focus();
    popup.print();
    return { ok: true };
  },
  getPriceSheets: (filters) => requestRemote('material-prices', { query: filters }),
  saveMaterialPrice: (payload) => requestRemote('material-prices/save', { method: 'POST', body: payload }),
  createPriceSheet: (payload) => requestRemote('material-prices', { method: 'POST', body: payload }),
  updatePriceSheet: (payload) => requestRemote(`material-prices/${payload.id}`, { method: 'PUT', body: payload }),
  deletePriceSheet: (id) => requestRemote(`material-prices/${id}`, { method: 'DELETE' }),
  getBills: (filters) => requestRemote('bills', { query: filters }),
  getBillSummary: (filters) => requestRemote('bills/summary', { query: filters }),
  createBill: (payload) => requestRemote('bills', { method: 'POST', body: payload }),
  updateBill: (payload) => requestRemote(`bills/${payload.id}`, { method: 'PUT', body: payload }),
  deleteBill: (id, reason) => requestRemote(`bills/${id}`, { method: 'DELETE', body: { reason } }),
  exportSheet: async (payload) => {
    const records = Array.isArray(payload?.records) ? payload.records : [];
    return downloadWorkbook(payload?.type || 'stockOrders', records);
  },
  backupDatabase: () => requestRemote('admin/backups', { method: 'POST' }),
  restoreDatabase: (id, confirmation) => requestRemote(`admin/backups/${encodeURIComponent(id)}/restore`, { method: 'POST', body: { confirmation } })
};
