<template>
  <div class="page-grid">
    <div class="stats-grid">
      <article class="metric-card"><p>有效应收总额</p><strong>{{ formatCurrency(totals.amount) }}</strong><span>按客户筛选，不含作废账单</span></article>
      <article class="metric-card"><p>本系统登记实收</p><strong>{{ formatCurrency(totals.receivedAmount) }}</strong><span>来自有效收款流水</span></article>
      <article class="metric-card"><p>历史结清金额</p><strong>{{ formatCurrency(totals.legacySettledAmount) }}</strong><span>升级前已结清，未补造收款流水</span></article>
      <article class="metric-card"><p>未收余额</p><strong>{{ formatCurrency(totals.balanceAmount) }}</strong><span>应收减实收及历史结清</span></article>
    </div>
    <SectionCard title="对账明细" subtitle="保留开单价格；收款后自动更新结清状态。作废账单保留记录，重启后也不会重新生成。">
      <div class="table-toolbar">
        <label class="search-field"><AppIcon name="search" /><input v-model="keyword" class="toolbar-input" placeholder="搜索客户、单号、物料或加工号" aria-label="搜索账单" /></label>
        <div class="table-toolbar-right"><RouterLink class="icon-button" :to="{ path: '/documents', query: { kind: 'statement', customerId: customerId || undefined, startDate: startDate || undefined, endDate: endDate || undefined } }"><AppIcon name="printer" />生成对账单</RouterLink><button class="icon-button" :disabled="pending" @click="exportBills"><AppIcon name="download" />导出筛选结果</button><button class="primary-button" @click="openCreate"><AppIcon name="plus" />补建账单</button></div>
      </div>
      <div class="filter-bar">
        <label>客户<el-select v-model="customerId" clearable filterable placeholder="全部客户"><el-option v-for="c in state.customers" :key="c.id" :value="c.id" :label="c.name" /></el-select></label>
        <label>账单状态<select v-model="status"><option value="active">全部有效</option><option>未结清</option><option>部分收款</option><option>已结算</option><option>已作废</option><option value="all">全部记录</option></select></label>
        <label>开始日期<input v-model="startDate" type="date" /></label><label>结束日期<input v-model="endDate" type="date" /></label><label class="inline-check"><input v-model="overdueOnly" type="checkbox" />仅看逾期</label>
      </div>
      <el-table :data="rows" row-key="id" border stripe max-height="580">
        <el-table-column type="expand" width="40"><template #default="{ row }"><div class="bill-detail-grid">
          <p><span>送货单 / 出货日期</span>{{ row.deliveryNo }} · {{ row.billDate }}</p>
          <p><span>物料 / 规格</span>{{ row.itemCode }} · {{ row.specification }}</p>
          <p><span>开单计价</span>{{ row.quantity }} × {{ formatCurrency(row.unitPrice) }} = {{ formatCurrency(row.amount) }}</p>
          <p><span>加工单号</span>{{ row.processNo || '—' }}</p>
          <p><span>历史结清金额</span>{{ formatCurrency(row.legacySettledAmount) }}</p>
          <p><span>{{ row.voidedAt ? '作废原因' : '备注' }}</span>{{ row.voidedAt ? row.voidReason : (row.remark || '—') }}</p>
        </div></template></el-table-column>
        <el-table-column label="客户 / 账单" min-width="180"><template #default="{ row }"><strong>{{ row.partner }}</strong><small class="cell-note muted-text">{{ row.billNo }}</small></template></el-table-column>
        <el-table-column label="应收金额" min-width="108"><template #default="{ row }">{{ formatCurrency(row.amount) }}</template></el-table-column>
        <el-table-column label="登记实收" min-width="108"><template #default="{ row }">{{ formatCurrency(row.receivedAmount) }}<small v-if="row.legacySettledAmount" class="cell-note muted-text">历史结清 {{ formatCurrency(row.legacySettledAmount) }}</small></template></el-table-column>
        <el-table-column label="未收余额" min-width="108"><template #default="{ row }"><strong :class="row.balanceAmount > 0 && !row.voidedAt ? 'negative-text' : 'positive-text'">{{ row.voidedAt ? '—' : formatCurrency(row.balanceAmount) }}</strong></template></el-table-column>
        <el-table-column label="到期日" width="113"><template #default="{ row }"><span :class="isOverdue(row) ? 'negative-text' : ''">{{ row.dueDate }}<small v-if="isOverdue(row)" class="cell-note">已逾期</small></span></template></el-table-column>
        <el-table-column label="状态" width="100"><template #default="{ row }"><span class="status-pill" :data-status="row.status">{{ row.status }}</span></template></el-table-column>
        <el-table-column label="操作" :fixed="wideScreen ? 'right' : false" width="200"><template #default="{ row }"><div class="table-actions bill-actions">
          <RouterLink v-if="!row.voidedAt && row.billType === '应收' && row.balanceAmount > 0" class="ghost-button" :to="`/receipts?billId=${row.id}`">收款</RouterLink>
          <button v-if="!row.voidedAt" class="ghost-button" @click="openEdit(row)">修改</button>
          <button class="ghost-button" :disabled="pending" @click="showEvents(row)">记录</button>
          <button v-if="!row.voidedAt && !row.receivedAmount && !row.legacySettledAmount" class="ghost-button delete-action" @click="openReason(row, 'void')">作废</button>
          <button v-if="row.voidedAt && !row.stockOrderVoidedAt" class="ghost-button" :disabled="pending" @click="restore(row)">恢复</button><span v-else-if="row.voidedAt" class="muted-text" title="关联出货已撤销，账单只保留记录">出货已撤销</span>
          <button v-if="row.legacySettledAmount && isAdmin" class="ghost-button delete-action" @click="openReason(row, 'legacy')">撤销历史结清</button>
        </div></template></el-table-column>
        <template #empty><EmptyState icon="bill" title="暂无匹配的账单" description="出货后会自动开立账单，也可以调整筛选条件。" /></template>
      </el-table>
      <div class="table-footer"><span>共 {{ rows.length }} 笔 · 当前筛选未收 {{ formatCurrency(rows.filter(r => !r.voidedAt).reduce((n, r) => n + r.balanceAmount, 0)) }}</span><span>修改价格不会重算旧账单</span></div>
    </SectionCard>

    <FormDialog :open="showForm" :title="form.id ? '修改账单信息' : '补建账单'" @cancel="!pending && (showForm = false)">
      <form class="form-grid" @submit.prevent="save">
        <label class="form-span-2"><span>关联出货记录</span><el-select v-model="form.stockOrderId" filterable :disabled="Boolean(form.id)" placeholder="选择未开账单的出货记录"><el-option v-for="order in availableOrders" :key="order.id" :value="order.id" :label="`${order.deliveryNo} · ${order.partner} · ${order.itemCode}`" /></el-select></label>
        <p class="form-note form-span-2" v-if="selectedSnapshot">开单数量 {{ selectedSnapshot.quantity }} × 单价 {{ formatCurrency(selectedSnapshot.unitPrice) }}，金额 {{ formatCurrency(selectedSnapshot.amount ?? selectedSnapshot.totalAmount) }}。价格与关联单据在开账后保留。</p>
        <label v-if="form.id"><span>到期日期</span><input v-model="form.dueDate" type="date" required /></label>
        <label class="form-span-2"><span>备注</span><textarea v-model.trim="form.remark" /></label>
        <p class="form-note form-span-2">结清状态由收款流水自动计算。已收款的出货记录不能再改数量或撤销。</p>
        <div class="form-actions form-span-2"><button class="primary-button" :disabled="pending">{{ pending ? '保存中…' : '保存' }}</button></div>
      </form>
    </FormDialog>
    <FormDialog :open="Boolean(reasonTarget)" :title="reasonMode === 'void' ? '作废账单' : '撤销历史结清'" @cancel="!pending && (reasonTarget = null)">
      <form class="form-grid" @submit.prevent="submitReason"><p class="form-note form-span-2">{{ reasonTarget?.billNo }} · {{ reasonTarget?.partner }}。{{ reasonMode === 'void' ? '作废后不计入应收，原单据和操作记录仍会保留。' : '撤销后对应金额重新计入未收余额，此操作会留下记录。' }}</p><label class="form-span-2"><span>原因</span><textarea v-model.trim="reason" required /></label><div class="form-actions form-span-2"><button class="danger-button" :disabled="pending">确认{{ reasonMode === 'void' ? '作废' : '撤销' }}</button></div></form>
    </FormDialog>
    <FormDialog :open="Boolean(eventTarget)" title="账单操作记录" @cancel="eventTarget = null">
      <p class="form-note">{{ eventTarget?.billNo }} · {{ eventTarget?.partner }} <span v-if="eventTarget?.voidedAt"> · 作废原因：{{ eventTarget.voidReason }}</span></p>
      <el-table :data="events" max-height="420"><el-table-column label="时间" min-width="170"><template #default="{ row }">{{ new Date(row.createdAt).toLocaleString('zh-CN') }}</template></el-table-column><el-table-column prop="action" label="操作" min-width="140" /><el-table-column prop="operator" label="操作人" width="110" /><el-table-column prop="reason" label="说明" min-width="240" /></el-table>
    </FormDialog>
  </div>
