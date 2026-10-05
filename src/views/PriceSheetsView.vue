<template>
  <div class="page-grid page-grid-fill">
    <ConfirmDialog
      :open="Boolean(pendingDeleteItemId)"
      title="确认删除物料"
      message="仅无库存、无库存变动且未被单据引用的物料可删除，同时删除其价目历史。"
      @cancel="pendingDeleteItemId = null"
      @confirm="confirmDelete"
    />

    <FormDialog :open="showFormDialog" :title="isEditMode ? '修改价目' : '新增价目'" @cancel="closeFormDialog">
      <form class="form-grid" @submit.prevent="submitPriceSheet">
        <label>
          <span>物料编码</span>
          <input
            v-if="isEditMode"
            :value="form.code"
            type="text"
            disabled
          />
          <input
            v-else
            v-model.trim="form.code"
            type="text"
            :placeholder="inventoryCodeAutoMode ? '自动递增生成' : '输入新物料编码'"
            :disabled="inventoryCodeAutoMode"
            :required="!inventoryCodeAutoMode"
          />
        </label>

        <label>
          <span>规格</span>
          <input v-model.trim="form.specification" type="text" required />
        </label>

        <label>
          <span>镀种</span>
          <el-autocomplete
            v-model="form.plating"
            :fetch-suggestions="queryPlatingSuggestions"
            clearable
            placeholder="请选择或输入镀种"
          />
        </label>

        <label>
          <span>单位</span>
          <el-autocomplete
            v-model="form.unit"
            :fetch-suggestions="queryUnitSuggestions"
            clearable
            placeholder="请选择或输入单位"
          />
        </label>

        <label>
          <span>分类</span>
          <el-autocomplete
            v-model="form.category"
            :fetch-suggestions="queryCategorySuggestions"
            clearable
            placeholder="请选择或输入分类"
          />
        </label>

        <label>
          <span>厂商</span>
          <el-autocomplete
            v-model="form.vendor"
            clearable
            :fetch-suggestions="queryVendorSuggestions"
            placeholder="请选择或输入厂商"
          />
        </label>

        <label><span>单价</span><input v-model.number="form.unitPrice" type="number" min="0" step="0.01" required /></label>
        <label><span>生效日期</span><input v-model="form.effectiveDate" type="date" required /></label>
        <div class="form-actions form-span-2"><button class="primary-button" type="submit" :disabled="saving">{{ saving ? '保存中…' : '保存' }}</button></div>
      </form>
    </FormDialog>

    <FormDialog :open="Boolean(historyItem)" title="价格历史与待生效价格" @cancel="historyItem = null">
      <p class="form-note">{{ historyItem?.itemCode }} · {{ historyItem?.specification }}。删除当前价目后回退到上一笔已生效价格，已开账单保持不变。</p>
      <el-table :data="historyRows" max-height="420"><el-table-column prop="effectiveDate" label="生效日期" width="130" /><el-table-column label="单价" width="120"><template #default="{ row }">{{ formatCurrency(row.unitPrice) }}</template></el-table-column><el-table-column label="状态" width="120"><template #default="{ row }"><span class="status-pill" :data-status="row.priceStatus">{{ row.priceStatus }}</span></template></el-table-column><el-table-column prop="remark" label="厂商" min-width="130" /><el-table-column label="操作" width="90"><template #default="{ row }"><button class="ghost-button delete-action" @click="pendingPriceId = row.id">删除</button></template></el-table-column></el-table>
    </FormDialog>
    <ConfirmDialog :open="Boolean(pendingPriceId)" title="删除价目记录" message="删除后会按剩余生效记录重新确定当前价目，不改变历史账单。" @cancel="pendingPriceId = null" @confirm="deleteHistoryPrice" />
    <SectionCard title="辅助价目" subtitle="按生效日期取价，未来价格到期启用；同日多次调价以最后保存为准，历史账单保留开单价">
      <div class="table-toolbar">
        <div class="table-toolbar-left">
          <label class="search-field"><AppIcon name="search" /><input v-model.trim="codeKeyword" class="toolbar-input" type="text" placeholder="按物料编码搜索" aria-label="按物料编码搜索" /></label>
        </div>
        <div class="table-toolbar-right">
          <button class="icon-button" type="button" @click="exportPriceSheets"><AppIcon name="download" />导出</button>
          <button class="icon-button icon-button-primary" type="button" @click="openCreateDialog"><AppIcon name="plus" />新增</button>
        </div>
      </div>

      <div class="table-scroll">
        <el-table
          :data="searchedRows"
          row-key="itemId"
          border
          stripe
          style="width: 100%"
          height="100%"
          @selection-change="onSelectionChange"
        >
          <el-table-column type="selection" width="50" />
          <el-table-column prop="itemCode" label="物料编码" min-width="120" sortable show-overflow-tooltip />
          <el-table-column prop="specification" label="规格" min-width="170" sortable show-overflow-tooltip />
          <el-table-column prop="unitPrice" label="单价" width="100" sortable align="right">
            <template #default="{ row }">{{ formatCurrency(row.unitPrice) }}</template>
          </el-table-column>
          <el-table-column prop="effectiveDate" label="当前价格生效日" width="130"><template #default="{ row }">{{ row.effectiveDate || '暂无生效价目' }}<small v-if="row.pendingCount" class="cell-note">{{ row.pendingCount }} 笔待生效</small></template></el-table-column>
          <el-table-column
            prop="plating"
            label="镀种"
            min-width="100"
            show-overflow-tooltip
            :filters="platingColumnFilters"
            :filter-method="filterPlating"
            filter-placement="bottom-end"
          />
          <el-table-column prop="unit" label="单位" width="64" />
          <el-table-column
            prop="vendor"
            label="厂商"
            min-width="110"
            show-overflow-tooltip
            :filters="vendorColumnFilters"
            :filter-method="filterVendor"
            filter-placement="bottom-end"
          />
          <el-table-column
            prop="category"
            label="分类"
            min-width="90"
            show-overflow-tooltip
            :filters="categoryColumnFilters"
            :filter-method="filterCategory"
            filter-placement="bottom-end"
          />
          <el-table-column label="操作" :fixed="wideScreen ? 'right' : false" width="230">
            <template #default="{ row }">
              <div class="table-actions">
                <button class="ghost-button" type="button" @click="startEdit(row)">调价 / 修改</button><button class="ghost-button" @click="historyItem = row">价格历史</button>
                <button class="ghost-button delete-action" type="button" @click="pendingDeleteItemId = row.itemId">删除</button>
              </div>
            </template>
          </el-table-column>
          <template #empty><EmptyState icon="box" :title="codeKeyword ? '没有找到相关记录' : '暂无物料价目'" description="可以调整搜索条件，或新增记录开始使用。" /></template>
        </el-table>
      </div>
      <div class="table-footer"><span>共 {{ normalizedRows.length }} 条记录<span v-if="selectedRows.length"> · 已选择 {{ selectedRows.length }} 条</span></span><span>勾选记录后可导出 Excel</span></div>
    </SectionCard>
  </div>
