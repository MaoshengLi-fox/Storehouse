import { reactive } from 'vue';

const notifications = reactive([]);

function notify(type, text) {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  notifications.push({ id, type, text });

  window.setTimeout(() => {
    const index = notifications.findIndex((item) => item.id === id);
    if (index >= 0) {
      notifications.splice(index, 1);
    }
  }, 3000);
}

export function useNotifier() {
  return {
    notifications,
    notifySuccess: (text) => notify('success', text),
    notifyError: (text) => notify('error', text),
    notifyInfo: (text) => notify('info', text)
  };
}
