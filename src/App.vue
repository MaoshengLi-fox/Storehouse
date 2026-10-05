<template>
  <RouterView v-if="isLoginRoute" />

  <div v-else class="shell" @keydown.esc="menuOpen = false">
    <button v-if="menuOpen" class="sidebar-scrim" aria-label="关闭导航菜单" @click="menuOpen = false"></button>
    <aside id="main-navigation" class="sidebar" :class="{ 'is-open': menuOpen }" :inert="isMobile && !menuOpen">
      <div class="brand">
        <div class="brand-symbol"><AppIcon name="factory" /></div>
        <div><strong>Factory Desk<span class="brand-dot">.</span></strong><span>工厂经营管理台</span></div>
      </div>

      <p class="nav-caption">业务工作台</p>
      <nav class="nav" aria-label="主要导航">
        <RouterLink
          v-for="item in navItems"
          :key="item.to"
          :to="item.to"
          class="nav-link"
          @click="menuOpen = false"
        >
          <AppIcon :name="item.icon" />
          <span>{{ item.label }}</span>
          <AppIcon class="nav-chevron" name="chevron" />
        </RouterLink>
      </nav>
      <div class="sidebar-bottom">
        <div class="workspace-note"><span class="status-dot"></span> 团队共享空间<small>业务数据统一管理，多设备协同</small></div>
        <div class="sidebar-user">
          <span class="user-avatar">{{ userInitial }}</span>
          <div><strong>{{ displayName }}</strong><small>{{ isAdmin ? '系统管理员' : '业务成员' }}</small></div>
          <button class="logout-button" aria-label="退出登录" title="退出登录" @click="handleLogout"><AppIcon name="logout" /></button>
        </div>
      </div>
    </aside>

    <main class="content">
      <div class="toast-stack" aria-live="polite">
        <div
          v-for="item in notifications"
          :key="item.id"
          class="toast-item"
          :data-type="item.type"
        >
          <AppIcon :name="item.type === 'error' ? 'alert' : 'check'" /> {{ item.text }}
        </div>
      </div>

      <header class="topbar">
        <div class="topbar-heading">
          <button class="mobile-menu-button" aria-label="展开导航菜单" :aria-expanded="menuOpen" aria-controls="main-navigation" @click="menuOpen = !menuOpen"><AppIcon name="menu" /></button>
          <div>
          <p class="breadcrumb">工作台 <span>/</span> {{ route.meta.title }}</p>
          <h2>{{ route.meta.title }}</h2>
          <p class="page-description">{{ pageDescription }}</p>
          </div>
        </div>
        <div class="topbar-actions">
          <span class="today-label"><AppIcon name="calendar" />{{ todayLabel }}</span>
          <button class="action-button" :disabled="loading" @click="handleRefresh"><AppIcon name="refresh" :class="{ spinning: loading }" />{{ loading ? '同步中' : '刷新数据' }}</button>
        </div>
      </header>

      <RouterView :key="route.fullPath" />
    </main>
  </div>
</template>

<script setup>
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { RouterLink, RouterView, useRoute, useRouter } from 'vue-router';
import { useAppData } from './composables/useAppData.js';
import { useNotifier } from './composables/useNotifier.js';
import { desktopApi } from './lib/desktopApi.js';
import AppIcon from './components/AppIcon.vue';

const route = useRoute();
const router = useRouter();
const { state, loading, refreshAll } = useAppData();
const { notifications, notifyError, notifyInfo, notifySuccess } = useNotifier();

const isLoginRoute = computed(() => route.path === '/login');
const isAdmin = computed(() => state.bootstrap?.user?.role === 'admin');
const menuOpen = ref(false);
const mobileQuery = window.matchMedia('(max-width: 780px)');
const isMobile = ref(mobileQuery.matches);
function updateMobile(event) {
  isMobile.value = event.matches;
  if (!event.matches) menuOpen.value = false;
}
const displayName = computed(() => state.bootstrap?.user?.displayName || '工作台用户');
const userInitial = computed(() => displayName.value.slice(0, 1));
const todayLabel = new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric', weekday: 'short' }).format(new Date());

const navItems = computed(() => {
  const items = [
    { to: '/', label: '经营总览', icon: 'dashboard', note: '掌握库存与往来，让每一天的经营更清晰。' },
    { to: '/inbound-orders', label: '入库明细', icon: 'inbound', note: '记录每一笔入库，准确追踪物料流转。' },
    { to: '/outbound-orders', label: '出货明细', icon: 'outbound', note: '管理出货记录，库存与对账同步更新。' },
    { to: '/inventory', label: '库存台账', icon: 'box', note: '查看库存流转，维护库位与安全库存，登记盘点差异。' },
    { to: '/customers', label: '客户档案', icon: 'users', note: '统一维护客户信息、结算账期与往来余额。' },
    { to: '/price-sheets', label: '辅助价目', icon: 'box', note: '集中维护物料档案、规格和标准价格。' },
    { to: '/bills', label: '对账明细', icon: 'bill', note: '清晰核对每笔账款，及时跟进结算进度。' },
    { to: '/documents', label: '对账与打印', icon: 'printer', note: '按客户与时间生成对账单，选择出货或退胚明细打印。' },
    { to: '/receipts', label: '收款登记', icon: 'bill', note: '逐笔登记实际到账，自动跟进账单未收余额。' },
    { to: '/reports', label: '经营分析', icon: 'chart', note: '从月度业务数据，了解经营的变化。' }
  ];

  if (isAdmin.value) {
    items.push({ to: '/backups', label: '备份与恢复', icon: 'download', note: '保管业务数据，管理自动备份与恢复记录。' });
    items.push({ to: '/users', label: '用户管理', icon: 'users', note: '管理团队账号、访问权限和业务编码规则。' });
  }

  return items;
});

const pageDescription = computed(() => navItems.value.find((item) => item.to === route.path)?.note || '');

async function withMessage(action) {
  try {
    const text = await action();
    notifySuccess(text);
  } catch (error) {
    if (error?.code === 401) {
      await router.replace('/login');
      notifyInfo('登录状态已失效，请重新登录');
      return;
    }
    notifyError(error.message || '操作失败');
  }
}

async function handleRefresh() {
  await withMessage(async () => {
    await refreshAll();
    return '数据已刷新';
  });
}

async function handleLogout() {
  try {
    await desktopApi.logout();
  } catch {
    notifyInfo('本机登录状态已清除');
  } finally {
    state.bootstrap = null;
    await router.replace('/login');
  }
}

async function refreshIfNeeded() {
  if (route.path === '/login') {
    return;
  }

  try {
    await refreshAll();
  } catch (error) {
    if (error?.code === 401) await router.replace('/login');
    else notifyError(error.message || '数据加载失败，请重试');
  }
}

onMounted(() => {
  mobileQuery.addEventListener('change', updateMobile);
  refreshIfNeeded();
});

onUnmounted(() => mobileQuery.removeEventListener('change', updateMobile));

watch(() => route.path, () => {
  refreshIfNeeded();
});

watch(() => route.query.notice, (notice) => {
  if (notice !== 'admin-only') return;
  notifyInfo('该页面仅管理员可以使用');
  router.replace({ path: route.path, query: {} });
}, { immediate: true });
</script>
