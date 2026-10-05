<template>
  <section class="section-card">
    <div v-if="title || subtitle" class="section-head">
      <div>
        <h3>{{ title }}</h3>
        <p v-if="subtitle">{{ subtitle }}</p>
      </div>
      <slot name="action" />
    </div>
    <slot />
  </section>
</template>

<script setup>
defineProps({
  title: {
    type: String,
    default: ''
  },
  subtitle: {
    type: String,
    default: ''
  }
});
</script>
