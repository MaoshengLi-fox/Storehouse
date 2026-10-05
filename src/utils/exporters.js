import * as XLSX from 'xlsx';
import { formatDateTime } from './formatters.js';

function appendSheet(workbook, sheetName, rows) {
  const worksheet = XLSX.utils.json_to_sheet(rows);
  const columnCount = rows[0] ? Object.keys(rows[0]).length : 0;
  worksheet['!cols'] = Array.from({ length: columnCount }, () => ({ wch: 16 }));
  XLSX.utils.book_append_sheet(workbook, worksheet, sheetName);
}

export function buildWorkbook(type, records) {
  const workbook = XLSX.utils.book_new();

  if (type === 'stockOrders') {
    appendSheet(workbook, '出入库单', records.map((row) => ({
      单据号: row.orderNo,
      业务类型: row.businessType || row.type,
      日期: row.orderDate,
      送货单号: row.deliveryNo || '',
      委外单号: row.outsourceNo || '',
      加工单号: row.processNo || '',
      物料编码: row.itemCode,
      品名规格: row.specification || row.itemName,
      镀种: row.plating || '',
      数量: row.quantity,
      单位: row.unit,
      单价: row.type === '入库' ? '' : row.unitPrice,
      金额: row.type === '入库' ? '' : row.totalAmount,
      客户: row.partner,
      制表人: row.operator,
      备注: row.remark
    })));
  }

  if (type === 'priceSheets') {
    appendSheet(workbook, '物料与单价', records.map((row) => ({
      物料编码: row.itemCode,
      规格: row.specification || row.itemName,
      镀种: row.plating || '',
      单位: row.unit,
      单价: row.unitPrice,
      分类: row.category || '',
      厂商: row.vendor || row.remark || ''
    })));
  }

  if (type === 'bills') {
    appendSheet(workbook, '账单', records.map((row) => ({
      账单编号: row.billNo || '',
      客户: row.partner || '',
      送货单号: row.deliveryNo,
      加工单号: row.processNo || '',
      出库日期: row.outboundDate || row.orderDate || '',
      物料编码: row.itemCode,
      分类: row.category || '',
      规格: row.specification || row.itemName,
      镀种: row.plating || '',
      数量: row.quantity,
      单价: row.unitPrice,
      总价: row.amount,
      实收金额: row.receivedAmount || 0,
      历史结清: row.legacySettledAmount || 0,
      未收余额: row.voidedAt ? 0 : row.balanceAmount,
      到期日期: row.dueDate || '',
      作废原因: row.voidReason || '',
      状态: row.status || ''
    })));
  }

  if (type === 'inventory') appendSheet(workbook, '库存余额', records.map(r => ({ 物料编码: r.code, 规格: r.specification, 单位: r.unit, 库存数量: r.stockQty, 安全库存: r.safetyStock, 库位: r.location })));
  if (type === 'inventoryLedger') appendSheet(workbook, '库存流水', records.map(r => ({ 业务日期: r.businessDate, 物料编码: r.itemCode, 规格: r.specification, 类型: r.eventType, 变动数量: r.quantityDelta, 操作后结余: r.balanceAfter, 单位: r.unit, 关联单号: r.reference, 操作人: r.operator, 原因: r.remark, 登记时间: formatDateTime(r.createdAt) })));
  if (type === 'receipts') appendSheet(workbook, '收款流水', records.map(r => ({ 收款日期: r.receiptDate, 收款编号: r.receiptNo, 客户: r.partner, 账单编号: r.billNo, 金额: r.amount, 收款方式: r.method, 凭证号: r.reference, 登记人: r.operator, 备注: r.remark, 状态: r.voidedAt ? '已作废' : '有效', 作废原因: r.voidReason })));
  return workbook;
}
