<template>
  <svg class="app-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path v-for="(part, index) in paths[name] || paths.box" :key="index" :d="part" />
  </svg>
</template>

<script setup>
defineProps({ name: { type: String, default: 'box' } });
const paths = {
  printer: ['M6 9V3h12v6 M6 17H3V9h18v8h-3 M6 14h12v7H6z M17 12h1'],
  dashboard: ['M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z'],
  inbound: ['M4 13v7h16v-7 M12 3v12 M7 10l5 5 5-5'],
  outbound: ['M4 13v7h16v-7 M12 15V3 M7 8l5-5 5 5'],
  box: ['m12 3 9 5v9l-9 5-9-5V8z M3 8l9 5 9-5 M12 13v9 M7.5 5.5l9 5v4'],
  bill: ['M6 3h12v18l-3-2-3 2-3-2-3 2z M9 7h6 M9 11h6 M9 15h3'],
  chart: ['M4 3v17h17 M8 15v-4 M13 15V7 M18 15V4'],
  users: ['M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2 M13 6a4 4 0 1 1-8 0 4 4 0 0 1 8 0 M18 3a4 4 0 0 1 0 8 M22 21v-2a4 4 0 0 0-3-3.87'],
  refresh: ['M20 7v5h-5 M4 17v-5h5 M6.1 6.1A8 8 0 0 1 20 12 M4 12a8 8 0 0 0 13.9 5.9'],
  logout: ['M9 21H4V3h5 M10 12h12 M17 7l5 5-5 5'],
  arrow: ['M4 12h16 M14 6l6 6-6 6'],
  chevron: ['m9 5 7 7-7 7'],
  menu: ['M4 6h16 M4 12h16 M4 18h16'],
  close: ['m6 6 12 12 M6 18 18 6'],
  check: ['m5 12 4 4L19 6'],
  shield: ['M12 3 3 7v5c0 5 9 9 9 9s9-4 9-9V7z m-4 9 3 3 5-6'],
  calendar: ['M4 5h16v16H4z M8 3v4 M16 3v4 M4 11h16 M8 15h2 M14 15h2'],
  plus: ['M12 5v14 M5 12h14'],
  wallet: ['M3 5h16v4 M3 5v14h18V9H7a4 4 0 0 1-4-4 M16 13h5v4h-5z'],
  alert: ['m12 3 10 18H2z M12 9v4 M12 17h.01'],
  clock: ['M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0 M12 7v5l3 2'],
  factory: ['M3 21V10l6 3V7l6 4V3h5l1 18z M7 17h1 M12 17h1 M17 17h1'],
  search: ['M19 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0 m-2 5 5 6'],
  download: ['M4 16v5h16v-5 M12 3v12 m-5-5 5 5 5-5']
};
</script>
