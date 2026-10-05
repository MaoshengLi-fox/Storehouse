<template>
  <div class="page-grid page-grid-fill">
    <ConfirmDialog
      :open="Boolean(pendingDeleteId)"
      title="确认撤销出货明细"
      confirm-label="确认撤销"
      :message="deleteMessage"
      @cancel="pendingDeleteId = null"
      @confirm="confirmDelete"
    />
    <FormDialog
      :open="showFormDialog"
      :title="editingId ? '修改出库明细' : '新增出库明细'"
      @cancel="closeFormDialog"
    >
      <form class="form-grid" @submit.prevent="submitOrder">
        <label><span>业务类型</span><select v-model="form.businessType" :disabled="Boolean(editingId)" @change="onBusinessTypeChange"><option v-for="type in OUTBOUND_TYPES" :key="type">{{ type }}</option></select></label>
        <label><span>客户 <em class="required-mark">*</em></span><el-select v-model="form.customerId" filterable placeholder="选择客户档案" :disabled="Boolean(editingId)" @change="selectCustomer"><el-option v-for="customer in customerOptions" :key="customer.id" :value="customer.id" :label="customer.name" /></el-select></label>
        <label v-if="isFreeForm">
          <span>{{ form.businessType === '退胚' ? '原收货批次（加工单号）' : '原退货批次（加工单号）' }}</span>
          <el-select :model-value="selectedBatchKey" :disabled="Boolean(editingId) || !form.customerId" filterable :placeholder="form.customerId ? (batchOptions.length ? '选择批次' : '该客户没有可用批次') : '请先选择客户'" @change="applyBatch">
            <el-option v-for="batch in batchOptions" :key="batch.key" :value="batch.key" :label="`${batch.processNo} · ${batch.itemCode} · 可用 ${formatNumber(batch.available)}${batch.unit || ''}`" />
          </el-select>
        </label>
        <label v-else>
          <span>加工单号</span>
          <el-select
            v-model="form.processNo"
            :disabled="Boolean(editingId)"
            filterable
            clearable
            allow-create
            :reserve-keyword="false"
            placeholder="输入查询后选择，或直接下拉选择"
            @change="handleProcessNoChange"
            @update:model-value="handleProcessNoModelUpdate"
          >
            <el-option v-for="option in processNoOptions" :key="option" :label="option" :value="option" />
          </el-select>
        </label>
        <label><span>业务日期</span><input v-model="form.orderDate" type="date" required /><small v-if="form.orderDate > todayString()" class="field-warning">业务日期晚于今天，请确认</small></label>
        <label>
          <span>{{ form.businessType === '退胚' ? '退胚单号' : '送货单号' }}</span>
          <input v-model.trim="form.deliveryNo" type="text" required :disabled="deliveryNoAutoMode" :placeholder="deliveryNoAutoMode ? '自动递增生成' : ''" />
        </label>
        <label><span>委外单号</span><el-input :model-value="form.outsourceNo" disabled /></label>
        <label>
          <span>物料</span>
          <el-select :model-value="form.itemId" filterable :disabled="Boolean(editingId) || isFreeForm" placeholder="选择物料，或通过加工单号带入" @change="applyMaterialById"><el-option v-for="item in materialOptions" :key="item.id" :value="String(item.id)" :label="`${item.code} · ${item.specification}`" /></el-select>
        </label>
        <label><span>镀种</span><el-input :model-value="form.plating" disabled /></label>
        <label>
          <span>{{ form.businessType === '退胚' ? '退胚数量' : '送货数量' }}</span>
          <input v-model.number="form.quantity" type="number" min="0" step="any" required />
          <small v-if="stockLimitWarning" class="field-warning">{{ stockLimitWarning }}</small>
        </label>
        <label><span>单价</span><el-input :model-value="unitPriceDisplay" disabled /></label>
        <label><span>制表人 <em class="required-mark">*</em></span><input v-model.trim="form.operator" type="text" required /></label>
        <p v-if="form.businessType === '退胚'" class="form-note form-span-2">退胚是把收到的胚料原样退回客户：按数量扣减库存，不计加工费，不生成账单；数量不能超过该批次“收货 − 成品出货 − 已退胚”。保存后可用退胚单模板打印。</p>
        <p v-if="form.businessType === '返工出货'" class="form-note form-span-2">返工出货是把客户退回的不良品返工后送回：扣减库存，免费、不生成账单；数量不能超过该批次“不良退回 − 已返工出货”。打印时使用出货单并标注“返工”。</p>
        <p v-if="isFreeForm && selectedBatch" class="form-note form-span-2">{{ batchSummaryText }}</p>
        <label class="form-span-2"><span>备注</span><input v-model.trim="form.remark" type="text" /></label>
        <div class="form-actions form-span-2">
          <button class="primary-button" type="submit" :disabled="saving">{{ saving ? '保存中…' : editingId ? '保存修改' : '保存明细' }}</button>
        </div>
      </form>
    </FormDialog>

    <SectionCard title="出货与退胚" subtitle="成品出货自动开账；退胚、返工出货免费且须对应原批次，支持按原表版式选择打印。">
      <div class="table-toolbar">
        <div class="table-toolbar-left">
          <label class="search-field"><AppIcon name="search" /><input v-model.trim="keyword" class="toolbar-input" type="text" placeholder="搜索客户、加工单号、物料、镀种、送货单号、委外单号" aria-label="搜索客户、加工单号、物料、镀种、送货单号、委外单号" /></label>
        </div>
        <div class="table-toolbar-right">
          <button class="icon-button" type="button" @click="printOrders(selectedRows)"><AppIcon name="printer" />打印所选</button>
          <button class="icon-button" type="button" @click="exportOrders"><AppIcon name="download" />导出</button>
          <button class="icon-button icon-button-primary" type="button" @click="openCreateDialog"><AppIcon name="plus" />新增</button>
        </div>
      </div>
      <div class="filter-bar"><label>业务类型<select v-model="businessFilter"><option value="">全部</option><option v-for="type in OUTBOUND_TYPES" :key="type">{{ type }}</option></select></label><label>客户<el-select v-model="filterCustomer" clearable filterable placeholder="全部客户"><el-option v-for="c in state.customers" :key="c.id" :value="c.id" :label="c.name" /></el-select></label><label>开始日期<input v-model="startDate" type="date" /></label><label>结束日期<input v-model="endDate" type="date" /></label></div>
      <div class="table-scroll">
        <el-table ref="ordersTable" :data="visibleOrders" row-key="id" border stripe style="width: 100%" height="100%" @selection-change="onSelectionChange" @filter-change="ordersTable?.clearSelection()">
          <el-table-column type="selection" width="44" />
          <el-table-column prop="orderDate" label="送货日期" sortable width="108" />
          <el-table-column prop="businessType" label="类型" width="86" />
          <el-table-column
            prop="partner"
            label="客户"
            sortable
            min-width="110"
            show-overflow-tooltip
            :filters="vendorFilters"
            :filter-method="filterVendor"
            filter-placement="bottom-end"
          />
          <el-table-column prop="processNo" label="加工单号" sortable min-width="105" show-overflow-tooltip />
          <el-table-column prop="itemCode" label="物料编码" sortable min-width="105" show-overflow-tooltip />
          <el-table-column prop="specification" label="品名规格" sortable min-width="140" show-overflow-tooltip />
          <el-table-column label="送货数量" sortable :sort-method="(a, b) => a.quantity - b.quantity" width="110" align="right">
            <template #default="{ row }">{{ formatNumber(row.quantity) }} {{ row.unit }}</template>
          </el-table-column>
          <el-table-column label="金额" width="100" align="right">
            <template #default="{ row }">{{ row.businessType === '成品出货' ? formatCurrency(row.totalAmount) : '免费' }}</template>
          </el-table-column>
          <el-table-column prop="deliveryNo" label="送货单号" sortable min-width="120" show-overflow-tooltip />
          <el-table-column
            prop="plating"
            label="镀种"
            sortable
            min-width="100"
            show-overflow-tooltip
            :filters="platingFilters"
            :filter-method="filterPlating"
            filter-placement="bottom-end"
          />
          <el-table-column prop="outsourceNo" label="委外单号" sortable min-width="110" show-overflow-tooltip />
          <el-table-column label="操作" :fixed="wideScreen ? 'right' : false" width="168">
            <template #default="{ row }">
              <div class="table-actions">
                <button class="ghost-button" type="button" @click="printOrders([row])">打印</button>
                <button class="ghost-button" type="button" @click="startEdit(row)">修改</button>
                <button class="ghost-button delete-action" type="button" @click="pendingDeleteId = row.id">撤销</button>
              </div>
            </template>
          </el-table-column>
          <template #empty><EmptyState icon="outbound" :title="keyword ? '没有找到相关记录' : '暂无出货记录'" description="可以调整搜索条件，或新增记录开始使用。" /></template>
        </el-table>
      </div>
      <div class="table-footer"><span>共 {{ visibleOrders.length }} 条记录<span v-if="selectedRows.length"> · 已选择 {{ selectedRows.length }} 条</span></span><span>勾选同一客户、同一类型的明细后可打印</span></div>
    </SectionCard>
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import ConfirmDialog from '../components/ConfirmDialog.vue';
import FormDialog from '../components/FormDialog.vue';
import SectionCard from '../components/SectionCard.vue';
import AppIcon from '../components/AppIcon.vue';
import EmptyState from '../components/EmptyState.vue';
import { useAppData } from '../composables/useAppData.js';
import { useNotifier } from '../composables/useNotifier.js';
import { useViewState } from '../composables/useViewState.js';
import { useWideScreen } from '../composables/useWideScreen.js';
import { desktopApi } from '../lib/desktopApi.js';
import { priceAtDate } from '../utils/pricing.js';
import { checkQuantity, formatCurrency, formatNumber, todayString } from '../utils/formatters.js';
import { OUTBOUND_TYPES, FREE_OUTBOUND_TYPES, batchKey, summarizeBatch } from '../../shared/businessTypes.js';

