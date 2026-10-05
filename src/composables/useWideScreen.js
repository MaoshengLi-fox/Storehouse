import { onBeforeUnmount, ref } from 'vue';

// True on screens wide enough to pin a table's action column to the right.
// On phones a pinned column covers most of the table, so it scrolls with the rows instead.
export function useWideScreen(query = '(min-width: 900px)') {
  const media = typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(query) : null;
  const wide = ref(media ? media.matches : true);
  const update = (event) => { wide.value = event.matches; };
  media?.addEventListener?.('change', update);
  onBeforeUnmount(() => media?.removeEventListener?.('change', update));
  return wide;
}
