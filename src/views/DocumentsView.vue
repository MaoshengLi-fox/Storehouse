<template>
  <div class="page-grid documents-view">
    <SectionCard title="生成客户单据" subtitle="选择客户和日期，核对明细后按原表版式打印。">
      <div class="document-kind-tabs" role="group" aria-label="单据类型"><button v-for="(label, key) in DOCUMENT_KINDS" :key="key" :class="{ active: kind === key }" :aria-pressed="kind === key" @click="kind = key"><AppIcon :name="key === 'statement' ? 'bill' : 'printer'" />{{ label }}</button></div>
      <form class="document-query" @submit.prevent="queryRows">
        <label class="document-customer"><span>客户</span><el-select v-model="customerId" filterable placeholder="请选择客户"><el-option v-for="c in state.customers" :key="c.id" :value="c.id" :label="c.name + (c.isActive ? '' : '（已停用）')" /></el-select></label>
        <label><span>快捷月份</span><input v-model="month" type="month" aria-label="快捷月份" @change="useMonth" /></label>
        <label><span>开始日期</span><input v-model="startDate" type="date" required aria-label="开始日期" /></label>
        <label><span>结束日期</span><input v-model="endDate" type="date" required aria-label="结束日期" /></label>
        <button class="primary-button" :disabled="pending || !customerId"><AppIcon name="search" />{{ pending ? '处理中…' : '查询明细' }}</button>
      </form>
      <p class="form-note">{{ kind === 'statement' ? '按送货日期筛选有效账单，包含已结算记录，金额保留开单价。' : kind === 'blank-return' ? '仅包含退胚记录。按客户、退货日期和单号分单，不计加工费。' : '包含成品出货和返工出货记录。同一客户、出货日期、送货单号和类型的明细合并为一张单据，返工出货单标题注明“返工”。' }}</p>
    </SectionCard>

    <SectionCard v-if="result" :title="`${result.customer.name} · ${DOCUMENT_KINDS[kind]}`" :subtitle="`${result.startDate} 至 ${result.endDate}`">
      <p v-for="warning in result.warnings" :key="warning" class="document-warning" role="status"><AppIcon name="alert" />{{ warning }}</p>
      <div class="table-toolbar"><span>共 {{ result.rows.length }} 条 · 已选 {{ selected.length }} 条<span v-if="kind === 'statement'"> · 选中金额 <strong>{{ formatCurrency(selectedAmount) }}</strong></span></span><div class="table-toolbar-right"><button class="action-button" @click="selectAll">全选</button><button class="action-button" @click="selected = []">清空选择</button><button class="primary-button" :disabled="pending || !selected.length" @click="generate"><AppIcon name="printer" />生成打印预览</button></div></div>
      <el-table ref="table" :data="result.rows" row-key="id" border stripe max-height="420">
        <el-table-column width="46"><template #header><input type="checkbox" aria-label="选择全部明细" :checked="selected.length > 0 && selected.length === result.rows.length" @change="selected.length === result.rows.length ? selected = [] : selectAll()" /></template><template #default="{ row }"><input v-model="selected" type="checkbox" :value="row.id" :aria-label="`选择 ${row.deliveryNo} ${row.itemCode}`" /></template></el-table-column>
        <el-table-column prop="orderDate" label="业务日期" width="112" /><el-table-column prop="deliveryNo" label="单号" min-width="135" /><el-table-column prop="processNo" label="加工单号" min-width="115" /><el-table-column prop="itemCode" label="物料编码" min-width="140" /><el-table-column prop="specification" label="品名规格" min-width="230" /><el-table-column prop="plating" label="镀种" width="95" />
        <el-table-column label="数量" min-width="95"><template #default="{ row }">{{ formatNumber(row.quantity) }} {{ row.unit }}</template></el-table-column>
        <el-table-column v-if="kind === 'statement'" label="开单单价" width="105"><template #default="{ row }">{{ formatNumber(row.unitPrice) }}</template></el-table-column><el-table-column v-if="kind === 'statement'" label="金额" width="112"><template #default="{ row }">{{ formatCurrency(row.amount) }}</template></el-table-column>
        <template #empty><EmptyState icon="printer" title="该时间内没有匹配的记录" description="请调整日期或单据类型；对账单需要先有有效账单。" /></template>
      </el-table>
    </SectionCard>

    <SectionCard title="纸张与打印设置" subtitle="连续纸按撕线后的单张尺寸设置，所有尺寸单位为毫米。">
      <div class="print-controls">
        <label class="paper-select"><span>纸张规格</span><select v-model="paper.preset" aria-label="纸张规格"><option v-for="p in PAPER_PRESETS" :key="p.id" :value="p.id">{{ p.label }}</option><option value="custom">自定义纸张尺寸</option></select></label>
        <template v-if="paper.preset === 'custom'"><label><span>纸宽 mm</span><input v-model.number="paper.width" type="number" min="120" max="420" step="0.1" /></label><label><span>纸高 mm</span><input v-model.number="paper.height" type="number" min="80" max="600" step="0.1" /></label></template>
        <label><span>页边距 mm</span><input v-model.number="paper.margin" type="number" min="0" max="20" step="0.5" aria-label="页边距 mm" /></label>
        <label><span>制表人</span><input v-model.trim="preparedBy" maxlength="80" aria-label="制表人" /></label>
        <label><span>制单日期</span><input v-model="issuedDate" type="date" required aria-label="制单日期" /></label>
        <button v-if="isAdmin" class="action-button" @click="editSettings">修改公司抬头</button>
      </div>
      <p v-if="paperError" class="field-warning">{{ paperError }}</p>
      <p class="form-note">打印时在驱动中选择相同纸张，缩放设为 100%，关闭浏览器页眉页脚。纸张设置会保存在当前浏览器。</p>
    </SectionCard>

    <section v-if="preview && !paperError" class="print-result">
      <p v-if="preview.partial" class="document-warning">当前预览仅包含勾选明细，合计以所选记录为准。</p>
      <div class="table-toolbar"><span>{{ preview.customer.name }} · {{ preview.rows.length }} 条 · {{ preview.groups.length }} 张单据</span><button class="icon-button" :disabled="pending" @click="exportDocument"><AppIcon name="download" />导出 Excel</button></div>
      <DocumentPreview :document="preview" :paper="validPaper" />
    </section>

    <FormDialog :open="showSettings" title="公司抬头与单据说明" @cancel="showSettings = false">
      <form class="form-grid" @submit.prevent="saveSettings"><label class="form-span-2"><span>公司名称</span><input v-model.trim="settings.companyName" maxlength="150" required /></label><label class="form-span-2"><span>地址</span><input v-model.trim="settings.address" maxlength="150" /></label><label><span>联系电话</span><input v-model.trim="settings.phone" maxlength="150" /></label><label><span>邮箱</span><input v-model.trim="settings.email" maxlength="150" /></label><label><span>传真</span><input v-model.trim="settings.fax" maxlength="150" /></label><label class="form-span-2"><span>对账单说明</span><textarea v-model="settings.statementNote" maxlength="1500" rows="3" /></label><label class="form-span-2"><span>出货 / 退胚单说明</span><textarea v-model="settings.deliveryNote" maxlength="1500" rows="5" /></label><div class="form-actions form-span-2"><button class="primary-button" :disabled="pending">保存公司抬头</button></div></form>
    </FormDialog>
  </div>
