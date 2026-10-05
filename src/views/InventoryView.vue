<template>
  <div class="page-grid">
    <div class="stats-grid stats-grid-three">
      <article class="metric-card"><p>库存物料</p><strong>{{ state.inventoryItems.length }}</strong><span>按物料编码管理</span></article>
      <article class="metric-card"><p>低于安全库存</p><strong>{{ warningCount }}</strong><span>及时安排补货或回厂</span></article>
      <article class="metric-card"><p>已设置库位</p><strong>{{ state.inventoryItems.filter(i => i.location).length }}</strong><span>快速定位存放位置</span></article>
    </div>
    <SectionCard title="库存余额" subtitle="每次库存变化都保留流水；盘点保存时会核对库存是否已被其他业务更新。">
      <div class="table-toolbar">
        <label class="search-field"><AppIcon name="search" /><input v-model="keyword" class="toolbar-input" placeholder="搜索编码、规格或库位" aria-label="搜索库存" /></label>
        <div class="table-toolbar-right"><label class="inline-check"><input v-model="onlyWarning" type="checkbox" />仅看预警</label><button class="icon-button" @click="exportRows"><AppIcon name="download" />导出余额</button></div>
      </div>
      <el-table :data="rows" border stripe max-height="470" row-key="id">
        <el-table-column prop="code" label="物料编码" min-width="150" />
        <el-table-column prop="specification" label="规格" min-width="210" show-overflow-tooltip />
        <el-table-column prop="stockQty" label="当前库存" min-width="120" sortable><template #default="{ row }"><strong :class="row.stockQty < row.safetyStock ? 'negative-text' : 'positive-text'">{{ formatNumber(row.stockQty) }}</strong> {{ row.unit }}</template></el-table-column>
        <el-table-column prop="safetyStock" label="安全库存" width="110" />
        <el-table-column prop="location" label="库位" min-width="110" />
        <el-table-column label="操作" :fixed="wideScreen ? 'right' : false" width="220"><template #default="{ row }"><div class="table-actions"><button class="ghost-button" @click="showLedger(row)">流水</button><button class="ghost-button" @click="openForm(row, 'metadata')">设置</button><button class="ghost-button" @click="openForm(row, 'count')">盘点</button></div></template></el-table-column>
        <template #empty><EmptyState icon="box" title="暂无匹配的库存" description="在辅助价目中新增物料，入库后即可查看库存。" /></template>
      </el-table>
      <div class="table-footer"><span>共 {{ rows.length }} 种物料</span><span>不同计量单位分别展示</span></div>
    </SectionCard>

    <SectionCard title="库存流水" :subtitle="ledgerItem ? `${ledgerItem.code} · ${ledgerItem.specification}` : '按登记顺序记录库存变动；结余是该次操作完成后的库存。'">
      <div class="table-toolbar"><div class="filter-bar"><label>开始日期<input v-model="startDate" type="date" /></label><label>结束日期<input v-model="endDate" type="date" /></label><button class="action-button" :disabled="pending" @click="loadLedger">查询</button><button v-if="ledgerItem" class="ghost-button" @click="ledgerItem = null; loadLedger()">查看全部物料</button></div><button class="icon-button" @click="exportLedger">导出流水</button></div>
      <el-table :data="ledger" border stripe max-height="440">
        <el-table-column prop="businessDate" label="业务日期" width="120" /><el-table-column prop="itemCode" label="物料编码" min-width="140" />
        <el-table-column prop="eventType" label="类型" width="110" /><el-table-column prop="quantityDelta" label="变动数量" width="120"><template #default="{ row }"><span :class="row.quantityDelta >= 0 ? 'positive-text' : 'negative-text'">{{ row.quantityDelta > 0 ? '+' : '' }}{{ formatNumber(row.quantityDelta) }}</span></template></el-table-column>
        <el-table-column prop="balanceAfter" label="操作后结余" width="120" /><el-table-column prop="reference" label="关联单号" min-width="150" />
        <el-table-column prop="operator" label="操作人" width="120" /><el-table-column prop="remark" label="备注 / 原因" min-width="220" show-overflow-tooltip />
        <el-table-column label="登记时间" min-width="170"><template #default="{ row }">{{ formatDateTime(row.createdAt) }}</template></el-table-column>
        <template #empty><EmptyState title="暂无库存流水" description="调整日期范围，或完成一笔出入库业务。" /></template>
      </el-table>
    </SectionCard>

    <FormDialog :open="Boolean(editing)" :title="mode === 'count' ? '库存盘点' : '库存设置'" @cancel="!pending && (editing = null)">
      <form class="form-grid" @submit.prevent="save">
        <p class="form-span-2 form-note">{{ editing?.code }} · {{ editing?.specification }}</p>
        <template v-if="mode === 'count'">
          <label><span>账面库存</span><input :value="editing?.stockQty" disabled /></label>
          <label><span>实盘数量（{{ editing?.unit }}）</span><input v-model.number="form.actualQty" type="number" min="0" step="0.000001" required /></label>
          <p class="form-note form-span-2">盘点差异：{{ formatNumber(form.actualQty - (editing?.stockQty || 0)) }}。保存后同步更新库存，保留调整记录。</p>
          <label class="form-span-2"><span>调整原因</span><textarea v-model.trim="form.reason" required placeholder="例如：月末盘点，发现漏记退料" /></label>
        </template>
        <template v-else><label><span>安全库存</span><input v-model.number="form.safetyStock" type="number" min="0" step="0.000001" required /></label><label><span>库位</span><input v-model.trim="form.location" placeholder="例如 A-01" /></label></template>
        <div class="form-actions form-span-2"><button class="primary-button" :disabled="pending">{{ pending ? '保存中…' : '保存' }}</button></div>
      </form>
    </FormDialog>
  </div>
