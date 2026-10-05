<template>
  <div class="document-preview">
    <div class="preview-toolbar"><span>{{ ready ? `打印预览 · 共 ${pages} 页` : '正在排版…' }}</span><button class="primary-button" :disabled="!ready" @click="print"><AppIcon name="printer" />打印 / 保存 PDF</button></div>
    <p v-if="error" class="field-warning" role="alert">{{ error }}</p>
    <iframe ref="frame" :srcdoc="html" title="单据打印预览" @load="layout" />
  </div>
</template>

<script setup>
import { computed, ref, watch } from 'vue';
import AppIcon from './AppIcon.vue';
import { buildDocumentHtml, paginatePrintDocument } from '../utils/printDocuments.js';
const props = defineProps({ document: { type: Object, required: true }, paper: { type: Object, required: true } });
const frame = ref(null), ready = ref(false), pages = ref(0), error = ref('');
const html = computed(() => buildDocumentHtml(props.document, props.paper));
watch(html, () => { ready.value = false; error.value = ''; }, { flush: 'sync' });
async function layout() {
  const dom = frame.value?.contentDocument;
  if (!dom) return;
  try {
    await dom.fonts.ready;
    if (dom !== frame.value?.contentDocument) return;
    pages.value = paginatePrintDocument(dom);
    ready.value = pages.value > 0;
    fitToFrame();
  } catch (e) { error.value = e.message; ready.value = false; }
}
// On narrow screens (phones) scale the sheets down to the preview width; printing always uses real size.
function fitToFrame() {
  const dom = frame.value?.contentDocument, page = dom?.querySelector('.print-page');
  if (!dom || !page) return;
  dom.body.style.zoom = '';
  const available = frame.value.clientWidth - 24, width = page.getBoundingClientRect().width;
  dom.body.style.zoom = width > available && available > 0 ? String(available / width) : '';
}
function print() {
  if (!ready.value) return;
  const win = frame.value.contentWindow, body = win.document.body, zoom = body.style.zoom;
  body.style.zoom = '';
  win.addEventListener('afterprint', () => { body.style.zoom = zoom; }, { once: true });
  win.focus();
  win.print();
}
</script>
