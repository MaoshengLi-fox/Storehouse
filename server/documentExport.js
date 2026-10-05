import fs from 'node:fs';
import XLSX from 'xlsx';
import { normalizePaper } from '../shared/documents.js';

// Keep the template's fonts, borders and number formats. The runtime fills only
// worksheet XML; no authoring runtime or external service is needed on the server.
const template = fs.readFileSync(new URL('./templates/document-styles.xlsx', import.meta.url));
const xml = value => String(value ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
function entry(zip, name) {
  const index = zip.FullPaths.findIndex(p => p.endsWith(`/${name}`));
  if (index < 0) throw new Error(`缺少打印模板资源：${name}`);
  return zip.FileIndex[index];
}
function replace(zip, name, text) { const file = entry(zip, name); file.content = Buffer.from(text); file.size = file.content.length; }

export function exportDocumentWorkbook(document, paperInput = {}) {
  if (!document.rows.length) throw new Error('没有可导出的明细');
  const paper = normalizePaper(paperInput, document.kind);
  const zip = XLSX.CFB.read(template, { type: 'buffer' });
  const styles = {};
  for (const match of Buffer.from(entry(zip, 'xl/worksheets/sheet1.xml').content).toString().matchAll(/<(?:\w+:)?c\b([^>]+)>/g)) {
    const address = match[1].match(/\br="A(\d+)"/), style = match[1].match(/\bs="(\d+)"/);
    if (address) styles[Number(address[1])] = style?.[1] || '0';
  }
  if (Object.keys(styles).length !== 14) throw new Error('打印模板样式不完整');
  const statement = document.kind === 'statement', returned = document.kind === 'blank-return';
  const widthPercent = statement ? [3, 8, 10, 9, 12, 27, 6, 7, 5, 7, 6] : [3, 12, 16, 34, 10, 10, 13, 2];
  const lastCol = statement ? 'K' : 'H', rowXml = [], merges = [], breaks = [];
  let row = 0;
  const textCell = (col, value, style = 6) => `<c r="${col}${row}" s="${styles[style]}" t="inlineStr"><is><t xml:space="preserve">${xml(value)}</t></is></c>`;
  const numberCell = (col, value, style = 8, formula = '') => `<c r="${col}${row}" s="${styles[style]}">${formula ? `<f>${xml(formula)}</f>` : ''}<v>${Number(value)}</v></c>`;
  const dateCell = (col, value) => numberCell(col, (Date.parse(`${value}T00:00:00Z`) - Date.UTC(1899, 11, 30)) / 86400000, 7);
  const addRow = (makeCells, height = 22) => { row++; rowXml.push(`<row r="${row}" ht="${height}" customHeight="1">${makeCells()}</row>`); };
  const mergedRow = (value, style, height, end = lastCol) => { addRow(() => textCell('A', value, style), height); merges.push(`A${row}:${end}${row}`); };
  const cells = (values, style = 6) => values.map((v, i) => textCell(String.fromCharCode(65 + i), v, style)).join('');
  const rowHeight = (values) => Math.max(22, ...values.map((value, i) => {
    const units = [...String(value ?? '')].reduce((n, c) => n + (c.charCodeAt(0) < 128 ? .55 : 1), 0);
    const availablePoints = (paper.width - paper.margin * 2) * 2.83465 * widthPercent[i] / 100 - 5;
    return Math.ceil(units * 10 / Math.max(10, availablePoints)) * 12 + 5;
  }));
  const contact = [document.settings.phone && `联系电话：${document.settings.phone}`, document.settings.email && `邮箱：${document.settings.email}`].filter(Boolean).join('　');
  if (statement) {
    mergedRow(document.settings.companyName, 1, 32);
    mergedRow(contact, 2, 22);
    mergedRow(document.title, 3, 27);
    addRow(() => textCell('A', `客户：${document.customer.name}`, 4) + textCell('D', '币种：RMB', 4) + textCell('G', `账期：${document.customer.settlementDays}天`, 4) + textCell('I', `${document.startDate} 至 ${document.endDate}`, 4), 30);
    merges.push('A4:C4', 'D4:F4', 'G4:H4', 'I4:K4');
    addRow(() => cells(['序号', '送货日期', '送货单号', '订单号', '物料编码', '品名规格', '镀种', '交货数量', '单价', '金额', '备注'], 5), 26);
    for (const r of document.rows) {
      const values = [r.sequence, r.orderDate, r.deliveryNo, r.processNo || r.outsourceNo, r.itemCode, r.specification || r.itemName, r.plating, r.quantity, r.unitPrice, r.amount, r.remark];
      addRow(() => numberCell('A', r.sequence) + dateCell('B', r.orderDate) + ['C', 'D', 'E', 'F', 'G'].map((c, i) => textCell(c, values[i + 2])).join('') + numberCell('H', r.quantity) + numberCell('I', r.unitPrice, 9) + numberCell('J', r.amount, 10) + textCell('K', r.remark), rowHeight(values));
    }
    const lastDataRow = row;
    addRow(() => textCell('A', document.partial ? '所选明细合计' : '合计', 5) + numberCell('H', document.totals.quantity, 8, `SUM(H6:H${lastDataRow})`) + numberCell('J', document.totals.amount, 11, `SUM(J6:J${lastDataRow})`), 26);
    merges.push(`A${row}:G${row}`);
    mergedRow(document.settings.statementNote, 12, 34);
    mergedRow(`客户确认：________________　　制表：${document.preparedBy}　　制单日期：${document.issuedDate}`, 13, 25);
    mergedRow(document.settings.companyName, 2, 22);
  } else {
    for (const group of document.groups) {
      for (let offset = 0; offset < group.rows.length; offset += 8) {
        if (row) breaks.push(row);
        const first = group.rows[0], begin = row;
        mergedRow(document.settings.companyName, 1, 32);
        mergedRow(`地址：${document.settings.address}`, 2, 21);
        addRow(() => textCell('A', [document.settings.phone && `电话：${document.settings.phone}`, document.settings.email && `邮箱：${document.settings.email}`, document.settings.fax && `传真：${document.settings.fax}`].filter(Boolean).join('　'), 2) + textCell('F', `NO:${first.deliveryNo || first.orderNo}`, 4), 21);
        merges.push(`A${row}:E${row}`, `F${row}:H${row}`);
        addRow(() => textCell('A', `客户：${document.customer.name}`, 4) + textCell('D', returned ? '退货单（退胚）' : first.businessType === '返工出货' ? '出货单（返工）' : '出货单', 3) + textCell('F', `${returned ? '退货' : '出货'}日期：${first.orderDate}`, 4), 26);
        merges.push(`A${row}:C${row}`, `D${row}:E${row}`, `F${row}:H${row}`);
        addRow(() => cells(returned ? ['序', '单号', '型号', '品名规格', '镀种', '退货数量', '备注'] : ['序', '加工单号', '物料编码', '规格/尺寸', '镀种', '交货数量', '备注'], 5) + textCell('H', [...'1存根（白）2客户（红）3仓库（黄）4采购（蓝）'].join('\n'), 14), 24);
        merges.push(`H${row}:H${row + 8}`);
        for (let i = 0; i < 8; i++) {
          const r = group.rows[offset + i];
          if (!r) { addRow(() => cells(['', '', '', '', '', '', '']), 22); continue; }
          const values = [offset + i + 1, r.processNo || r.outsourceNo, r.itemCode, r.specification || r.itemName, r.plating, r.quantity, r.remark];
          addRow(() => numberCell('A', values[0]) + ['B', 'C', 'D', 'E'].map((c, j) => textCell(c, values[j + 1])).join('') + numberCell('F', r.quantity) + textCell('G', r.remark), rowHeight(values));
        }
        mergedRow(`客户：　　　　　　　　　${returned ? '审核：　　　　　' : ''}生管：　　　　　　　　制表：${document.preparedBy || first.operator}`, 13, 25);
        mergedRow(document.settings.deliveryNote, 12, 40);
        mergedRow(`第 ${Math.floor(offset / 8) + 1} / ${Math.ceil(group.rows.length / 8)} 页`, 2, 16);
        if (row <= begin) throw new Error('导出单据排版失败');
      }
    }
  }
  const columns = widthPercent.map((p, i) => `<col min="${i + 1}" max="${i + 1}" width="${((paper.width - paper.margin * 2) * 96 / 25.4 * p / 100 - 5) / 7}" customWidth="1"/>`).join('');
  const margin = paper.margin / 25.4;
  const worksheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetPr><pageSetUpPr fitToPage="1"/></sheetPr><dimension ref="A1:${lastCol}${row}"/><sheetViews><sheetView workbookViewId="0" showGridLines="0"/></sheetViews><sheetFormatPr defaultRowHeight="22"/><cols>${columns}</cols><sheetData>${rowXml.join('')}</sheetData><mergeCells count="${merges.length}">${merges.map(m => `<mergeCell ref="${m}"/>`).join('')}</mergeCells><printOptions horizontalCentered="1"/><pageMargins left="${margin}" right="${margin}" top="${margin}" bottom="${margin}" header="0" footer="0"/><pageSetup paperWidth="${paper.width}mm" paperHeight="${paper.height}mm" orientation="portrait" fitToWidth="1" fitToHeight="0"/>${breaks.length ? `<rowBreaks count="${breaks.length}" manualBreakCount="${breaks.length}">${breaks.map(id => `<brk id="${id}" max="16383" man="1"/>`).join('')}</rowBreaks>` : ''}</worksheet>`;
  replace(zip, 'xl/worksheets/sheet1.xml', worksheet);
  const sheetName = statement ? '客户对账单' : returned ? '退胚单' : '出货单';
  let workbook = Buffer.from(entry(zip, 'xl/workbook.xml').content).toString().replace(/name="模板"/, `name="${sheetName}"`).replace(/<(?:\w+:)?definedNames[\s\S]*?<\/(?:\w+:)?definedNames>/, '');
  const names = `<definedNames xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><definedName name="_xlnm.Print_Area" localSheetId="0">'${sheetName}'!$A$1:$${lastCol}$${row}</definedName>${statement ? `<definedName name="_xlnm.Print_Titles" localSheetId="0">'${sheetName}'!$1:$5</definedName>` : ''}</definedNames>`;
  workbook = workbook.replace(/<\/(?:\w+:)?sheets>/, closing => `${closing}${names}`);
  replace(zip, 'xl/workbook.xml', workbook);
  return XLSX.CFB.write(zip, { type: 'buffer', fileType: 'zip', compression: true });
}
