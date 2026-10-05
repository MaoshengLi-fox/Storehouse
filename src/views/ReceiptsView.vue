<template>
  <div class="page-grid">
    <div class="stats-grid stats-grid-three">
      <article class="metric-card"><p>累计登记实收</p><strong>{{ formatCurrency(actualReceived) }}</strong><span>不含作废流水和历史结清</span></article>
      <article class="metric-card"><p>待收账款</p><strong>{{ formatCurrency(outstanding) }}</strong><span>支持一张账单分次收款</span></article>
      <article class="metric-card"><p>未结清账单</p><strong>{{ availableBills.length }}</strong><span>收足金额后自动结清</span></article>
    </div>
    <SectionCard title="收款流水" subtitle="每笔收款绑定一张账单。录错时填写原因作废，再重新登记；原流水持续保留。">
      <div class="table-toolbar"><label class="search-field"><AppIcon name="search" /><input v-model="keyword" class="toolbar-input" placeholder="搜索客户、账单或银行流水号" aria-label="搜索收款" /></label><div class="table-toolbar-right"><button class="icon-button" :disabled="pending" @click="exportRows">导出筛选结果</button><button class="primary-button" @click="openForm()"><AppIcon name="plus" />登记收款</button></div></div>
      <div class="filter-bar"><label>开始日期<input v-model="startDate" type="date" /></label><label>结束日期<input v-model="endDate" type="date" /></label><label>状态<select v-model="status"><option value="active">有效收款</option><option value="void">已作废</option><option value="all">全部记录</option></select></label><label>客户<el-select v-model="customerId" clearable filterable placeholder="全部客户"><el-option v-for="c in state.customers" :key="c.id" :value="c.id" :label="c.name" /></el-select></label></div>
      <el-table :data="rows" border stripe max-height="560">
        <el-table-column type="expand" width="40"><template #default="{ row }"><div class="bill-detail-grid"><p><span>收款编号</span>{{ row.receiptNo }}</p><p><span>银行流水 / 凭证号</span>{{ row.reference || '—' }}</p><p><span>备注</span>{{ row.remark || '—' }}</p><p v-if="row.voidedAt"><span>作废原因 / 操作人</span>{{ row.voidReason }} · {{ row.voidedBy }}</p></div></template></el-table-column>
        <el-table-column prop="receiptDate" label="收款日期" width="115" /><el-table-column prop="partner" label="客户" min-width="145" />
        <el-table-column label="金额" width="120"><template #default="{ row }"><strong>{{ formatCurrency(row.amount) }}</strong></template></el-table-column><el-table-column prop="billNo" label="关联账单" min-width="170" />
        <el-table-column prop="method" label="收款方式" width="120" /><el-table-column prop="operator" label="登记人" width="110" />
        <el-table-column label="状态" width="100"><template #default="{ row }"><span class="status-pill" :data-status="row.voidedAt ? '已作废' : '已结算'">{{ row.voidedAt ? '已作废' : '有效' }}</span></template></el-table-column>
        <el-table-column label="操作" width="90" :fixed="wideScreen ? 'right' : false"><template #default="{ row }"><button v-if="!row.voidedAt" class="ghost-button delete-action" @click="voidTarget = row; reason = ''">作废</button></template></el-table-column>
        <template #empty><EmptyState icon="bill" title="暂无匹配的收款流水" description="收到客户款项后登记，账单余额将同步更新。" /></template>
      </el-table>
      <div class="table-footer"><span>共 {{ rows.length }} 笔 · 筛选内有效收款 {{ formatCurrency(rows.filter(r => !r.voidedAt).reduce((s, r) => s + r.amount, 0)) }}</span><span>历史结清金额请在对账明细查看</span></div>
    </SectionCard>
    <FormDialog :open="showForm" title="登记收款" @cancel="!pending && (showForm = false)">
      <form class="form-grid" @submit.prevent="save">
        <label class="form-span-2"><span>应收账单</span><el-select v-model="form.billId" filterable placeholder="搜索客户或账单编号"><el-option v-for="b in availableBills" :key="b.id" :value="b.id" :label="`${b.partner} · ${b.billNo} · 未收 ${formatCurrency(b.balanceAmount)}`" /></el-select></label>
        <p class="form-note form-span-2" v-if="selectedBill">送货单 {{ selectedBill.deliveryNo }} · 应收 {{ formatCurrency(selectedBill.amount) }} · 当前未收 {{ formatCurrency(selectedBill.balanceAmount) }}</p>
        <label><span>本次实收金额</span><input v-model.number="form.amount" type="number" min="0.01" :max="selectedBill?.balanceAmount" step="0.01" required /></label>
        <label><span>收款日期</span><input v-model="form.receiptDate" type="date" :min="selectedBill?.billDate" :max="todayString()" required /></label>
        <label><span>收款方式</span><select v-model="form.method"><option>银行转账</option><option>现金</option><option>微信</option><option>支付宝</option><option>其他</option></select></label><label><span>银行流水 / 凭证号</span><input v-model.trim="form.reference" /></label>
        <label class="form-span-2"><span>备注</span><textarea v-model.trim="form.remark" /></label><div class="form-actions form-span-2"><button class="primary-button" :disabled="pending">{{ pending ? '保存中…' : '确认收款' }}</button></div>
      </form>
    </FormDialog>
    <FormDialog :open="Boolean(voidTarget)" title="作废收款" @cancel="!pending && (voidTarget = null)">
      <form class="form-grid" @submit.prevent="confirmVoid"><p class="form-note form-span-2">{{ voidTarget?.receiptNo }} · {{ formatCurrency(voidTarget?.amount) }}。作废后账单未收余额将相应增加，原流水保留。</p><label class="form-span-2"><span>作废原因</span><textarea v-model.trim="reason" required /></label><div class="form-actions form-span-2"><button class="danger-button" :disabled="pending">确认作废</button></div></form>
    </FormDialog>
  </div>