</template>

<script setup>
import { computed, nextTick, onMounted, reactive, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import SectionCard from '../components/SectionCard.vue';
import FormDialog from '../components/FormDialog.vue';
import EmptyState from '../components/EmptyState.vue';
import AppIcon from '../components/AppIcon.vue';
import DocumentPreview from '../components/DocumentPreview.vue';
import { useAppData } from '../composables/useAppData.js';
import { useMutation } from '../composables/useMutation.js';
import { desktopApi } from '../lib/desktopApi.js';
import { todayString, formatCurrency, formatNumber } from '../utils/formatters.js';
import { DOCUMENT_KINDS, PAPER_PRESETS, normalizePaper } from '../../shared/documents.js';

const route = useRoute(), { state } = useAppData(), { pending, run } = useMutation();
const kind = ref(Object.hasOwn(DOCUMENT_KINDS, route.query.kind) ? route.query.kind : 'statement');
const customerId = ref(Number(route.query.customerId) || ''), month = ref(todayString().slice(0, 7));
const startDate = ref(route.query.startDate || `${month.value}-01`), endDate = ref(route.query.endDate || todayString());
const issuedDate = ref(todayString()), preparedBy = ref(state.bootstrap?.user?.displayName || '');
const result = ref(null), preview = ref(null), selected = ref([]), showSettings = ref(false), settings = reactive({});
const paper = reactive(readPaper()), paperError = ref('');
const validPaper = computed(() => { try { return normalizePaper(paper, kind.value); } catch { return null; } });
const isAdmin = computed(() => state.bootstrap?.user?.role === 'admin');
const selectedAmount = computed(() => (result.value?.rows || []).filter(r => selected.value.includes(r.id)).reduce((n, r) => n + Math.round(r.amount * 100), 0) / 100);
function readPaper() { try { return normalizePaper(JSON.parse(localStorage.getItem(`factory_paper_${kind.value}`) || '{}'), kind.value); } catch { return normalizePaper({}, kind.value); } }
watch(paper, () => { try { const value = normalizePaper(paper, kind.value); paperError.value = ''; localStorage.setItem(`factory_paper_${kind.value}`, JSON.stringify(value)); } catch (e) { paperError.value = e.message; } });
watch(kind, () => { Object.assign(paper, readPaper()); });
watch([kind, customerId, startDate, endDate], () => { result.value = null; preview.value = null; selected.value = []; });
watch([issuedDate, preparedBy, selected], () => { preview.value = null; }, { deep: true });
watch(() => state.bootstrap, () => { if (!preparedBy.value) preparedBy.value = state.bootstrap?.user?.displayName || ''; });
function useMonth() { if (!/^\d{4}-\d{2}$/.test(month.value)) return; startDate.value = `${month.value}-01`; const date = new Date(`${month.value}-01T00:00:00Z`); date.setUTCMonth(date.getUTCMonth() + 1, 0); endDate.value = date.toISOString().slice(0, 10); }
function payload() { return { kind: kind.value, customerId: Number(customerId.value), startDate: startDate.value, endDate: endDate.value, issuedDate: issuedDate.value, preparedBy: preparedBy.value }; }
function selectAll() { selected.value = result.value?.rows.map(r => r.id) || []; }
function queryRows(ids) { return run(async () => { preview.value = null; result.value = null; selected.value = []; const data = await desktopApi.generateDocument({ ...payload(), ...(Array.isArray(ids) ? { orderIds: ids } : {}) }); result.value = data; selectAll(); }); }
function generate() { return run(async () => { if (!selected.value.length) throw new Error('请先勾选明细'); if (paperError.value) throw new Error(paperError.value); preview.value = await desktopApi.generateDocument({ ...payload(), orderIds: [...selected.value] }); }); }
function editSettings() { return run(async () => { Object.assign(settings, await desktopApi.getPrintSettings()); showSettings.value = true; }); }
function saveSettings() { return run(async () => { await desktopApi.updatePrintSettings(settings); showSettings.value = false; preview.value = null; }, '公司抬头已保存，请重新生成预览'); }
function exportDocument() { return run(() => desktopApi.exportDocument({ ...payload(), orderIds: preview.value.rows.map(r => r.id), paper: validPaper.value }), 'Excel 已导出'); }
onMounted(async () => {
  if (!route.query.ids || !customerId.value) return;
  const ids = String(route.query.ids).split(',').map(Number);
  await nextTick();
  await queryRows(ids);
});
</script>