</template>

<script setup>
import { useWideScreen } from '../composables/useWideScreen.js';
const wideScreen = useWideScreen();
import { computed, reactive, ref } from 'vue';
import { FREE_OUTBOUND_TYPES } from '../../shared/businessTypes.js';
import { RouterLink, useRoute } from 'vue-router';
import SectionCard from '../components/SectionCard.vue';
import FormDialog from '../components/FormDialog.vue';
import EmptyState from '../components/EmptyState.vue';
import AppIcon from '../components/AppIcon.vue';
import { useAppData } from '../composables/useAppData.js';
import { useMutation } from '../composables/useMutation.js';
import { desktopApi } from '../lib/desktopApi.js';
import { formatCurrency, todayString } from '../utils/formatters.js';
const route = useRoute();
const { state, refreshAll } = useAppData();
const { pending, run } = useMutation();
const keyword = ref(''), status = ref('active'), customerId = ref(Number(route.query.customerId) || ''), startDate = ref(''), endDate = ref(''), overdueOnly = ref(false);
const showForm = ref(false), form = reactive({}), reasonTarget = ref(null), reasonMode = ref('void'), reason = ref(''), eventTarget = ref(null), events = ref([]);
const isAdmin = computed(() => state.bootstrap?.user?.role === 'admin');
const isOverdue = row => !row.voidedAt && row.billType === '应收' && row.balanceAmount > 0 && row.dueDate < todayString();
const customerBills = computed(() => state.bills.filter(b => !customerId.value || b.customerId === customerId.value));
const totals = computed(() => customerBills.value.filter(b => !b.voidedAt && b.billType === '应收').reduce((sum, b) => { for (const key of Object.keys(sum)) sum[key] += Number(b[key] || 0); return sum; }, { amount: 0, receivedAmount: 0, legacySettledAmount: 0, balanceAmount: 0 }));
const rows = computed(() => customerBills.value.filter(b =>
  (status.value === 'all' || (status.value === 'active' ? !b.voidedAt : b.status === status.value)) &&
  (!startDate.value || b.billDate >= startDate.value) && (!endDate.value || b.billDate <= endDate.value) && (!overdueOnly.value || isOverdue(b)) &&
  [b.billNo, b.partner, b.deliveryNo, b.itemCode, b.processNo, b.specification].join(' ').toLowerCase().includes(keyword.value.toLowerCase())));