</template>

<script setup>
import { useWideScreen } from '../composables/useWideScreen.js';
const wideScreen = useWideScreen();
import { computed, reactive, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import SectionCard from '../components/SectionCard.vue';
import FormDialog from '../components/FormDialog.vue';
import EmptyState from '../components/EmptyState.vue';
import AppIcon from '../components/AppIcon.vue';
import { useAppData } from '../composables/useAppData.js';
import { useMutation } from '../composables/useMutation.js';
import { desktopApi } from '../lib/desktopApi.js';
import { formatCurrency, todayString } from '../utils/formatters.js';
const { state, refreshAll } = useAppData();
const { pending, run } = useMutation();
const route = useRoute();
const keyword = ref(''), status = ref('active'), startDate = ref(''), endDate = ref(''), customerId = ref(''), showForm = ref(false), voidTarget = ref(null), reason = ref('');
const form = reactive({});
const availableBills = computed(() => state.bills.filter(b => !b.voidedAt && b.billType === '应收' && b.balanceAmount > 0));
const selectedBill = computed(() => availableBills.value.find(b => b.id === form.billId));
const actualReceived = computed(() => state.receipts.filter(r => !r.voidedAt).reduce((sum, r) => sum + r.amount, 0));
const outstanding = computed(() => availableBills.value.reduce((sum, b) => sum + b.balanceAmount, 0));
const rows = computed(() => state.receipts.filter(r => (status.value === 'all' || (status.value === 'void' ? r.voidedAt : !r.voidedAt)) &&
  (!startDate.value || r.receiptDate >= startDate.value) && (!endDate.value || r.receiptDate <= endDate.value) && (!customerId.value || customerId.value === r.customerId) &&
  [r.partner, r.billNo, r.receiptNo, r.reference].join(' ').toLowerCase().includes(keyword.value.toLowerCase())));
function openForm(bill) {
  Object.assign(form, { billId: bill?.id || '', amount: bill?.balanceAmount || '', receiptDate: todayString(), method: '银行转账', reference: '', remark: '', requestKey: crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}` }); showForm.value = true;
}
function save() { return run(async () => { if (!form.billId) throw new Error('请选择应收账单'); await desktopApi.createReceipt(form); showForm.value = false; await refreshAll(); }, '收款已登记，账单余额已更新'); }
function confirmVoid() { return run(async () => { await desktopApi.voidReceipt(voidTarget.value.id, reason.value); voidTarget.value = null; await refreshAll(); }, '收款已作废，账单余额已更新'); }
function exportRows() { return run(() => desktopApi.exportSheet({ type: 'receipts', records: rows.value }), '收款流水已导出'); }
let openedFromRoute = false;
watch(availableBills, (bills) => { const bill = bills.find(b => b.id === Number(route.query.billId)); if (bill && !openedFromRoute) { openedFromRoute = true; openForm(bill); } }, { immediate: true });
</script>
