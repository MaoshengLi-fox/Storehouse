// Business-type labels used by stock orders. The labels are kept as recorded so
// they can be counted separately in reports, while the rules below decide how
// each label affects batches, billing and printing.
export const INBOUND_TYPES = Object.freeze(['正常入库', '退胚回库', '不良退回']);
export const OUTBOUND_TYPES = Object.freeze(['成品出货', '退胚', '返工出货']);
export const RECEIPT_TYPES = Object.freeze(['正常入库', '退胚回库']); // 收货：客户送来待加工的胚料
export const CUSTOMER_RETURN_TYPE = '不良退回'; // 退货：客户退回的已加工品
export const FREE_OUTBOUND_TYPES = Object.freeze(['退胚', '返工出货']); // 不计加工费、不开账单

export const isFreeOutbound = (order = {}) => FREE_OUTBOUND_TYPES.includes(order.businessType);
export const defaultBusinessType = (type) => (type === '出库' ? '成品出货' : '正常入库');

const round = (value) => Number(Number(value || 0).toFixed(6));

// A batch is one customer's goods for one material under one 加工单号.
export function batchKey(order = {}) {
  return JSON.stringify([order.customerId ?? null, Number(order.itemId), String(order.processNo || '').trim()]);
}

export function summarizeBatch(orders = []) {
  const sum = (predicate) => round(orders.filter(predicate).reduce((total, o) => total + Number(o.quantity || 0), 0));
  const received = sum((o) => o.type === '入库' && RECEIPT_TYPES.includes(o.businessType));
  const customerReturned = sum((o) => o.type === '入库' && o.businessType === CUSTOMER_RETURN_TYPE);
  const shipped = sum((o) => o.type === '出库' && !FREE_OUTBOUND_TYPES.includes(o.businessType));
  const blankReturned = sum((o) => o.type === '出库' && o.businessType === '退胚');
  const reworkShipped = sum((o) => o.type === '出库' && o.businessType === '返工出货');
  return {
    received, shipped, blankReturned, customerReturned, reworkShipped,
    blankAvailable: round(received - shipped - blankReturned),
    reworkAvailable: round(customerReturned - reworkShipped)
  };
}

// Returns the problem with a batch, or '' when its quantities are consistent.
// `upstream` is true when the change was made to another record of the batch (a receipt,
// a 成品出货, a 不良退回…) rather than to the 退胚 / 返工出货 itself, so the wording tells
// the user which record needs attention first.
export function batchProblem(summary, processNo, upstream = false) {
  if (summary.blankReturned > 0 && summary.blankAvailable < 0) {
    const over = round(-summary.blankAvailable);
    if (!summary.received) {
      return upstream
        ? `此操作后，加工单号 ${processNo} 已登记的退胚 ${summary.blankReturned} 将没有对应的收货记录，请先撤销该批次的退胚`
        : `加工单号 ${processNo} 没有该客户该物料的收货记录，不能退胚`;
    }
    const detail = `收货 ${summary.received}，成品出货 ${summary.shipped}，退胚合计 ${summary.blankReturned}，超出 ${over}`;
    return upstream
      ? `此操作后，加工单号 ${processNo} 的退胚将超出可退数量（${detail}），请先调整或撤销该批次的退胚`
      : `加工单号 ${processNo} 退胚超出可退数量：${detail}`;
  }
  if (summary.reworkShipped > 0 && summary.reworkAvailable < 0) {
    const over = round(-summary.reworkAvailable);
    if (!summary.customerReturned) {
      return upstream
        ? `此操作后，加工单号 ${processNo} 已登记的返工出货 ${summary.reworkShipped} 将没有对应的不良退回记录，请先撤销该批次的返工出货`
        : `加工单号 ${processNo} 没有该客户该物料的不良退回记录，不能返工出货`;
    }
    const detail = `不良退回 ${summary.customerReturned}，返工出货合计 ${summary.reworkShipped}，超出 ${over}`;
    return upstream
      ? `此操作后，加工单号 ${processNo} 的返工出货将超出不良退回数量（${detail}），请先调整或撤销该批次的返工出货`
      : `加工单号 ${processNo} 返工出货超出退货数量：${detail}`;
  }
  return '';
}
