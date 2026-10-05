<template>
  <el-dialog
    :model-value="open"
    :title="title"
    width="min(760px, calc(100vw - 32px))"
    align-center
    :close-on-click-modal="false"
    :close-on-press-escape="false"
    destroy-on-close
    @close="$emit('cancel')"
  >
    <div class="form-dialog-body">
      <slot />
    </div>
  </el-dialog>
</template>

<script setup>
defineProps({
  open: Boolean,
  title: {
    type: String,
    default: '填写信息'
  }
});

defineEmits(['cancel']);
</script>
