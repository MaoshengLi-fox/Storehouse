<template>
  <div class="page-grid page-grid-fill">
    <ConfirmDialog
      :open="showResetDataDialog"
      title="确认清空业务数据"
      confirm-label="确认清空"
      message="将清空入库、出货、物料、账单、客户、库存流水和收款。操作前会保存保护备份，账号与编号规则保留。"
      @cancel="showResetDataDialog = false"
      @confirm="confirmResetBusinessData"
    />

    <FormDialog :open="showCreateDialog" title="新增用户" @cancel="closeCreateDialog">
      <form class="form-grid" @submit.prevent="submitCreateUser">
        <label><span>用户名</span><input v-model.trim="createForm.username" type="text" required /></label>
        <label><span>显示名称</span><input v-model.trim="createForm.displayName" type="text" required /></label>
        <label>
          <span>角色</span>
          <select v-model="createForm.role" required>
            <option value="operator">普通用户</option>
            <option value="admin">管理员</option>
          </select>
        </label>
        <label><span>初始密码</span><input v-model.trim="createForm.password" type="password" required minlength="6" /></label>
        <div class="form-actions form-span-2"><button class="primary-button" type="submit">创建用户</button></div>
      </form>
    </FormDialog>

    <ConfirmDialog
      :open="Boolean(deleteTarget)"
      title="确认删除用户"
      confirm-label="确认删除"
      :message="deleteTarget ? `删除「${deleteTarget.username} / ${deleteTarget.displayName}」后，该账号会立即下线且无法再登录，此操作不能撤销。历史单据中记录的制表人、操作人姓名会保留。如只是暂时不用，建议改用“禁用”。` : ''"
      @cancel="deleteTarget = null"
      @confirm="confirmDeleteUser"
    />

    <FormDialog :open="showEditDialog" title="编辑用户" @cancel="closeEditDialog">
      <form class="form-grid" @submit.prevent="submitEditUser">
        <label><span>用户名（登录用）</span><input v-model.trim="editForm.username" type="text" required maxlength="50" /></label>
        <label><span>显示名称</span><input v-model.trim="editForm.displayName" type="text" required maxlength="50" /></label>
        <label>
          <span>角色</span>
          <select v-model="editForm.role" :disabled="editingSelf" required>
            <option value="operator">普通用户</option>
            <option value="admin">管理员</option>
          </select>
          <small v-if="editingSelf" class="form-note">不能修改当前登录账号自己的角色</small>
        </label>
        <p class="form-note form-span-2">修改用户名后，该用户下次登录需使用新用户名；已登录的设备不受影响。修改密码请使用“重置密码”。</p>
        <div class="form-actions form-span-2"><button class="primary-button" type="submit" :disabled="saving">{{ saving ? '保存中…' : '保存修改' }}</button></div>
      </form>
    </FormDialog>

    <FormDialog :open="showResetDialog" title="重置密码" @cancel="closeResetDialog">
      <form class="form-grid" @submit.prevent="submitResetPassword">
        <label class="form-span-2"><span>用户</span><input :value="resetTargetLabel" type="text" disabled /></label>
        <label class="form-span-2"><span>新密码</span><input v-model.trim="resetPassword" type="password" required minlength="6" /></label>
        <div class="form-actions form-span-2"><button class="primary-button" type="submit">确认重置</button></div>
      </form>
    </FormDialog>

    <FormDialog :open="showNumberingDialog" title="编码与单号规则" @cancel="closeNumberingDialog">
      <form class="form-grid" @submit.prevent="submitNumberingSettings">
        <label><span>物料编码</span>
          <el-select v-model="numberingForm.inventoryCodeMode">
            <el-option label="自定义输入" value="manual" />
            <el-option label="自动递增" value="auto" />
          </el-select>
        </label>
        <label><span>送货/回库单号</span>
          <el-select v-model="numberingForm.deliveryNoMode">
            <el-option label="自定义输入" value="manual" />
            <el-option label="自动递增" value="auto" />
          </el-select>
        </label>
        <label><span>委外单号</span>
          <el-select v-model="numberingForm.outsourceNoMode">
            <el-option label="自定义输入" value="manual" />
            <el-option label="自动递增" value="auto" />
          </el-select>
        </label>
        <label><span>加工单号</span>
          <el-select v-model="numberingForm.processNoMode">
            <el-option label="自定义输入" value="manual" />
            <el-option label="自动递增" value="auto" />
          </el-select>
        </label>
        <label class="form-span-2"><span>自动编码规则</span><el-input :model-value="'物料 MAT-YYYYMMDD-001；送货 DEL-YYYYMMDD-001；回库 INB-YYYYMMDD-001；委外 OUT-YYYYMMDD-001；加工 PRC-YYYYMMDD-001'" disabled /></label>
        <div class="form-actions form-span-2"><button class="primary-button" type="submit">保存规则</button></div>
      </form>
    </FormDialog>

    <SectionCard title="用户管理" subtitle="仅管理员可见。可新增、编辑、删除用户，重置密码，启用/禁用账号">
      <div class="table-toolbar">
        <div class="table-toolbar-left">
          <label class="search-field"><AppIcon name="search" /><input v-model.trim="keyword" class="toolbar-input" type="text" placeholder="搜索用户名或显示名称" aria-label="搜索用户名或显示名称" /></label>
        </div>
        <div class="table-toolbar-right">
          <button class="icon-button" type="button" @click="loadUsers">刷新</button>
          <button class="icon-button" type="button" @click="showCreateDialog = true"><AppIcon name="plus" />新增用户</button>
          <button class="icon-button" type="button" @click="openNumberingDialog">编码规则</button>
          <button class="danger-button" type="button" @click="showResetDataDialog = true">重置数据</button>
        </div>
      </div>

      <div class="table-scroll">
        <el-table :data="visibleUsers" row-key="id" border stripe style="width: 100%" height="100%">
          <el-table-column prop="username" label="用户名" min-width="140" />
          <el-table-column prop="displayName" label="显示名称" min-width="140" />
          <el-table-column label="角色" min-width="110"><template #default="{ row }">{{ row.role === 'admin' ? '管理员' : '普通用户' }}</template></el-table-column>
          <el-table-column label="状态" min-width="100"><template #default="{ row }"><span class="status-pill" :data-status="row.isActive ? 'healthy' : 'warning'">{{ row.isActive ? '启用' : '禁用' }}</span></template></el-table-column>
          <el-table-column label="最后登录" min-width="150"><template #default="{ row }">{{ formatDateTime(row.lastLoginAt) }}</template></el-table-column>
          <el-table-column label="创建时间" min-width="150"><template #default="{ row }">{{ formatDateTime(row.createdAt) }}</template></el-table-column>
          <el-table-column label="操作" :fixed="wideScreen ? 'right' : false" width="270">
            <template #default="{ row }">
              <div class="table-actions">
                <button class="ghost-button" type="button" @click="openEditDialog(row)">编辑</button>
                <button class="ghost-button" type="button" @click="openResetDialog(row)">重置密码</button>
                <button class="ghost-button" type="button" :disabled="isSelf(row)" @click="toggleUserStatus(row)">{{ row.isActive ? '禁用' : '启用' }}</button>
                <button class="ghost-button delete-action" type="button" :disabled="isSelf(row)" :title="isSelf(row) ? '不能删除当前登录的账号' : ''" @click="deleteTarget = row">删除</button>
              </div>
            </template>
          </el-table-column>
          <template #empty><EmptyState icon="users" :title="keyword ? '没有找到相关记录' : '暂无用户记录'" description="可以调整搜索条件，或新增记录开始使用。" /></template>
        </el-table>
      </div>
      <div class="table-footer"><span>共 {{ users.length }} 条记录</span><span>账号与权限统一管理</span></div>
    </SectionCard>
  </div>
