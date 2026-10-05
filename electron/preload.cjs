const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('factoryApi', {
  getRuntimeConfig: () => ipcRenderer.invoke('app:get-runtime-config'),
  getBootstrapData: () => ipcRenderer.invoke('app:get-bootstrap-data'),
  getDashboardData: () => ipcRenderer.invoke('dashboard:get-data'),
  getInventoryItems: () => ipcRenderer.invoke('inventory:list'),
  createInventoryItem: (payload) => ipcRenderer.invoke('inventory:create', payload),
  getStockOrders: (filters) => ipcRenderer.invoke('stock-orders:list', filters),
  getStockOrderDetail: (orderId) => ipcRenderer.invoke('stock-orders:detail', orderId),
  createStockOrder: (payload) => ipcRenderer.invoke('stock-orders:create', payload),
  updateStockOrder: (payload) => ipcRenderer.invoke('stock-orders:update', payload),
  deleteStockOrder: (orderId) => ipcRenderer.invoke('stock-orders:delete', orderId),
  printStockOrder: (orderId) => ipcRenderer.invoke('stock-orders:print', orderId),
  getPriceSheets: (filters) => ipcRenderer.invoke('price-sheets:list', filters),
  createPriceSheet: (payload) => ipcRenderer.invoke('price-sheets:create', payload),
  updatePriceSheet: (payload) => ipcRenderer.invoke('price-sheets:update', payload),
  deletePriceSheet: (id) => ipcRenderer.invoke('price-sheets:delete', id),
  getBills: (filters) => ipcRenderer.invoke('bills:list', filters),
  createBill: (payload) => ipcRenderer.invoke('bills:create', payload),
  updateBill: (payload) => ipcRenderer.invoke('bills:update', payload),
  deleteBill: (id) => ipcRenderer.invoke('bills:delete', id),
  exportSheet: (payload) => ipcRenderer.invoke('exports:create', payload),
  backupDatabase: () => ipcRenderer.invoke('db:backup'),
  restoreDatabase: () => ipcRenderer.invoke('db:restore')
});
