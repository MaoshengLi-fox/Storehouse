import { createRouter, createWebHashHistory } from 'vue-router';
import DashboardView from '../views/DashboardView.vue';
import InboundOrdersView from '../views/InboundOrdersView.vue';
import OutboundOrdersView from '../views/OutboundOrdersView.vue';
import PriceSheetsView from '../views/PriceSheetsView.vue';
import BillsView from '../views/BillsView.vue';
import ReportsView from '../views/ReportsView.vue';
import LoginView from '../views/LoginView.vue';
import UserManagementView from '../views/UserManagementView.vue';
import { desktopApi } from '../lib/desktopApi.js';

const routes = [
  { path: '/login', component: LoginView, meta: { title: '登录' } },
  { path: '/', component: DashboardView, meta: { title: '经营总览', requiresAuth: true } },
  { path: '/inbound-orders', component: InboundOrdersView, meta: { title: '入库明细', requiresAuth: true } },
  { path: '/outbound-orders', component: OutboundOrdersView, meta: { title: '出货明细', requiresAuth: true } },
  { path: '/price-sheets', component: PriceSheetsView, meta: { title: '辅助价目', requiresAuth: true } },
  { path: '/bills', component: BillsView, meta: { title: '对账明细', requiresAuth: true } },
  { path: '/documents', component: () => import('../views/DocumentsView.vue'), meta: { title: '对账与打印', requiresAuth: true } },
  { path: '/reports', component: ReportsView, meta: { title: '经营分析', requiresAuth: true } },
  { path: '/inventory', component: () => import('../views/InventoryView.vue'), meta: { title: '库存台账', requiresAuth: true } },
  { path: '/customers', component: () => import('../views/CustomersView.vue'), meta: { title: '客户档案', requiresAuth: true } },
  { path: '/receipts', component: () => import('../views/ReceiptsView.vue'), meta: { title: '收款登记', requiresAuth: true } },
  { path: '/backups', component: () => import('../views/BackupsView.vue'), meta: { title: '备份与恢复', requiresAuth: true, requiresAdmin: true } },
  { path: '/users', component: UserManagementView, meta: { title: '用户管理', requiresAuth: true, requiresAdmin: true } }
];

const router = createRouter({
  history: createWebHashHistory(),
  scrollBehavior: () => ({ top: 0 }),
  routes
});

router.beforeEach(async (to) => {
  const runtime = await desktopApi.getRuntimeConfig();
  const isSharedMode = Boolean(runtime.apiBaseUrl);

  if (!isSharedMode && to.path === '/login') {
    return '/';
  }

  if (!isSharedMode) {
    return true;
  }

  const hasToken = Boolean(desktopApi.getAuthToken());

  if (to.path === '/login') {
    if (hasToken) {
      return '/';
    }
    return true;
  }

  if (to.meta.requiresAuth && !hasToken) {
    return '/login';
  }

  if (to.meta.requiresAdmin) {
    const localUser = desktopApi.getAuthUser();
    if (localUser?.role === 'admin') {
      return true;
    }

    try {
      const session = await desktopApi.getCurrentSession();
      if (session?.user?.role === 'admin') {
        return true;
      }
    } catch {
      return '/login';
    }

    return { path: '/', query: { notice: 'admin-only' } };
  }

  return true;
});

export default router;
