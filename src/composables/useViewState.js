import { reactive } from 'vue';
import { todayString } from '../utils/formatters.js';

const store = reactive({
  inbound: {
    keyword: '',
    filters: {
      startDate: todayString(),
      endDate: todayString(),
      type: '入库'
    },
    sort: {
      key: 'orderDate',
      direction: 'desc'
    }
  },
  outbound: {
    keyword: '',
    filters: {
      startDate: todayString(),
      endDate: todayString(),
      type: '出库'
    },
    sort: {
      key: 'orderDate',
      direction: 'desc'
    }
  },
  bills: {
    keyword: '',
    filters: {
      startDate: todayString(),
      endDate: todayString()
    },
    sort: {
      key: 'billDate',
      direction: 'desc'
    }
  },
  prices: {
    keyword: '',
    filters: {
      startDate: todayString(),
      endDate: todayString()
    },
    sort: {
      key: 'itemCode',
      direction: 'asc'
    }
  }
});

export function useViewState(key) {
  return store[key];
}
