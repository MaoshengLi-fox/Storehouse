import * as XLSX from 'xlsx';

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
      单价: row.unitPrice,
      金额: row.totalAmount,
      客户: row.partner,
      制表人: row.operator,
      备注: row.remark
    })));
  }

  if (type === 'priceSheets') {
    appendSheet(workbook, '物料与单价', records.map((row) => ({
      单价单号: row.sheetNo || '-',
      物料编码: row.itemCode,
      品名规格: row.specification || row.itemName,
      加工说明: row.processNote || '',
      镀种: row.plating || '',
      单位: row.unit,
      库存: row.stockQty ?? '',
      单价: row.unitPrice,
      生效日期: row.effectiveDate,
      备注: row.remark
    })));
  }

  if (type === 'bills') {
    appendSheet(workbook, '账单', records.map((row) => ({
      对账单号: row.billNo,
      对账月份: row.statementMonth,
      客户: row.partner,
      来源单据类型: row.stockOrderType || '',
      业务类型: row.businessType || '',
      币种: row.currency,
      结算方式: row.settlementMethod,
      业务日期: row.orderDate,
      业务单号: row.deliveryNo,
      委外单号: row.outsourceNo,
      加工单号: row.processNo,
      物料编码: row.itemCode,
      品名规格: row.specification || row.itemName,
      镀种: row.plating || '',
      数量: row.quantity,
      单价: row.unitPrice,
      金额: row.amount,
      状态: row.status,
      对账日期: row.billDate,
      到期日期: row.dueDate,
      备注: row.remark
    })));
  }

  return workbook;
}
