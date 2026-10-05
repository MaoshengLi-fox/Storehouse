<template>
  <div class="page-grid page-grid-fill">
    <ConfirmDialog
      :open="Boolean(pendingDeleteId)"
      title="确认撤销入库明细"
      confirm-label="确认撤销"
      message="撤销会扣回本次入库数量并保留库存流水；库存不足时无法撤销。"
      @cancel="pendingDeleteId = null"
      @confirm="confirmDelete"
    />
    <FormDialog
      :open="showFormDialog"
      :title="editingId ? '修改入库明细' : '新增入库明细'"
      @cancel="closeFormDialog"
    >
      <form class="form-grid" @submit.prevent="submitOrder">
        <label>
          <span>回库类型</span>
          <el-select v-model="form.businessType">
            <el-option label="正常入库" value="正常入库" />
            <el-option label="退胚回库" value="退胚回库" />
            <el-option label="不良退回" value="不良退回" />
          </el-select>
        </label>
        <label>
          <span>回库日期</span>
          <el-date-picker v-model="form.orderDate" type="date" value-format="YYYY-MM-DD" format="YYYY-MM-DD" :clearable="false" />
          <small v-if="form.orderDate > todayString()" class="field-warning">回库日期晚于今天，保存后会立即计入库存，请确认</small>
        </label>
        <label>
          <span>回库单号</span>
          <el-input v-model.trim="form.deliveryNo" :disabled="deliveryNoAutoMode" :placeholder="deliveryNoAutoMode ? '自动递增生成' : ''" />
        </label>
        <label>
          <span>委外/重工单号</span>
          <el-input v-model.trim="form.outsourceNo" :disabled="outsourceNoAutoMode" :placeholder="outsourceNoAutoMode ? '自动递增生成' : ''" />
        </label>
        <label>
          <span>加工单号</span>
          <el-select
            v-model="form.processNo"
            filterable
            allow-create
            clearable
            default-first-option
            :reserve-keyword="false"
            :placeholder="inboundProcessNoAutoMode ? '自动递增生成' : '可搜索后选择，或直接输入新加工单号'"
            :disabled="inboundProcessNoAutoMode"
            @change="handleProcessNoChange"
            @update:model-value="handleProcessNoModelUpdate"
          >
            <el-option v-for="option in processNoOptions" :key="option" :label="option" :value="option" />
          </el-select>
        </label>
        <label>
          <span>物料</span>
          <el-select
            v-model="form.itemId"
            filterable
            :reserve-keyword="false"
            :placeholder="editingId ? '按厂商/分类/规格/镀种搜索选择' : '请选择物料编码/规格'"
            @change="handleMaterialChange"
            @update:model-value="handleMaterialModelUpdate"
          >
            <el-option
              v-for="item in materialOptions"
              :key="item.id"
              :label="materialOptionLabel(item)"
              :value="String(item.id)"
            />
          </el-select>
        </label>
        <label>
          <span>镀种</span>
          <el-input :model-value="form.plating" disabled />
        </label>
        <label>
          <span>回库数量</span>
          <input v-model.number="form.quantity" type="number" min="0" step="any" required />
        </label>
        <label>
          <span>客户 <em class="required-mark">*</em></span>
          <el-select v-model="form.customerId" filterable placeholder="选择客户档案" :disabled="Boolean(editingId && form.type === '出库')" @change="selectCustomer"><el-option v-for="customer in customerOptions" :key="customer.id" :value="customer.id" :label="customer.name" /></el-select>
        </label>
        <label>
          <span>制表人 <em class="required-mark">*</em></span>
          <el-input v-model.trim="form.operator" />
        </label>
        <label class="form-span-2">
          <span>备注</span>
          <el-input v-model.trim="form.remark" />
        </label>
        <p class="form-note form-span-2">正常入库、退胚回库计为收货，不良退回计为客户退货；入库不计金额。出货页的退胚、返工出货按“客户 + 物料 + 加工单号”对应到这里的记录，请填写加工单号。已被退胚或返工出货引用的记录，修改或撤销后数量不足时会被拒绝。</p>
        <div class="form-actions form-span-2">
          <button class="primary-button" type="submit">{{ editingId ? '保存修改' : '保存入库明细' }}</button>
        </div>
      </form>
    </FormDialog>

    <SectionCard title="入库明细" subtitle="正常入库、退胚回库计为收货，不良退回计为客户退货；入库不计金额">
      <div class="table-toolbar">
        <div class="table-toolbar-left">
          <label class="search-field"><AppIcon name="search" /><input v-model.trim="keyword" class="toolbar-input" type="text" placeholder="搜索客户、加工单号、物料、镀种、回库单号、委外单号" aria-label="搜索客户、加工单号、物料、镀种、回库单号、委外单号" /></label>
        </div>
        <div class="table-toolbar-right">
          <button class="icon-button" type="button" @click="exportOrders"><AppIcon name="download" />导出</button>
          <button class="icon-button icon-button-primary" type="button" @click="openCreateDialog"><AppIcon name="plus" />新增</button>
        </div>
      </div>
      <div class="table-scroll">
        <el-table :data="visibleOrders" row-key="id" border stripe style="width: 100%" height="100%" @selection-change="onSelectionChange">
          <el-table-column type="selection" width="44" />
          <el-table-column prop="orderDate" label="回库日期" sortable width="108" />
          <el-table-column
            prop="businessType"
            label="类型"
            sortable
            width="100"
            :filters="businessTypeFilters"
            :filter-method="filterBusinessType"
            filter-placement="bottom-end"
          />
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
          <el-table-column prop="processNo" label="加工单号" sortable min-width="120" show-overflow-tooltip />
          <el-table-column prop="itemCode" label="物料编码" sortable min-width="120" show-overflow-tooltip />
          <el-table-column prop="specification" label="品名规格" sortable min-width="160" show-overflow-tooltip />
          <el-table-column label="回库数量" sortable :sort-method="(a, b) => a.quantity - b.quantity" width="110" align="right">
            <template #default="{ row }">{{ formatNumber(row.quantity) }} {{ row.unit }}</template>
          </el-table-column>
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
          <el-table-column prop="deliveryNo" label="回库单号" sortable min-width="120" show-overflow-tooltip />
          <el-table-column prop="outsourceNo" label="委外/重工单号" sortable min-width="120" show-overflow-tooltip />
          <el-table-column prop="remark" label="备注" min-width="120" show-overflow-tooltip />
          <el-table-column label="操作" :fixed="wideScreen ? 'right' : false" width="168">
            <template #default="{ row }">
              <div class="table-actions">
                <button class="ghost-button" type="button" @click="startEdit(row)">修改</button>
                <button class="ghost-button delete-action" type="button" @click="pendingDeleteId = row.id">撤销</button>
                <button class="ghost-button" type="button" @click="printOrder(row.id)">打印</button>
              </div>
            </template>
          </el-table-column>
          <template #empty><EmptyState icon="inbound" :title="keyword ? '没有找到相关记录' : '暂无入库记录'" description="可以调整搜索条件，或新增记录开始使用。" /></template>
        </el-table>
      </div>
      <div class="table-footer"><span>共 {{ orders.length }} 条记录<span v-if="selectedRows.length"> · 已选择 {{ selectedRows.length }} 条</span></span><span>勾选记录后可导出 Excel</span></div>
    </SectionCard>
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref, watch } from 'vue';
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
import { checkQuantity, formatNumber, todayString } from '../utils/formatters.js';