const { state, refreshAll } = useAppData();
const { notifyError, notifyInfo, notifySuccess } = useNotifier();
const orderType = '出库';
const router = useRouter();
const ordersTable = ref(null), businessFilter = ref(''), filterCustomer = ref(''), startDate = ref(''), endDate = ref(''), saving = ref(false);
const pageState = useViewState('outbound');
const wideScreen = useWideScreen();
const editingId = ref(null);
const pendingDeleteId = ref(null);
const showFormDialog = ref(false);
const keyword = ref(pageState.keyword);
const selectedRows = ref([]);

const form = reactive({
  type: orderType,
  businessType: '成品出货',
  itemId: '',
  deliveryNo: '',
  outsourceNo: '',
  processNo: '',
  plating: '',
  quantity: 1,
  unitPrice: 0,
  partner: '',
  customerId: '',
  operator: '',
  orderDate: todayString(),
  remark: ''
});

const inventoryItems = computed(() => state.inventoryItems || []);
const priceSheets = computed(() => state.priceSheets || []);
const materialOptions = computed(() => {
  return inventoryItems.value
    .map((item) => {
      const price = priceAtDate(priceSheets.value, item, form.orderDate);
      return {
        id: item.id,
        code: item.code,
        specification: item.specification || item.name || '',
        stockQty: Number(item.stockQty || 0),
        unit: item.unit || '',
        plating: item.plating || '',
        unitPrice: Number(price?.unitPrice ?? item.unitPrice ?? 0),
        vendor: String(price?.remark || item.processNote || '').trim()
      };
    })
    .sort((a, b) => String(a.code || '').localeCompare(String(b.code || ''), 'zh-CN'));
});
const processTemplateByNo = computed(() => {
  const sortedOrders = [...(state.stockOrders || [])]
    .sort((a, b) => {
      const dateA = String(a.orderDate || '');
      const dateB = String(b.orderDate || '');
      if (dateA !== dateB) {
        return dateB.localeCompare(dateA, 'zh-CN');
      }
      return Number(b.id || 0) - Number(a.id || 0);
    });
  const map = new Map();
  for (const order of sortedOrders) {
    const processNo = String(order.processNo || '').trim();
    const orderDate = String(order.orderDate || '');
    if (!processNo || !orderDate || map.has(processNo) || (form.customerId && order.customerId !== form.customerId)) {
      continue;
    }
    map.set(processNo, {
      processNo,
      outsourceNo: String(order.outsourceNo || '').trim(),
      customerId: order.customerId,
      itemId: Number(order.itemId || 0)
    });
  }
  return map;
});
const processNoOptions = computed(() => Array.from(processTemplateByNo.value.keys()).sort((a, b) => a.localeCompare(b, 'zh-CN')));
const numberingSettings = computed(() => state.bootstrap?.numberingSettings || {});
const deliveryNoAutoMode = computed(() => numberingSettings.value.deliveryNoMode === 'auto');
const orders = computed(() => (state.stockOrders || []).filter((item) => item.type === orderType));
const platingFilters = computed(() => {
  return Array.from(new Set(orders.value.map((row) => row.plating).filter(Boolean)))
    .sort((a, b) => a.localeCompare(b, 'zh-CN'))
    .map((value) => ({ text: value, value }));
});
const vendorFilters = computed(() => {
  return Array.from(new Set(orders.value.map((row) => row.partner).filter(Boolean)))
    .sort((a, b) => a.localeCompare(b, 'zh-CN'))
    .map((value) => ({ text: value, value }));
});
const visibleOrders = computed(() => {
  const query = keyword.value.trim().toLowerCase();
  return orders.value.filter((record) => {
    if ((businessFilter.value && record.businessType !== businessFilter.value) || (filterCustomer.value && record.customerId !== filterCustomer.value) || (startDate.value && record.orderDate < startDate.value) || (endDate.value && record.orderDate > endDate.value)) return false;
    if (!query) return true;
    return [record.deliveryNo, record.outsourceNo, record.processNo, record.itemCode, record.specification, record.plating, record.partner]
      .some((value) => String(value || '').toLowerCase().includes(query));
  });
});
const deleteMessage = computed(() => {
  const target = orders.value.find((item) => item.id === pendingDeleteId.value);
  return target?.billNo
    ? `该出库单已自动生成账单 ${target.billNo}，撤销后将作废账单并回退库存，操作记录保留；已有收款时不能撤销。`
    : '撤销后库存回退，并保留库存变动记录。';
});
const selectedItem = computed(() => materialOptions.value.find((item) => item.id === Number(form.itemId)) || null);
const materialDisplay = computed(() => {
  const item = selectedItem.value;
  if (!item) {
    return '';
  }
  return `${item.code} · ${item.specification} · 库存 ${formatNumber(item.stockQty || 0)}${item.unit || ''}`;
});
const unitPriceDisplay = computed(() => form.businessType === '退胚' ? '退胚不计加工费' : form.businessType === '返工出货' ? '返工免费，不计加工费' : formatCurrency(form.unitPrice || 0));

