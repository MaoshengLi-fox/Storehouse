import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import {
  backupDatabaseTo,
  createInventoryItem,
  createBill,
  createPriceSheet,
  createStockOrder,
  deleteBill,
  deletePriceSheet,
  deleteStockOrder,
  getBills,
  getDashboardData,
  getDatabasePath,
  getInventoryItems,
  getPriceSheets,
  getStockOrderDetail,
  getStockOrders,
  initializeDatabase,
  replaceDatabaseFrom,
  updateBill,
  updatePriceSheet,
  updateStockOrder
} from './database.js';
import { buildWorkbook } from './exporters.js';
import * as XLSX from 'xlsx';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const isDev = !app.isPackaged;
const remoteApiBaseUrl = process.env.FACTORY_API_BASE_URL || '';
let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1180,
    minHeight: 760,
    backgroundColor: '#f4f1ea',
    autoHideMenuBar: true,
    center: true,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.cjs')
    }
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow.center();
    mainWindow.show();
    mainWindow.focus();
  });

  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    console.error('Window failed to load:', { errorCode, errorDescription, validatedURL });
    dialog.showErrorBox(
      '桌面窗口加载失败',
      `页面地址：${validatedURL}\n错误信息：${errorDescription} (${errorCode})`
    );
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  if (isDev) {
    mainWindow.loadURL('http://127.0.0.1:5173').catch((error) => {
      console.error('Failed to load dev URL:', error);
      dialog.showErrorBox('开发环境启动失败', String(error.message || error));
    });
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html')).catch((error) => {
      console.error('Failed to load build file:', error);
      dialog.showErrorBox('桌面窗口加载失败', String(error.message || error));
    });
  }
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

async function printStockOrder(orderId) {
  const order = remoteApiBaseUrl
    ? await fetchRemoteJson(`stock-orders/${orderId}`)
    : getStockOrderDetail(orderId);
  const printWindow = new BrowserWindow({
    width: 900,
    height: 1100,
    show: false,
    webPreferences: {
      sandbox: true
    }
  });

  const html = `
    <html>
      <head>
        <meta charset="UTF-8" />
        <title>${escapeHtml(order.type)}单打印</title>
        <style>
          body { font-family: "Microsoft YaHei", sans-serif; padding: 28px; color: #1e2430; }
          h1 { margin: 0 0 18px; font-size: 28px; }
          .meta { display: grid; grid-template-columns: repeat(2, 1fr); gap: 10px 24px; margin-bottom: 24px; }
          .meta p { margin: 0; font-size: 14px; }
          table { width: 100%; border-collapse: collapse; margin-top: 12px; }
          th, td { border: 1px solid #444; padding: 10px 12px; text-align: left; font-size: 14px; }
          .footer { margin-top: 24px; display: grid; grid-template-columns: repeat(3, 1fr); gap: 18px; }
          .footer div { border-top: 1px solid #999; padding-top: 10px; }
        </style>
      </head>
      <body>
        <h1>${escapeHtml(order.type)}单</h1>
        <div class="meta">
          <p>单号：${escapeHtml(order.orderNo)}</p>
          <p>日期：${escapeHtml(order.orderDate)}</p>
          <p>${escapeHtml(order.type === '出库' ? '客户' : '回库对象')}：${escapeHtml(order.partner)}</p>
          <p>制表人：${escapeHtml(order.operator)}</p>
          <p>送货/回库单号：${escapeHtml(order.deliveryNo)}</p>
          <p>委外单号：${escapeHtml(order.outsourceNo)}</p>
          <p>加工单号：${escapeHtml(order.processNo)}</p>
          <p>物料编码：${escapeHtml(order.itemCode)}</p>
          <p>品名规格：${escapeHtml(order.specification || order.itemName)}</p>
        </div>
        <table>
          <thead>
            <tr>
              <th>业务类型</th>
              <th>单位</th>
              <th>镀种</th>
              <th>数量</th>
              <th>单价</th>
              <th>金额</th>
              <th>库位</th>
              <th>备注</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>${escapeHtml(order.businessType || order.type)}</td>
              <td>${escapeHtml(order.unit)}</td>
              <td>${escapeHtml(order.plating)}</td>
              <td>${escapeHtml(order.quantity)}</td>
              <td>${escapeHtml(order.unitPrice)}</td>
              <td>${escapeHtml(order.totalAmount)}</td>
              <td>${escapeHtml(order.location)}</td>
              <td>${escapeHtml(order.remark)}</td>
            </tr>
          </tbody>
        </table>
        <div class="footer">
          <div>仓管签字：</div>
          <div>财务签字：</div>
          <div>负责人签字：</div>
        </div>
      </body>
    </html>
  `;

  await printWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  await new Promise((resolve, reject) => {
    printWindow.webContents.print({ printBackground: true }, (success, failureReason) => {
      printWindow.close();
      if (!success) {
        reject(new Error(failureReason || '打印失败'));
        return;
      }
      resolve();
    });
  });

  return { ok: true, orderNo: order.orderNo };
}