</template>

<script setup>
import { useWideScreen } from '../composables/useWideScreen.js';
const wideScreen = useWideScreen();
import { formatDateTime } from '../utils/formatters.js';
import { computed, onMounted, reactive, ref } from 'vue';
import ConfirmDialog from '../components/ConfirmDialog.vue';
import FormDialog from '../components/FormDialog.vue';
import SectionCard from '../components/SectionCard.vue';
import AppIcon from '../components/AppIcon.vue';
import EmptyState from '../components/EmptyState.vue';
import { useNotifier } from '../composables/useNotifier.js';
import { desktopApi } from '../lib/desktopApi.js';
import { useAppData } from '../composables/useAppData.js';

const { notifyError, notifySuccess } = useNotifier();

const { state } = useAppData();
const users = ref([]);
const showEditDialog = ref(false);
const editTarget = ref(null);
const editForm = reactive({ username: '', displayName: '', role: 'operator' });
const deleteTarget = ref(null);
const saving = ref(false);
const keyword = ref('');
const showCreateDialog = ref(false);
const showResetDialog = ref(false);
const showResetDataDialog = ref(false);
const showNumberingDialog = ref(false);
const resetTargetUser = ref(null);
const resetPassword = ref('');
const numberingForm = reactive({
  inventoryCodeMode: 'manual',
  deliveryNoMode: 'manual',
  outsourceNoMode: 'manual',
  processNoMode: 'manual'
});

const createForm = reactive({
  username: '',
  displayName: '',
  role: 'operator',
  password: ''
});

const currentUser = computed(() => desktopApi.getAuthUser());

