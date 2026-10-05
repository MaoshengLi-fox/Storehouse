<template>
  <el-dialog
    :model-value="open"
    :title="title"
    width="min(480px, calc(100vw - 32px))"
    align-center
    destroy-on-close
    @close="$emit('cancel')"
  >
    <p>{{ message }}</p>
    <template #footer>
      <el-button @click="$emit('cancel')">取消</el-button>
      <el-button type="danger" @click="$emit('confirm')">{{ confirmLabel }}</el-button>
    </template>
  </el-dialog>
</template>

<script setup>
defineProps({
  open: Boolean,
  confirmLabel: { type: String, default: '确认删除' },
  title: {
    type: String,
    default: '确认删除'
  },
  message: {
    type: String,
    default: '删除后无法恢复，请确认是否继续。'
  }
});

defineEmits(['cancel', 'confirm']);
</script>