const { state, refreshAll } = useAppData();
const { notifyError, notifyInfo, notifySuccess } = useNotifier();
const orderType = '入库';
const PROCESS_NO_RECENT_DAYS = 30;
const pageState = useViewState('inbound');
const wideScreen = useWideScreen();
const editingId = ref(null);
const pendingDeleteId = ref(null);
const showFormDialog = ref(false);
const keyword = ref(pageState.keyword);
const selectedRows = ref([]);

const form = reactive({
  type: orderType,
  businessType: '正常入库',
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
        category: item.category || '',
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
  const now = new Date();
  const cutoff = new Date(now);
  cutoff.setDate(cutoff.getDate() - PROCESS_NO_RECENT_DAYS);
  const cutoffDate = cutoff.toISOString().slice(0, 10);
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
    if (!processNo || !orderDate || map.has(processNo)) continue;
    if (form.customerId && order.customerId !== form.customerId) continue;
    // Keep recent numbers first in mind, but still offer older ones for 退胚回库 / 不良退回 of an old batch.
    if (orderDate < cutoffDate && !form.customerId) continue;
    map.set(processNo, {
      processNo,
      outsourceNo: String(order.outsourceNo || '').trim(),
      customerId: order.customerId || '',
      itemId: Number(order.itemId || 0)
    });
  }
  return map;
});
const processNoOptions = computed(() => Array.from(processTemplateByNo.value.keys()).sort((a, b) => a.localeCompare(b, 'zh-CN')));
const numberingSettings = computed(() => state.bootstrap?.numberingSettings || {});
const deliveryNoAutoMode = computed(() => numberingSettings.value.deliveryNoMode === 'auto');
const outsourceNoAutoMode = computed(() => numberingSettings.value.outsourceNoMode === 'auto');
const processNoAutoMode = computed(() => numberingSettings.value.processNoMode === 'auto');
// 加工单号 follows only its own numbering rule.
const inboundProcessNoAutoMode = computed(() => processNoAutoMode.value);
const orders = computed(() => (state.stockOrders || []).filter((item) => item.type === orderType));
const businessTypeFilters = computed(() => {
  return Array.from(new Set(orders.value.map((row) => row.businessType).filter(Boolean)))
    .sort((a, b) => a.localeCompare(b, 'zh-CN'))
    .map((value) => ({ text: value, value }));
});
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
    if (!query) return true;
    return [record.deliveryNo, record.outsourceNo, record.processNo, record.itemCode, record.specification, record.plating, record.partner, record.remark]
      .some((value) => String(value || '').toLowerCase().includes(query));
  });
});
const canShowMaterialStock = computed(() => {
  if (processNoAutoMode.value) {
    return false;
  }
  const key = String(form.processNo || '').trim();
  if (!key) {
    return false;
  }
  return processTemplateByNo.value.has(key);
});