// Batches (customer + material + 加工单号) that 退胚 / 返工出货 must draw from.
const isFreeForm = computed(() => FREE_OUTBOUND_TYPES.includes(form.businessType));
const batchSummaries = computed(() => {
  const groups = new Map();
  for (const order of state.stockOrders || []) {
    const processNo = String(order.processNo || '').trim();
    if (!processNo || !order.customerId) continue;
    const key = batchKey(order);
    if (!groups.has(key)) groups.set(key, { key, processNo, customerId: order.customerId, itemId: order.itemId, itemCode: order.itemCode, unit: order.unit, outsourceNo: '', orders: [] });
    const group = groups.get(key);
    group.orders.push(order);
    if (!group.outsourceNo && order.outsourceNo) group.outsourceNo = order.outsourceNo;
  }
  return [...groups.values()].map((group) => ({ ...group, summary: summarizeBatch(group.orders) }));
});
const editingOriginal = computed(() => orders.value.find((order) => order.id === editingId.value) || null);
const selectedBatchKey = computed(() => (form.processNo && form.itemId && form.customerId ? batchKey({ customerId: form.customerId, itemId: Number(form.itemId), processNo: form.processNo }) : ''));
function batchAvailable(batch) {
  const own = editingOriginal.value && batchKey(editingOriginal.value) === batch.key ? Number(editingOriginal.value.quantity) : 0;
  const available = form.businessType === '退胚' ? batch.summary.blankAvailable : batch.summary.reworkAvailable;
  return Number((available + own).toFixed(6));
}
const batchOptions = computed(() => batchSummaries.value
  .filter((batch) => batch.customerId === form.customerId && (form.businessType === '退胚' ? batch.summary.received > 0 : batch.summary.customerReturned > 0))
  .map((batch) => ({ ...batch, available: batchAvailable(batch) }))
  .filter((batch) => batch.available > 0 || batch.key === selectedBatchKey.value)
  .sort((a, b) => a.processNo.localeCompare(b.processNo, 'zh-CN')));
