<template>
  <div class="page-grid">
    <div class="welcome-panel"><div><p class="eyebrow">BUSINESS DATA</p><h3>为每一笔业务保留退路</h3><p>备份包含物料、价目、出入库、账单、库存流水、客户与收款。账号和登录信息独立保存。</p></div><AppIcon name="download" /></div>
    <p v-if="snapshot.lastError" class="notice-error" role="alert">{{ snapshot.lastError }}</p>
    <SectionCard title="自动备份" subtitle="服务运行期间按间隔执行；默认每 24 小时保存一份。保留数量仅适用于自动备份。">
      <form class="backup-settings" @submit.prevent="saveSettings">
        <label class="inline-check"><input v-model="settings.enabled" type="checkbox" />启用自动备份</label>
        <label>备份间隔（小时）<input v-model.number="settings.intervalHours" type="number" min="1" max="168" step="1" required /></label>
        <label>保留最近（份）<input v-model.number="settings.retention" type="number" min="1" max="90" step="1" required /></label>
        <button class="primary-button" :disabled="pending">保存设置</button>
      </form>
      <p class="form-note">手动、上传、升级前和恢复前的备份长期保留。建议定期下载到另一台设备保管。账号库请随服务器目录另行备份。</p>
    </SectionCard>
    <SectionCard title="业务数据备份" subtitle="恢复会覆盖当前业务数据；恢复前自动创建保护副本。仅管理员可以查看和操作。">
      <div class="table-toolbar"><span class="form-note">共 {{ snapshot.backups.length }} 份 · {{ snapshot.busy ? '后台备份进行中' : '备份服务就绪' }}</span><div class="table-toolbar-right">
        <button class="icon-button" :disabled="pending" @click="load">刷新列表</button>
        <input ref="uploadInput" class="visually-hidden" type="file" accept=".db" aria-label="选择业务数据库备份" @change="upload" />
        <button class="icon-button" :disabled="pending" @click="uploadInput.click()">上传备份</button><button class="primary-button" :disabled="pending || snapshot.busy" @click="create"><AppIcon name="plus" />立即备份</button>
      </div></div>
      <el-table :data="snapshot.backups" border stripe max-height="560">
        <el-table-column label="备份时间" min-width="180"><template #default="{ row }">{{ new Date(row.createdAt).toLocaleString('zh-CN') }}</template></el-table-column>
        <el-table-column label="来源" width="130"><template #default="{ row }"><span class="status-pill">{{ kindLabels[row.kind] }}</span></template></el-table-column>
        <el-table-column label="大小" width="110"><template #default="{ row }">{{ sizeLabel(row.size) }}</template></el-table-column>
        <el-table-column prop="id" label="文件名" min-width="220" show-overflow-tooltip />
        <el-table-column label="操作" :fixed="wideScreen ? 'right' : false" width="170"><template #default="{ row }"><div class="table-actions"><button class="ghost-button" :disabled="pending" @click="download(row)">下载</button><button class="ghost-button delete-action" :disabled="pending || snapshot.busy" @click="restoreTarget = row; confirmation = ''">恢复</button></div></template></el-table-column>
        <template #empty><EmptyState icon="download" title="暂无备份" description="点击立即备份，保存当前业务数据。" /></template>
      </el-table>
    </SectionCard>
    <FormDialog :open="Boolean(restoreTarget)" title="恢复业务数据" @cancel="!pending && (restoreTarget = null)">
      <form class="form-grid" @submit.prevent="restore">
        <p class="form-note form-span-2">将恢复到 {{ restoreTarget ? new Date(restoreTarget.createdAt).toLocaleString('zh-CN') : '' }} 的备份。当前业务数据将被覆盖，账号不受影响。恢复前会保存保护副本，恢复期间业务写入暂停。</p>
        <p class="form-note form-span-2">请先告知正在录入的同事暂停操作，并在恢复后刷新页面。</p>
        <label class="form-span-2"><span>输入“恢复业务数据”以确认</span><input v-model="confirmation" required autocomplete="off" /></label>
        <div class="form-actions form-span-2"><button class="danger-button" :disabled="pending || confirmation !== '恢复业务数据'">{{ pending ? '校验并恢复中…' : '确认恢复' }}</button></div>
      </form>
    </FormDialog>
  </div>
</template>

<script setup>
import { useWideScreen } from '../composables/useWideScreen.js';
const wideScreen = useWideScreen();
import { onMounted, reactive, ref, watch } from 'vue';
import SectionCard from '../components/SectionCard.vue';
import FormDialog from '../components/FormDialog.vue';
import EmptyState from '../components/EmptyState.vue';
import AppIcon from '../components/AppIcon.vue';
import { useAppData } from '../composables/useAppData.js';
import { useMutation } from '../composables/useMutation.js';
import { desktopApi } from '../lib/desktopApi.js';
const { state, refreshAll } = useAppData();
const { pending, run } = useMutation();
const snapshot = reactive({ backups: [], busy: false, lastError: '' });
const settings = reactive({ enabled: true, intervalHours: 24, retention: 14 });
const uploadInput = ref(null), restoreTarget = ref(null), confirmation = ref('');
const kindLabels = { manual: '手动备份', auto: '自动备份', upload: '上传备份', 'before-restore': '操作前保护', 'before-upgrade': '升级前保护' };
const sizeLabel = size => size < 1024 * 1024 ? `${(size / 1024).toFixed(1)} KB` : `${(size / 1024 / 1024).toFixed(1)} MB`;
async function fetchBackups() { const result = await desktopApi.getBackups(); Object.assign(snapshot, result); Object.assign(settings, result.settings); }
const load = () => run(fetchBackups);
const create = () => run(async () => { await desktopApi.backupDatabase(); await fetchBackups(); }, '业务备份已创建');
const saveSettings = () => run(async () => { await desktopApi.updateBackupSettings(settings); await fetchBackups(); }, '自动备份设置已保存');
const download = row => run(() => desktopApi.downloadBackup(row.id));
async function upload(event) {
  const file = event.target.files?.[0]; event.target.value = '';
  if (!file) return;
  await run(async () => { if (file.size > 100 * 1024 * 1024) throw new Error('备份文件不能超过 100 MB'); await desktopApi.uploadBackup(file); await fetchBackups(); }, '备份已上传并通过校验，可在列表中恢复');
}
const restore = () => run(async () => { await desktopApi.restoreDatabase(restoreTarget.value.id, confirmation.value); restoreTarget.value = null; await refreshAll(); await fetchBackups(); }, '业务数据已恢复，恢复前保护副本已保留');
onMounted(load);
watch(() => state.bootstrap, load);
</script>