function filterBusinessType(value, row) {
  return String(row.businessType || '') === String(value || '');
}

function filterPlating(value, row) {
  return String(row.plating || '') === String(value || '');
}

function filterVendor(value, row) {
  return String(row.partner || '') === String(value || '');
}

function onSelectionChange(rows) {
  selectedRows.value = rows;
}

function materialOptionLabel(item) {
  if (editingId.value) {
    const vendor = item.vendor || '未设厂商';
    const category = item.category || '未分类';
    const specification = item.specification || '-';
    const plating = item.plating || '-';
    return `${vendor} · ${category} · ${specification} · ${plating} · ${item.code}`;
  }
  if (!canShowMaterialStock.value) {
    return `${item.code} · ${item.specification}`;
  }
  return `${item.code} · ${item.specification} · 库存 ${formatNumber(item.stockQty)}${item.unit || ''}`;
}

const customerOptions = computed(() => state.customers.filter(c => c.isActive || c.id === form.customerId));
function selectCustomer(id) { form.partner = state.customers.find(c => c.id === id)?.name || ''; }
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
    return;
  }
  form.plating = item.plating || '';
}

function applyProcessTemplate(processNo) {
  const key = String(processNo || '').trim();
  form.processNo = key;
  if (!key) {
    return;
  }
  const template = processTemplateByNo.value.get(key);
  if (!template) {
    return;
  }
  if (!form.customerId && template.customerId) {
    form.customerId = template.customerId;
    selectCustomer(template.customerId);
  }
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

function handleMaterialChange(value) {
  applyMaterialById(value);
}

function handleMaterialModelUpdate(value) {
  applyMaterialById(value);
}

watch(keyword, (value) => {
  pageState.keyword = value;
});

async function refreshPageData() {
  await refreshAll({
    stockOrders: {}
  });
}

async function submitOrder() {
  try {
    if (!form.customerId) {
      throw new Error('请选择客户档案；新客户请先在“客户档案”中新增');
    }
    if (!form.itemId) {
      throw new Error('请选择物料');
    }
    const quantityError = checkQuantity(form.quantity);
    if (quantityError) throw new Error(quantityError);
    if (!String(form.operator || '').trim()) {
      throw new Error('请填写制表人');
    }
    const payload = { ...form, itemId: Number(form.itemId), unitPrice: undefined };
    const wasEditing = Boolean(editingId.value);
    if (editingId.value) {
      await desktopApi.updateStockOrder({ ...payload, id: editingId.value });
    } else {
      await desktopApi.createStockOrder(payload);
    }
    await refreshPageData();
    resetForm();
    showFormDialog.value = false;
    notifySuccess(wasEditing ? '入库明细已更新' : '入库明细已保存，库存已更新');
  } catch (error) {
    notifyError(error.message || '保存入库明细失败');
  }
}

function startEdit(record) {
  showFormDialog.value = true;
  editingId.value = record.id;
  form.itemId = String(record.itemId ?? inventoryItems.value.find((item) => item.code === record.itemCode)?.id ?? '');
  form.businessType = record.businessType || '正常入库';
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
  form.partner = String(record.partner || '');
  form.customerId = record.customerId || '';
}

function resetForm() {
  editingId.value = null;
  form.businessType = '正常入库';
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
    await desktopApi.deleteStockOrder(orderId);
    await refreshPageData();
    if (editingId.value === orderId) {
      resetForm();
    }
    notifySuccess('入库明细已撤销，库存已回退');
  } catch (error) {
    notifyError(error.message || '撤销入库明细失败');
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
    result.canceled ? notifyInfo('已取消导出') : notifySuccess(`已导出 ${result.count} 条入库明细`);
  } catch (error) {
    notifyError(error.message || '导出入库明细失败');
  }
}

async function printOrder(orderId) {
  try {
    await desktopApi.printStockOrder(orderId);
    notifySuccess('打印窗口已发送');
  } catch (error) {
    notifyError(error.message || '打印失败');
  }
}

onMounted(() => {
  refreshPageData();
});

watch(deliveryNoAutoMode, (enabled) => {
  if (enabled) {
    form.deliveryNo = '';
  }
}, { immediate: true });

watch(outsourceNoAutoMode, (enabled) => {
  if (enabled) {
    form.outsourceNo = '';
  }
}, { immediate: true });

watch(processNoAutoMode, (enabled) => {
  if (enabled) {
    form.processNo = '';
  }
}, { immediate: true });

watch(inboundProcessNoAutoMode, (enabled) => {
  if (enabled) {
    form.processNo = '';
  }
}, { immediate: true });
</script>