const selectedBatch = computed(() => batchOptions.value.find((batch) => batch.key === selectedBatchKey.value) || null);
const batchSummaryText = computed(() => {
  const batch = selectedBatch.value;
  if (!batch) return '';
  const s = batch.summary, unit = batch.unit || '';
  return form.businessType === '退胚'
    ? `本批次：收货 ${formatNumber(s.received)}${unit}，成品出货 ${formatNumber(s.shipped)}${unit}，已退胚 ${formatNumber(s.blankReturned)}${unit}，本单最多可退 ${formatNumber(batch.available)}${unit}`
    : `本批次：不良退回 ${formatNumber(s.customerReturned)}${unit}，已返工出货 ${formatNumber(s.reworkShipped)}${unit}，本单最多可返工出货 ${formatNumber(batch.available)}${unit}`;
});
function applyBatch(key) {
  const batch = batchSummaries.value.find((entry) => entry.key === key);
  if (!batch) return;
  form.processNo = batch.processNo;
  form.outsourceNo = batch.outsourceNo;
  applyMaterialById(String(batch.itemId));
}
function clearBatch() {
  form.processNo = '';
  form.outsourceNo = '';
  applyMaterialById('');
}
function onBusinessTypeChange() {
  if (!editingId.value) clearBatch();
}
const stockLimitWarning = computed(() => {
  const item = selectedItem.value;
  if (!item) {
    return '';
  }
  const qty = Number(form.quantity || 0);
  const original = orders.value.find((order) => order.id === editingId.value);
  const stock = Number(item.stockQty || 0) + (original?.itemId === item.id ? Number(original.quantity) : 0);
  // For 退胚 / 返工出货 the batch limit is usually the tighter one, so it is checked first.
  if (isFreeForm.value && selectedBatch.value && qty > selectedBatch.value.available && selectedBatch.value.available <= stock) {
    return `该批次本单最多可${form.businessType === '退胚' ? '退胚' : '返工出货'} ${formatNumber(selectedBatch.value.available)}${item.unit || ''}，请调整数量`;
  }
  if (qty > stock) {
    return `当前库存不足，本单最多可出库 ${formatNumber(stock)}${item.unit || ''}，请调整数量`;
  }
  return '';
});

