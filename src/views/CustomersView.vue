<template>
  <div class="page-grid">
    <div class="stats-grid stats-grid-three">
      <article class="metric-card"><p>启用中的客户</p><strong>{{ state.customers.filter(c => c.isActive).length }}</strong><span>统一维护客户名称与联系方式</span></article>
      <article class="metric-card"><p>客户未收余额</p><strong>{{ formatCurrency(totalBalance) }}</strong><span>扣除有效收款和历史结清金额</span></article>
      <article class="metric-card"><p>有欠款的客户</p><strong>{{ state.customers.filter(c => c.balanceAmount > 0).length }}</strong><span>可进入对账明细跟进</span></article>
    </div>
    <ConfirmDialog
      :open="Boolean(pendingToggle)"
      title="确认停用客户"
      confirm-label="确认停用"
      :message="pendingToggle ? `停用后「${pendingToggle.name}」不能再开新单，但历史单据仍可查询、对账和收款。可随时重新启用。` : ''"
      @cancel="pendingToggle = null"
      @confirm="confirmToggle"
    />
    <SectionCard title="客户档案" subtitle="修改名称和账期只影响后续开单；历史单据保留原名称和到期日。停用后仍可查询和收款。">
      <div class="table-toolbar"><label class="search-field"><AppIcon name="search" /><input v-model="keyword" class="toolbar-input" placeholder="搜索客户、联系人或电话" aria-label="搜索客户" /></label><button class="primary-button" @click="openForm()"><AppIcon name="plus" />新增客户</button></div>
      <el-table :data="rows" border stripe max-height="560">
        <el-table-column prop="name" label="客户名称" min-width="170" /><el-table-column prop="contact" label="联系人" width="120" /><el-table-column prop="phone" label="电话" min-width="150" />
        <el-table-column prop="settlementDays" label="账期（天）" width="110" /><el-table-column label="累计应收" min-width="130"><template #default="{ row }">{{ formatCurrency(row.totalAmount) }}</template></el-table-column>
        <el-table-column label="未收余额" min-width="130"><template #default="{ row }"><strong :class="row.balanceAmount > 0 ? 'negative-text' : 'positive-text'">{{ formatCurrency(row.balanceAmount) }}</strong></template></el-table-column>
        <el-table-column label="状态" width="100"><template #default="{ row }"><span class="status-pill" :data-status="row.isActive ? '已结算' : '已作废'">{{ row.isActive ? '启用' : '停用' }}</span></template></el-table-column>
        <el-table-column label="操作" width="200" :fixed="wideScreen ? 'right' : false"><template #default="{ row }"><div class="table-actions"><button class="ghost-button" @click="openForm(row)">修改</button><RouterLink class="ghost-button" :to="`/bills?customerId=${row.id}`">对账</RouterLink><button class="ghost-button" :disabled="pending" @click="toggleCustomer(row)">{{ row.isActive ? '停用' : '启用' }}</button></div></template></el-table-column>
        <template #empty><EmptyState icon="users" title="暂无匹配的客户" description="新增客户后，出入库开单即可选择客户档案。" /></template>
      </el-table>
      <div class="table-footer"><span>共 {{ rows.length }} 位客户</span><span>历史业务中的往来名称已归入档案，联系方式可继续补全</span></div>
    </SectionCard>
    <FormDialog :open="showForm" :title="form.id ? '修改客户档案' : '新增客户'" @cancel="!pending && (showForm = false)">
      <form class="form-grid" @submit.prevent="save">
        <label><span>客户名称</span><input v-model.trim="form.name" required maxlength="120" /></label><label><span>联系人</span><input v-model.trim="form.contact" /></label>
        <label><span>联系电话</span><input v-model.trim="form.phone" type="tel" /></label><label><span>结算账期（天）</span><input v-model.number="form.settlementDays" type="number" min="0" max="3650" step="1" required /></label>
        <label class="form-span-2"><span>地址</span><input v-model.trim="form.address" /></label><label class="form-span-2"><span>备注</span><textarea v-model.trim="form.remark" /></label>
        <p class="form-note form-span-2">新账单的到期日 = 出货日期 + 账期天数。0 天表示当天到期。</p>
        <div class="form-actions form-span-2"><button class="primary-button" :disabled="pending">{{ pending ? '保存中…' : '保存客户' }}</button></div>
      </form>
    </FormDialog>
  </div>
</template>

<script setup>
import { useWideScreen } from '../composables/useWideScreen.js';
const wideScreen = useWideScreen();
import { computed, reactive, ref } from 'vue';
import { RouterLink } from 'vue-router';
import SectionCard from '../components/SectionCard.vue';
import FormDialog from '../components/FormDialog.vue';
import ConfirmDialog from '../components/ConfirmDialog.vue';
import EmptyState from '../components/EmptyState.vue';
import AppIcon from '../components/AppIcon.vue';
import { useAppData } from '../composables/useAppData.js';
import { useMutation } from '../composables/useMutation.js';
import { desktopApi } from '../lib/desktopApi.js';
import { formatCurrency } from '../utils/formatters.js';
const { state, refreshAll } = useAppData();
const { pending, run } = useMutation();
const keyword = ref(''), showForm = ref(false), pendingToggle = ref(null);
const form = reactive({});
const rows = computed(() => state.customers.filter(c => [c.name, c.contact, c.phone].join(' ').toLowerCase().includes(keyword.value.toLowerCase())));
const totalBalance = computed(() => state.customers.reduce((sum, c) => sum + c.balanceAmount, 0));
function openForm(row) { Object.assign(form, { id: null, name: '', contact: '', phone: '', address: '', settlementDays: 30, remark: '' }, row || {}); showForm.value = true; }
function save() { return run(async () => { await (form.id ? desktopApi.updateCustomer(form) : desktopApi.createCustomer(form)); showForm.value = false; await refreshAll(); }, '客户档案已保存'); }
function setCustomerActive(row, isActive) { return run(async () => { await desktopApi.updateCustomer({ id: row.id, isActive }); await refreshAll(); }, isActive ? '客户已启用' : '客户已停用'); }
function toggleCustomer(row) { if (row.isActive) pendingToggle.value = row; else setCustomerActive(row, true); }
function confirmToggle() { const row = pendingToggle.value; pendingToggle.value = null; if (row) setCustomerActive(row, false); }
</script>