</template>

<script setup>
import { useWideScreen } from '../composables/useWideScreen.js';
const wideScreen = useWideScreen();
import { computed, onMounted, reactive, ref, watch } from 'vue';
import SectionCard from '../components/SectionCard.vue';
import FormDialog from '../components/FormDialog.vue';
import EmptyState from '../components/EmptyState.vue';
import AppIcon from '../components/AppIcon.vue';
import { useAppData } from '../composables/useAppData.js';
import { useMutation } from '../composables/useMutation.js';
import { desktopApi } from '../lib/desktopApi.js';
import { formatDateTime, formatNumber } from '../utils/formatters.js';

const { state, refreshAll } = useAppData();
const { pending, run } = useMutation();
const keyword = ref(''), onlyWarning = ref(false), ledger = ref([]), ledgerItem = ref(null), startDate = ref(''), endDate = ref('');
const editing = ref(null), mode = ref('metadata');
const form = reactive({ safetyStock: 0, location: '', actualQty: 0, reason: '' });
const warningCount = computed(() => state.inventoryItems.filter(i => i.stockQty < i.safetyStock).length);
const rows = computed(() => state.inventoryItems.filter(i => (!onlyWarning.value || i.stockQty < i.safetyStock) &&
  [i.code, i.specification, i.location].join(' ').toLowerCase().includes(keyword.value.toLowerCase())));
async function fetchLedger() { ledger.value = await desktopApi.getInventoryLedger({ itemId: ledgerItem.value?.id, startDate: startDate.value, endDate: endDate.value }); }
const loadLedger = () => run(fetchLedger);
function showLedger(item) { ledgerItem.value = item; loadLedger(); }
function openForm(item, type) {
  editing.value = { ...item }; mode.value = type;
  Object.assign(form, { safetyStock: item.safetyStock, location: item.location, actualQty: item.stockQty, reason: '' });
}
async function save() {
  await run(async () => {
    if (mode.value === 'count') await desktopApi.adjustInventory({ itemId: editing.value.id, expectedStockQty: editing.value.stockQty, actualQty: form.actualQty, reason: form.reason });
    else await desktopApi.updateInventoryItem({ id: editing.value.id, safetyStock: form.safetyStock, location: form.location });
    editing.value = null;
    await refreshAll(); await fetchLedger();
  }, '库存已更新，流水已保存');
}
const exportRows = () => run(() => desktopApi.exportSheet({ type: 'inventory', records: rows.value }), '库存余额已导出');
const exportLedger = () => run(() => desktopApi.exportSheet({ type: 'inventoryLedger', records: ledger.value }), '库存流水已导出');
onMounted(loadLedger);
watch(() => state.inventoryItems, loadLedger);
</script>
