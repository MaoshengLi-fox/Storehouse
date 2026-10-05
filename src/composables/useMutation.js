import { ref } from 'vue';
import { useNotifier } from './useNotifier.js';

export function useMutation() {
  const pending = ref(false);
  const { notifyError, notifySuccess } = useNotifier();
  async function run(action, message) {
    if (pending.value) return false;
    pending.value = true;
    try {
      await action();
      if (message) notifySuccess(message);
      return true;
    } catch (error) {
      notifyError(error.message || '操作失败，请重试');
      return false;
    } finally { pending.value = false; }
  }
  return { pending, run };
}