function onSelectionChange(rows) {
  selectedRows.value = rows;
}

const customerOptions = computed(() => state.customers.filter(c => c.isActive || c.id === form.customerId));
function selectCustomer(id) {
  form.partner = state.customers.find(c => c.id === id)?.name || '';
  if (isFreeForm.value && !editingId.value) clearBatch();
}
watch(() => form.orderDate, () => {
  if (!editingId.value && form.itemId) {
    const item = inventoryItems.value.find(i => i.id === Number(form.itemId));
    if (item) form.unitPrice = Number(priceAtDate(priceSheets.value, item, form.orderDate).unitPrice);
  }
});

function applyMaterialById(value) {
  const itemId = String(value || '').trim();
  form.itemId = itemId;
  const item = materialOptions.value.find((entry) => entry.id === Number(itemId));
  if (!item) {
    form.plating = '';
    form.unitPrice = 0;
    return;
  }
  const original = orders.value.find((order) => order.id === editingId.value && order.itemId === item.id);
  form.unitPrice = Number(original?.unitPrice ?? item.unitPrice);
  form.plating = item.plating || '';
}

function applyProcessTemplate(processNo) {
  const key = String(processNo || '').trim();
  form.processNo = key;
  if (!key) {
    form.outsourceNo = '';
    applyMaterialById('');
    return;
  }
  const template = processTemplateByNo.value.get(key);
  if (!template) {
    form.outsourceNo = '';
    return;
  }
  if (!form.customerId && template.customerId) { form.customerId = template.customerId; selectCustomer(template.customerId); }
  if (template.outsourceNo) {
    form.outsourceNo = template.outsourceNo;
  }
  if (template.itemId) {
    applyMaterialById(String(template.itemId));
  }
}

function handleProcessNoModelUpdate(value) {
  form.processNo = String(value || '').trim();
}

function handleProcessNoChange(value) {
  applyProcessTemplate(value);
}

function filterPlating(value, row) {
  return String(row.plating || '') === String(value || '');
}

function filterVendor(value, row) {
  return String(row.partner || '') === String(value || '');
}

watch(keyword, (value) => {
  pageState.keyword = value;
});

async function refreshPageData() {
  await refreshAll({
    stockOrders: {},
    bills: {}
  });
}