const visibleUsers = computed(() => {
  const query = keyword.value.trim().toLowerCase();
  return users.value.filter((user) => {
    if (!query) {
      return true;
    }
    return [user.username, user.displayName].some((field) => String(field || '').toLowerCase().includes(query));
  });
});

const resetTargetLabel = computed(() => {
  if (!resetTargetUser.value) {
    return '';
  }
  return `${resetTargetUser.value.username} / ${resetTargetUser.value.displayName}`;
});

function isSelf(user) {
  return Number(user.id) === Number(currentUser.value?.id || -1);
}

async function loadUsers() {
  try {
    const list = await desktopApi.getUsers();
    users.value = Array.isArray(list) ? list : [];
    if (!Array.isArray(list)) {
      notifyError('用户数据格式异常，请刷新服务后重试');
    }
  } catch (error) {
    users.value = [];
    notifyError(error.message || '加载用户失败');
  }
}

function closeCreateDialog() {
  showCreateDialog.value = false;
  createForm.username = '';
  createForm.displayName = '';
  createForm.role = 'operator';
  createForm.password = '';
}

async function submitCreateUser() {
  try {
    await desktopApi.createUser({ ...createForm });
    await loadUsers();
    closeCreateDialog();
    notifySuccess('用户已创建');
  } catch (error) {
    notifyError(error.message || '创建用户失败');
  }
}

const editingSelf = computed(() => Boolean(editTarget.value && isSelf(editTarget.value)));

function openEditDialog(user) {
  editTarget.value = user;
  editForm.username = user.username;
  editForm.displayName = user.displayName;
  editForm.role = user.role;
  showEditDialog.value = true;
}

function closeEditDialog() {
  showEditDialog.value = false;
  editTarget.value = null;
}

async function submitEditUser() {
  if (!editTarget.value || saving.value) return;
  saving.value = true;
  try {
    const self = editingSelf.value;
    await desktopApi.updateUser(editTarget.value.id, { ...editForm });
    await loadUsers();
    // Keep the name shown in the sidebar in step when admins edit their own account.
    if (self) state.bootstrap = await desktopApi.getBootstrapData();
    closeEditDialog();
    notifySuccess('用户信息已更新');
  } catch (error) {
    notifyError(error.message || '更新用户失败');
  } finally {
    saving.value = false;
  }
}

async function confirmDeleteUser() {
  const target = deleteTarget.value;
  deleteTarget.value = null;
  if (!target) return;
  try {
    await desktopApi.deleteUser(target.id);
    await loadUsers();
    notifySuccess(`用户 ${target.username} 已删除`);
  } catch (error) {
    notifyError(error.message || '删除用户失败');
  }
}

function openResetDialog(user) {
  resetTargetUser.value = user;
  resetPassword.value = '';
  showResetDialog.value = true;
}

function closeResetDialog() {
  showResetDialog.value = false;
  resetTargetUser.value = null;
  resetPassword.value = '';
}

async function submitResetPassword() {
  try {
    if (!resetTargetUser.value) {
      return;
    }
    await desktopApi.resetUserPassword(resetTargetUser.value.id, resetPassword.value);
    closeResetDialog();
    notifySuccess('密码已重置');
  } catch (error) {
    notifyError(error.message || '重置密码失败');
  }
}

async function toggleUserStatus(user) {
  try {
    await desktopApi.setUserActiveStatus(user.id, !user.isActive);
    await loadUsers();
    notifySuccess(`用户已${user.isActive ? '禁用' : '启用'}`);
  } catch (error) {
    notifyError(error.message || '更新用户状态失败');
  }
}

async function confirmResetBusinessData() {
  try {
    await desktopApi.resetBusinessData();
    showResetDataDialog.value = false;
    notifySuccess('业务数据已清空，请前往各页面重新测试');
  } catch (error) {
    notifyError(error.message || '清空数据失败');
  }
}

async function openNumberingDialog() {
  try {
    const settings = await desktopApi.getNumberingSettings();
    numberingForm.inventoryCodeMode = settings.inventoryCodeMode || 'manual';
    numberingForm.deliveryNoMode = settings.deliveryNoMode || 'manual';
    numberingForm.outsourceNoMode = settings.outsourceNoMode || 'manual';
    numberingForm.processNoMode = settings.processNoMode || 'manual';
    showNumberingDialog.value = true;
  } catch (error) {
    notifyError(error.message || '加载编码规则失败');
  }
}

function closeNumberingDialog() {
  showNumberingDialog.value = false;
}

async function submitNumberingSettings() {
  try {
    await desktopApi.updateNumberingSettings({ ...numberingForm });
    showNumberingDialog.value = false;
    notifySuccess('编码规则已保存，新建单据立即生效');
  } catch (error) {
    notifyError(error.message || '保存编码规则失败');
  }
}

onMounted(() => {
  loadUsers();
});
</script>
