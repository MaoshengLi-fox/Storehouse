<template>
  <div class="page-grid dashboard-page">
    <section class="welcome-panel">
      <div><p class="eyebrow">TODAY AT A GLANCE</p><h3>{{ greeting }}，{{ displayName }}</h3><p>每一笔流转都有记录，每一天经营心中有数。</p></div>
      <RouterLink to="/inbound-orders" class="primary-button"><AppIcon name="plus" />记录一笔入库</RouterLink>
      <div class="welcome-decoration" aria-hidden="true"><AppIcon name="factory" /></div>
    </section>

    <div class="stats-grid">
      <article v-for="(card, index) in dashboard.summaryCards" :key="card.label" class="metric-card" :data-tone="card.tone">
        <div class="metric-top"><p>{{ card.label }}</p><span class="metric-icon"><AppIcon :name="metricIcons[index]" /></span></div>
        <strong>{{ card.value }}</strong><span>{{ card.hint }}<small v-if="card.suffix"> · {{ card.suffix }}</small></span>
      </article>
    </div>

    <section class="quick-actions" aria-label="常用操作">
      <RouterLink v-for="link in quickLinks" :key="link.to" :to="link.to" class="quick-action">
        <span class="quick-action-icon"><AppIcon :name="link.icon" /></span><div><strong>{{ link.title }}</strong><small>{{ link.note }}</small></div><AppIcon name="arrow" />
      </RouterLink>
    </section>

    <div class="overview-columns">
      <SectionCard title="最近业务动态" subtitle="最近 5 笔出入库记录">
        <template #action><RouterLink class="text-link" to="/outbound-orders">查看出货<AppIcon name="arrow" /></RouterLink></template>
        <div v-if="dashboard.recentOrders.length" class="timeline">
          <div v-for="record in dashboard.recentOrders" :key="record.orderNo" class="timeline-row">
            <span class="activity-icon" :data-type="record.type"><AppIcon :name="record.type === '入库' ? 'inbound' : 'outbound'" /></span>
            <div class="activity-detail"><strong>{{ record.specification || record.itemName }}</strong><p>{{ record.deliveryNo || record.orderNo }}<span> · {{ record.partner }}</span></p></div>
            <div class="activity-amount"><strong :class="record.type === '入库' ? 'positive-text' : ''">{{ record.type === '入库' ? '+' : '−' }}{{ formatNumber(record.quantity) }}<small>{{ record.unit }}</small></strong><time>{{ record.orderDate }}</time></div>
          </div>
        </div>
        <EmptyState v-else icon="clock" title="业务记录从这里开始" description="完成一笔入库或出货后，这里会显示最新动态。"><RouterLink class="text-link" to="/inbound-orders">前往入库管理<AppIcon name="arrow" /></RouterLink></EmptyState>
      </SectionCard>

      <SectionCard title="库存关注" subtitle="低于安全库存的物料">
        <template #action><span class="count-badge">{{ dashboard.warningItems.length }} 项</span></template>
        <div v-if="dashboard.warningItems.length" class="warning-list">
          <div v-for="item in dashboard.warningItems" :key="item.code" class="warning-row">
            <div><strong>{{ item.name }}</strong><span>{{ item.code }}</span><div class="stock-progress"><i :style="{ width: `${Math.max(0, Math.min(100, (item.stockQty / Math.max(item.safetyStock, 1)) * 100))}%` }"></i></div></div>
            <div class="stock-number"><strong>{{ formatNumber(item.stockQty) }}<small>{{ item.unit }}</small></strong><span>安全库存 {{ formatNumber(item.safetyStock) }}</span></div>
          </div>
        </div>
        <EmptyState v-else icon="shield" title="暂无库存预警" description="低于安全库存的物料会显示在这里，方便及时跟进。" />
      </SectionCard>
    </div>

    <div class="overview-footer"><span><AppIcon name="shield" />业务数据由团队共享管理</span><RouterLink to="/reports" class="text-link">查看月度经营分析<AppIcon name="arrow" /></RouterLink></div>
  </div>
</template>

<script setup>
import { computed } from 'vue';
import { RouterLink } from 'vue-router';
import AppIcon from '../components/AppIcon.vue';
import EmptyState from '../components/EmptyState.vue';
import SectionCard from '../components/SectionCard.vue';
import { useAppData } from '../composables/useAppData.js';
import { formatNumber } from '../utils/formatters.js';

const { state } = useAppData();
const displayName = computed(() => state.bootstrap?.user?.displayName || '工作伙伴');
const hour = new Date().getHours();
const greeting = hour < 12 ? '上午好' : hour < 18 ? '下午好' : '晚上好';
const metricIcons = ['inbound', 'outbound', 'alert', 'wallet'];
const quickLinks = [
  { to: '/price-sheets', icon: 'box', title: '维护物料', note: '规格与标准单价' },
  { to: '/outbound-orders', icon: 'outbound', title: '管理出货', note: '送货与库存联动' },
  { to: '/bills', icon: 'bill', title: '核对账单', note: '往来账款与结算' }
];
const dashboard = computed(() => state.dashboard || { summaryCards: [], warningItems: [], recentOrders: [] });
</script>