async function submitOrder() {
  if (saving.value) return;
  saving.value = true;
  try {
    if (!form.customerId) {
      throw new Error('请选择客户档案；新客户请先在“客户档案”中新增');
    }
    if (isFreeForm.value && !form.processNo) {
      throw new Error(form.businessType === '退胚' ? '请选择原收货批次' : '请选择原退货批次');
    }
    if (!form.itemId) {
      throw new Error('请选择物料');
    }
    const quantityError = checkQuantity(form.quantity);
    if (quantityError) throw new Error(quantityError);
    if (stockLimitWarning.value) {
      throw new Error(stockLimitWarning.value);
    }
    const payload = { ...form, itemId: Number(form.itemId), unitPrice: editingId.value ? form.unitPrice : undefined };
    if (editingId.value) {
      await desktopApi.updateStockOrder({ ...payload, id: editingId.value });
    } else {
      await desktopApi.createStockOrder(payload);
    }
    await refreshPageData();
    const wasEditing = Boolean(editingId.value);
    resetForm();
    showFormDialog.value = false;
    notifySuccess(wasEditing ? '出货明细已更新' : '出货明细已保存，库存已更新');
  } catch (error) {
    notifyError(error.message || '保存出货明细失败');
  } finally { saving.value = false; }
}

function startEdit(record) {
  showFormDialog.value = true;
  editingId.value = record.id;
  form.itemId = String(record.itemId ?? inventoryItems.value.find((item) => item.code === record.itemCode)?.id ?? '');
  form.businessType = record.businessType || '成品出货';
  form.deliveryNo = record.deliveryNo || '';
  form.outsourceNo = record.outsourceNo || '';
  form.processNo = record.processNo || '';
  form.quantity = record.quantity;
  form.operator = record.operator;
  form.orderDate = record.orderDate;
  form.remark = record.remark || '';
  const item = materialOptions.value.find((entry) => entry.id === Number(form.itemId));
  form.unitPrice = Number(record.unitPrice ?? item?.unitPrice ?? 0);
  form.plating = String(record.plating || item?.plating || '');
  form.partner = String(record.partner || item?.vendor || '');
  form.customerId = record.customerId || '';
}

function resetForm() {
  editingId.value = null;
  form.businessType = '成品出货';
  form.itemId = '';
  form.deliveryNo = '';
  form.outsourceNo = '';
  form.processNo = '';
  form.plating = '';
  form.quantity = 1;
  form.unitPrice = 0;
  form.partner = '';
  form.customerId = '';
  form.operator = state.bootstrap?.user?.displayName || '';
  form.orderDate = todayString();
  form.remark = '';
}

function openCreateDialog() {
  resetForm();
  showFormDialog.value = true;
}

function closeFormDialog() {
  showFormDialog.value = false;
  resetForm();
}

async function removeOrder(orderId) {
  try {
    await desktopApi.deleteStockOrder({ orderId, options: { cascadeBill: true } });
    await refreshPageData();
    if (editingId.value === orderId) {
      resetForm();
    }
    notifySuccess('出库明细已撤销，库存已回退');
  } catch (error) {
    notifyError(error.message || '撤销出库明细失败');
  }
}

async function confirmDelete() {
  const id = pendingDeleteId.value;
  pendingDeleteId.value = null;
  if (id) {
    await removeOrder(id);
  }
}

async function exportOrders() {
  try {
    if (!selectedRows.value.length) {
      notifyInfo('请先勾选需要导出的记录');
      return;
    }
    const result = await desktopApi.exportSheet({
      type: 'stockOrders',
      records: selectedRows.value
    });
    result.canceled ? notifyInfo('已取消导出') : notifySuccess(`已导出 ${result.count} 条出货明细`);
  } catch (error) {
    notifyError(error.message || '导出出货明细失败');
  }
}

watch(visibleOrders, () => { selectedRows.value = []; ordersTable.value?.clearSelection(); });
function printOrders(rows) {
  if (!rows.length) return notifyInfo('请先勾选需要打印的明细');
  const first = rows[0], kind = first.businessType === '退胚' ? 'blank-return' : 'delivery';
  if (!first.customerId || rows.some(r => r.customerId !== first.customerId || (r.businessType === '退胚') !== (kind === 'blank-return'))) return notifyInfo('请选择同一客户、同一业务类型的明细');
  const dates = rows.map(r => r.orderDate).sort();
  router.push({ path: '/documents', query: { kind, customerId: first.customerId, startDate: dates[0], endDate: dates.at(-1), ids: rows.map(r => r.id).join(',') } });
}

onMounted(() => {
  refreshPageData();
});

watch(deliveryNoAutoMode, (enabled) => {
  if (enabled) {
    form.deliveryNo = '';
  }
}, { immediate: true });
</script>