async function fetchRemoteJson(pathname, options = {}) {
  const url = new URL(pathname, remoteApiBaseUrl.endsWith('/') ? remoteApiBaseUrl : `${remoteApiBaseUrl}/`);
  const response = await fetch(url, {
    method: options.method || 'GET',
    headers: {
      'Content-Type': 'application/json'
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body)
  });
  const payload = await response.json();
  if (!response.ok || payload.ok === false) {
    throw new Error(payload.message || '共享服务请求失败');
  }
  return payload.data ?? payload;
}

function registerIpcHandlers() {
  ipcMain.handle('app:get-runtime-config', () => ({
    apiBaseUrl: remoteApiBaseUrl,
    storageMode: remoteApiBaseUrl ? 'shared' : 'local'
  }));

  ipcMain.handle('app:get-bootstrap-data', () => ({
    databasePath: remoteApiBaseUrl ? '共享服务模式' : getDatabasePath(),
    apiBaseUrl: remoteApiBaseUrl,
    storageMode: remoteApiBaseUrl ? 'shared' : 'local'
  }));

  ipcMain.handle('dashboard:get-data', () => getDashboardData());
  ipcMain.handle('inventory:list', () => getInventoryItems());
  ipcMain.handle('inventory:create', (_event, payload) => createInventoryItem(payload));
  ipcMain.handle('stock-orders:list', (_event, filters) => getStockOrders(filters));
  ipcMain.handle('stock-orders:detail', (_event, orderId) => getStockOrderDetail(orderId));
  ipcMain.handle('price-sheets:list', (_event, filters) => getPriceSheets(filters));
  ipcMain.handle('bills:list', (_event, filters) => getBills(filters));

  ipcMain.handle('stock-orders:create', (_event, payload) => createStockOrder(payload));
  ipcMain.handle('stock-orders:update', (_event, payload) => updateStockOrder(payload));
  ipcMain.handle('stock-orders:delete', (_event, payload) => {
    if (typeof payload === 'object' && payload !== null) {
      return deleteStockOrder(payload.orderId, payload.options || {});
    }
    return deleteStockOrder(payload);
  });
  ipcMain.handle('stock-orders:print', (_event, orderId) => printStockOrder(orderId));
  ipcMain.handle('price-sheets:create', (_event, payload) => createPriceSheet(payload));
  ipcMain.handle('price-sheets:update', (_event, payload) => updatePriceSheet(payload));
  ipcMain.handle('price-sheets:delete', (_event, id) => deletePriceSheet(id));
  ipcMain.handle('bills:create', (_event, payload) => createBill(payload));
  ipcMain.handle('bills:update', (_event, payload) => updateBill(payload));
  ipcMain.handle('bills:delete', (_event, id) => deleteBill(id));

  ipcMain.handle('exports:create', async (_event, payload) => {
    const records = Array.isArray(payload.records)
      ? payload.records
      : payload.type === 'stockOrders'
        ? getStockOrders(payload.filters || {})
        : payload.type === 'priceSheets'
          ? getPriceSheets(payload.filters || {})
          : getBills(payload.filters || {});

    const workbook = buildWorkbook(payload.type, records);
    const defaultName = `${payload.type}-${new Date().toISOString().slice(0, 10)}.xlsx`;
    const result = await dialog.showSaveDialog({
      title: '导出 Excel',
      defaultPath: defaultName,
      filters: [{ name: 'Excel 文件', extensions: ['xlsx'] }]
    });

    if (result.canceled || !result.filePath) {
      return { ok: false, canceled: true };
    }

    XLSX.writeFile(workbook, result.filePath);
    return { ok: true, filePath: result.filePath, count: records.length };
  });

  ipcMain.handle('db:backup', async () => {
    if (remoteApiBaseUrl) {
      throw new Error('共享服务模式下请在服务主机上执行备份');
    }

    const result = await dialog.showSaveDialog({
      title: '备份数据库',
      defaultPath: `factory-desk-backup-${new Date().toISOString().slice(0, 10)}.db`,
      filters: [{ name: 'SQLite 数据库', extensions: ['db'] }]
    });

    if (result.canceled || !result.filePath) {
      return { ok: false, canceled: true };
    }

    return backupDatabaseTo(result.filePath);
  });

  ipcMain.handle('db:restore', async () => {
    if (remoteApiBaseUrl) {
      throw new Error('共享服务模式下请在服务主机上执行恢复');
    }

    const result = await dialog.showOpenDialog({
      title: '恢复数据库备份',
      properties: ['openFile'],
      filters: [{ name: 'SQLite 数据库', extensions: ['db'] }]
    });

    if (result.canceled || !result.filePaths?.length) {
      return { ok: false, canceled: true };
    }

    replaceDatabaseFrom(result.filePaths[0]);
    return { ok: true, filePath: result.filePaths[0] };
  });
}

process.on('uncaughtException', (error) => {
  console.error('Uncaught exception in main process:', error);
  dialog.showErrorBox('主进程异常', String(error.stack || error.message || error));
});

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection in main process:', reason);
  dialog.showErrorBox('主进程未处理异常', String(reason));
});

app.whenReady().then(() => {
  if (!remoteApiBaseUrl) {
    initializeDatabase(app.getPath('userData'));
  }
  registerIpcHandlers();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
      return;
    }

    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
  });
}).catch((error) => {
  console.error('Failed during app startup:', error);
  dialog.showErrorBox('应用启动失败', String(error.stack || error.message || error));
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