const availableOrders = computed(() => state.stockOrders.filter(o => o.type === '出库' && !FREE_OUTBOUND_TYPES.includes(o.businessType) && (!state.bills.some(b => b.stockOrderId === o.id) || o.id === form.stockOrderId)));
const selectedSnapshot = computed(() => form.id ? state.bills.find(b => b.id === form.id) : state.stockOrders.find(o => o.id === form.stockOrderId));
function openCreate() { Object.assign(form, { id: null, stockOrderId: '', remark: '', dueDate: '' }); showForm.value = true; }
function openEdit(row) { Object.assign(form, { id: row.id, stockOrderId: row.stockOrderId, remark: row.remark, dueDate: row.dueDate }); showForm.value = true; }
function save() { return run(async () => { if (!form.stockOrderId) throw new Error('请选择出货记录'); await (form.id ? desktopApi.updateBill(form) : desktopApi.createBill(form)); showForm.value = false; await refreshAll(); }, '账单已保存'); }
function openReason(row, mode) { reasonTarget.value = row; reasonMode.value = mode; reason.value = ''; }
function submitReason() { return run(async () => { if (reasonMode.value === 'void') await desktopApi.deleteBill(reasonTarget.value.id, reason.value); else await desktopApi.clearLegacySettlement(reasonTarget.value.id, reason.value); reasonTarget.value = null; await refreshAll(); }, '账单已更新，操作记录已保存'); }
function restore(row) { return run(async () => { await desktopApi.restoreBill(row.id); await refreshAll(); }, '原账单已恢复'); }
function showEvents(row) { return run(async () => { events.value = await desktopApi.getBillEvents(row.id); eventTarget.value = row; }); }
function exportBills() { return run(() => desktopApi.exportSheet({ type: 'bills', records: rows.value }), '账单已导出'); }
</script>
