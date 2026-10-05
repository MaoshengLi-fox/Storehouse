<template>
  <div class="page-grid reports-page">
    <div class="stats-grid stats-grid-three">
      <article v-for="item in totals" :key="item.label" class="metric-card" :data-tone="item.tone"><div class="metric-top"><p>{{ item.label }}</p><span class="metric-icon"><AppIcon :name="item.icon" /></span></div><strong>{{ item.money ? formatCurrency(item.value) : formatNumber(item.value) }}</strong><span>{{ item.hint }}</span></article>
    </div>
    <SectionCard title="月度出货金额" subtitle="最近 6 个有记录月份的成品出货金额；入库、退胚和返工出货不计金额">
      <template #action><div class="chart-legend"><span><i class="outbound-legend"></i>出货金额</span></div></template>
      <div v-if="recentMonths.length" class="trend-chart">
        <div class="chart-axis"><span v-for="ratio in [1, .75, .5, .25, 0]" :key="ratio">¥{{ formatNumber(maxAmount * ratio) }}</span></div>
        <div class="chart-plot">
          <div class="chart-gridlines" aria-hidden="true"><i v-for="n in 5" :key="n"></i></div>
          <div v-for="item in recentMonths" :key="item.month" class="chart-month" :aria-label="`${item.month}：出货 ${item.outboundAmount} 元`">
            <div class="chart-columns"><div class="chart-column outbound-column" :style="{ height: `${(item.outboundAmount / maxAmount) * 100}%` }" :title="`出货 ${formatCurrency(item.outboundAmount)}`"></div></div>
            <span class="chart-month-label">{{ item.month }}</span>
          </div>
        </div>
      </div>
      <EmptyState v-else icon="chart" title="经营趋势等待第一笔记录" description="开始录入出入库单据后，月度业务趋势会自动汇总。" />
    </SectionCard>

    <SectionCard title="月度业务汇总" subtitle="按业务类型标签分别统计数量；数量按各物料自身单位直接相加，仅供参考">
      <el-table :data="[...continuousMonths].reverse()" stripe style="width: 100%">
        <el-table-column prop="month" label="月份" min-width="100" fixed />
        <el-table-column label="出货金额" min-width="130" align="right"><template #default="{ row }">{{ formatCurrency(row.outboundAmount) }}</template></el-table-column>
        <el-table-column v-for="label in quantityLabels" :key="label" :label="label" min-width="100" align="right"><template #default="{ row }">{{ formatNumber(row.quantities?.[label] || 0) }}</template></el-table-column>
        <template #empty><EmptyState icon="bill" title="暂无月度汇总" description="汇总基于已录入的业务单据自动生成。" /></template>
      </el-table>
    </SectionCard>
    <div class="report-notes"><div><AppIcon name="users" /><div><strong>团队共享，同步协作</strong><p>所有成员使用同一套业务数据，点击刷新查看最新记录。</p></div></div><div><AppIcon name="shield" /><div><strong>保留开单价，历史账目清晰</strong><p>调整价目不会改变历史账单，结算按账单保存金额汇总。</p></div></div></div>
  </div>
</template>

<script setup>
import { computed } from 'vue';
import SectionCard from '../components/SectionCard.vue';
import AppIcon from '../components/AppIcon.vue';
import EmptyState from '../components/EmptyState.vue';
import { useAppData } from '../composables/useAppData.js';
import { formatCurrency, formatNumber } from '../utils/formatters.js';
import { INBOUND_TYPES, OUTBOUND_TYPES, RECEIPT_TYPES } from '../../shared/businessTypes.js';

const { state } = useAppData();

const monthlyTrend = computed(() => state.dashboard?.monthlyTrend || []);
// Months without any record are shown as 0 so the trend keeps a continuous time axis.
function nextMonth(month) {
  const [year, value] = month.split('-').map(Number);
  return value === 12 ? `${year + 1}-01` : `${year}-${String(value + 1).padStart(2, '0')}`;
}
const continuousMonths = computed(() => {
  const list = monthlyTrend.value;
  if (!list.length) return [];
  const byMonth = new Map(list.map((item) => [item.month, item]));
  const result = [];
  for (let month = list[0].month; month <= list.at(-1).month && result.length < 240; month = nextMonth(month)) {
    result.push(byMonth.get(month) || { month, outboundAmount: 0, quantities: {} });
  }
  return result;
});
const recentMonths = computed(() => continuousMonths.value.slice(-6));
// Round the axis maximum up to a "nice" number (1, 2, 2.5, 5 × 10ⁿ) so tick labels are readable.
const maxAmount = computed(() => {
  const peak = Math.max(...recentMonths.value.map((item) => Number(item.outboundAmount || 0)), 1);
  const magnitude = 10 ** Math.floor(Math.log10(peak));
  const step = [1, 2, 2.5, 5, 10].find((factor) => factor * magnitude >= peak);
  return step * magnitude;
});
// Fixed labels first; any legacy label still stored on old records is appended so nothing is hidden.
const quantityLabels = computed(() => {
  const labels = [...INBOUND_TYPES, ...OUTBOUND_TYPES];
  for (const month of monthlyTrend.value) for (const label of Object.keys(month.quantities || {})) if (!labels.includes(label)) labels.push(label);
  return labels;
});
const sumQuantity = (labels) => monthlyTrend.value.reduce((sum, month) => sum + labels.reduce((s, label) => s + Number(month.quantities?.[label] || 0), 0), 0);
const totals = computed(() => [
  { label: '累计出货金额', value: monthlyTrend.value.reduce((sum, item) => sum + Number(item.outboundAmount || 0), 0), money: true, hint: '成品出货开单金额累计', icon: 'outbound', tone: 'blue' },
  { label: '累计收货数量', value: sumQuantity(RECEIPT_TYPES), hint: '正常入库 + 退胚回库', icon: 'inbound', tone: 'green' },
  { label: '累计退胚 / 返工出货', value: sumQuantity(['退胚', '返工出货']), hint: '免费出库数量合计', icon: 'chart', tone: 'amber' }
]);
</script>