</template>

<script setup>
import { useWideScreen } from '../composables/useWideScreen.js';
const wideScreen = useWideScreen();
import { computed, onMounted, reactive, ref, watch } from 'vue';
import ConfirmDialog from '../components/ConfirmDialog.vue';
import FormDialog from '../components/FormDialog.vue';
import SectionCard from '../components/SectionCard.vue';
import AppIcon from '../components/AppIcon.vue';
import EmptyState from '../components/EmptyState.vue';
import { useAppData } from '../composables/useAppData.js';
import { useNotifier } from '../composables/useNotifier.js';
import { desktopApi } from '../lib/desktopApi.js';
import { formatCurrency, todayString } from '../utils/formatters.js';

const { state, refreshPriceSheets, refreshInventory } = useAppData();
const { notifyError, notifyInfo, notifySuccess } = useNotifier();

const pendingDeleteItemId = ref(null);
const showFormDialog = ref(false);
const editingId = ref(null);
const isEditMode = ref(false);
const codeKeyword = ref('');
const selectedRows = ref([]);
const historyItem = ref(null);
const pendingPriceId = ref(null);
const saving = ref(false);
const historyRows = computed(() => priceSheets.value.filter(p => p.itemId === historyItem.value?.itemId));

const form = reactive({
  itemId: '',
  code: '',
  specification: '',
  plating: '',
  unit: '',
  category: '',
  vendor: '',
  unitPrice: 0,
  effectiveDate: todayString()
});

const priceSheets = computed(() => state.priceSheets || []);
const inventoryItems = computed(() => state.inventoryItems || []);

const latestPriceByItem = computed(() => new Map(priceSheets.value.filter(p => p.isActive === 1).map(p => [p.itemId, p])));

const normalizedRows = computed(() => {
  return inventoryItems.value.map((item) => {
    const priceRow = latestPriceByItem.value.get(item.id);
    return {
      id: priceRow?.id || null,
      itemId: item.id,
      itemCode: item.code,
      specification: item.specification || item.name,
      plating: item.plating || '',
      unit: item.unit || '',
      unitPrice: Number(priceRow?.unitPrice ?? item.unitPrice ?? 0),
      vendor: String(priceRow?.remark || item.processNote || '').trim(),
      category: item.category || '',
      effectiveDate: priceRow?.effectiveDate || '',
      pendingCount: priceSheets.value.filter(p => p.itemId === item.id && p.priceStatus === '待生效').length
    };
  }).sort((a, b) => String(a.itemCode || '').localeCompare(String(b.itemCode || ''), 'zh-CN'));
});

const platingOptions = computed(() => Array.from(new Set(normalizedRows.value.map((row) => row.plating).filter(Boolean))).sort((a, b) => a.localeCompare(b, 'zh-CN')));
const categoryOptions = computed(() => Array.from(new Set(normalizedRows.value.map((row) => row.category).filter(Boolean))).sort((a, b) => a.localeCompare(b, 'zh-CN')));
const vendorOptions = computed(() => Array.from(new Set(normalizedRows.value.map((row) => row.vendor).filter(Boolean))).sort((a, b) => a.localeCompare(b, 'zh-CN')));
const unitOptions = computed(() => Array.from(new Set(normalizedRows.value.map((row) => row.unit).filter(Boolean))).sort((a, b) => a.localeCompare(b, 'zh-CN')));
const numberingSettings = computed(() => state.bootstrap?.numberingSettings || {});
const inventoryCodeAutoMode = computed(() => numberingSettings.value.inventoryCodeMode === 'auto');

