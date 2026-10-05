<template>
  <div class="empty-state">
    <span class="empty-state-icon"><AppIcon :name="icon" /></span>
    <strong>{{ title }}</strong>
    <p>{{ description }}</p>
    <slot />
  </div>
</template>

<script setup>
import AppIcon from './AppIcon.vue';
defineProps({
  icon: { type: String, default: 'box' },
  title: { type: String, default: '暂时没有记录' },
  description: { type: String, default: '新增一条记录，开始管理你的业务。' }
});
</script>
