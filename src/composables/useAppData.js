import { reactive, ref } from 'vue';
import { setBusinessTimeZone } from '../utils/formatters.js';
import { desktopApi } from '../lib/desktopApi.js';

const state = reactive({
  bootstrap: null,
  dashboard: null,
  inventoryItems: [],
  stockOrders: [],
  priceSheets: [],
  bills: [],
  customers: [],
  receipts: []
});

const loading = ref(false);

async function refreshAll(filters = {}) {
  loading.value = true;
  try {
    const [bootstrap, dashboard, inventoryItems, stockOrders, priceSheets, bills, customers, receipts] = await Promise.all([
      desktopApi.getBootstrapData(),
      desktopApi.getDashboardData(),
      desktopApi.getInventoryItems(),
      desktopApi.getStockOrders(filters.stockOrders || {}),
      desktopApi.getPriceSheets(filters.priceSheets || {}),
      desktopApi.getBills(filters.bills || {}),
      desktopApi.getCustomers(),
      desktopApi.getReceipts()
    ]);

    state.bootstrap = bootstrap;
    setBusinessTimeZone(bootstrap.businessTimeZone);
    state.dashboard = dashboard;
    state.inventoryItems = inventoryItems;
    state.stockOrders = stockOrders;
    state.priceSheets = priceSheets;
    state.bills = bills;
    state.customers = customers;
    state.receipts = receipts;
  } finally {
    loading.value = false;
  }
}

export function useAppData() {
  return {
    state,
    loading,
    refreshAll,
    refreshDashboard: async () => {
      state.dashboard = await desktopApi.getDashboardData();
    },
    refreshInventory: async () => {
      state.inventoryItems = await desktopApi.getInventoryItems();
    },
    refreshStockOrders: async (filters = {}) => {
      state.stockOrders = await desktopApi.getStockOrders(filters);
    },
    refreshPriceSheets: async (filters = {}) => {
      state.priceSheets = await desktopApi.getPriceSheets(filters);
    },
    refreshBills: async (filters = {}) => {
      state.bills = await desktopApi.getBills(filters);
    }
  };
}