const searchedRows = computed(() => {
  const keyword = codeKeyword.value.trim().toLowerCase();
  if (!keyword) return normalizedRows.value;
  return normalizedRows.value.filter((row) => String(row.itemCode || '').toLowerCase().includes(keyword));
});

const platingColumnFilters = computed(() => platingOptions.value.map((value) => ({ text: value, value })));
const categoryColumnFilters = computed(() => categoryOptions.value.map((value) => ({ text: value, value })));
const vendorColumnFilters = computed(() => vendorOptions.value.map((value) => ({ text: value, value })));

function filterPlating(value, row) {
  return String(row.plating || '') === String(value || '');
}

function filterCategory(value, row) {
  return String(row.category || '') === String(value || '');
}

function filterVendor(value, row) {
  return String(row.vendor || '') === String(value || '');
}

function onSelectionChange(rows) {
  selectedRows.value = rows;
}

function queryAutocompleteSuggestions(options, queryString, cb) {
  const keyword = String(queryString || '').trim().toLowerCase();
  const result = options
    .filter((option) => !keyword || option.toLowerCase().includes(keyword))
    .slice(0, 20)
    .map((value) => ({ value }));
  cb(result);
}

function queryPlatingSuggestions(queryString, cb) {
  queryAutocompleteSuggestions(platingOptions.value, queryString, cb);
}

function queryUnitSuggestions(queryString, cb) {
  queryAutocompleteSuggestions(unitOptions.value, queryString, cb);
}

function queryCategorySuggestions(queryString, cb) {
  queryAutocompleteSuggestions(categoryOptions.value, queryString, cb);
}

function queryVendorSuggestions(queryString, cb) {
  queryAutocompleteSuggestions(vendorOptions.value, queryString, cb);
}

async function refreshPageData() {
  await Promise.all([refreshPriceSheets(), refreshInventory()]);
}

function openCreateDialog() {
  isEditMode.value = false;
  editingId.value = null;
  Object.assign(form, {
    itemId: '',
    code: '',
    specification: '',
    plating: '',
    unit: '',
    category: '',
    vendor: '',
    unitPrice: 0,
    effectiveDate: todayString()
  });
  showFormDialog.value = true;
}

function startEdit(row) {
  isEditMode.value = true;
  editingId.value = row.id;
  Object.assign(form, {
    itemId: row.itemId,
    code: row.itemCode,
    specification: row.specification || '',
    plating: row.plating || '',
    unit: row.unit || '',
    category: row.category || '',
    vendor: row.vendor || '',
    unitPrice: row.unitPrice || 0,
    effectiveDate: todayString()
  });
  showFormDialog.value = true;
}

function closeFormDialog() {
  showFormDialog.value = false;
  isEditMode.value = false;
  editingId.value = null;
}

async function submitPriceSheet() {
  if (saving.value) return;
  saving.value = true;
  try {
    if (!isEditMode.value && !inventoryCodeAutoMode.value && !form.code.trim()) throw new Error('请输入物料编码');
    await desktopApi.saveMaterialPrice({ ...form, itemId: isEditMode.value ? Number(form.itemId) : undefined });
    closeFormDialog();
    await refreshPageData();
    notifySuccess('价目已保存，按生效日期自动启用');
  } catch (error) { notifyError(error.message || '保存失败'); }
  finally { saving.value = false; }
}

async function deleteHistoryPrice() {
  const id = pendingPriceId.value;
  pendingPriceId.value = null;
  try { await desktopApi.deletePriceSheet(id); await refreshPageData(); notifySuccess('价目记录已删除'); }
  catch (error) { notifyError(error.message || '删除失败'); }
}

async function confirmDelete() {
  const itemId = pendingDeleteItemId.value;
  pendingDeleteItemId.value = null;
  if (!itemId) return;

  try {
    await desktopApi.deleteInventoryItem(itemId);
    await refreshPageData();
    notifySuccess('物料已删除');
  } catch (error) {
    notifyError(error.message || '删除失败');
  }
}

async function exportPriceSheets() {
  try {
    if (!selectedRows.value.length) {
      notifyInfo('请先勾选需要导出的记录');
      return;
    }

    const result = await desktopApi.exportSheet({
      type: 'priceSheets',
      records: selectedRows.value
    });
    result.canceled ? notifyInfo('已取消导出') : notifySuccess(`已导出 ${result.count} 条记录`);
  } catch (error) {
    notifyError(error.message || '导出失败');
  }
}

onMounted(() => {
  refreshPageData();
});
watch(inventoryCodeAutoMode, (enabled) => {
  if (enabled && !isEditMode.value) {
    form.code = '';
  }
}, { immediate: true });
</script>
