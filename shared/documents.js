export const DOCUMENT_KINDS = Object.freeze({ statement: '客户对账单', delivery: '出货单', 'blank-return': '退胚单' });
export const isBlankReturn = (order) => order.businessType === '退胚';
export const PRINT_DEFAULTS = Object.freeze({
  companyName: '东莞市冠碣五金制品有限公司',
  address: '广东省东莞沙田镇丽海路1号',
  phone: '13600254478', email: '3111265898@qq.com', fax: '0769-81610378',
  statementNote: '以上对账单若有错漏，敬请及时与我司财务联系，烦请七天内确认签名并回传本公司，无回传视为默认此对账金额，敬谢合作！',
  deliveryNote: '1.本厂所送上列货品，经贵公司确认单价、规格、数量等无误后签收确认，如有发现品质问题或细数不符时，应于收货之日起7日内书面向本厂提出，但请贵公司务必保持该货品原状，逾期或一经贵公司使用，当收妥论。\n2.本厂不承担上列所交货品本身品质以外的任何责任。多谢合作！'
});

export const PAPER_PRESETS = Object.freeze([
  { id: 'continuous-241-half', label: '241 × 139.7 mm · 连续纸二等分', width: 241, height: 139.7 },
  { id: 'continuous-241-third', label: '241 × 93.1 mm · 连续纸三等分', width: 241, height: 93.1 },
  { id: 'continuous-241-full', label: '241 × 279.4 mm · 连续纸整张', width: 241, height: 279.4 },
  { id: 'continuous-190-half', label: '190 × 139.7 mm · 窄幅二等分', width: 190, height: 139.7 },
  { id: 'continuous-190-full', label: '190 × 279.4 mm · 窄幅整张', width: 190, height: 279.4 },
  { id: 'a4-landscape', label: 'A4 横向 · 297 × 210 mm', width: 297, height: 210 },
  { id: 'a4-portrait', label: 'A4 纵向 · 210 × 297 mm', width: 210, height: 297 },
  { id: 'a5-landscape', label: 'A5 横向 · 210 × 148 mm', width: 210, height: 148 }
]);

export function normalizePaper(input = {}, kind = 'delivery') {
  const presetId = input.preset || (kind === 'statement' ? 'a4-landscape' : 'continuous-241-half');
  const preset = PAPER_PRESETS.find(p => p.id === presetId);
  if (!preset && presetId !== 'custom') throw new Error('请选择有效的纸张规格');
  const width = Number(preset?.width ?? input.width), height = Number(preset?.height ?? input.height);
  const margin = Number(input.margin ?? 5);
  if (!Number.isFinite(width) || width < 120 || width > 420 || !Number.isFinite(height) || height < 80 || height > 600) throw new Error('纸宽需为 120–420 mm，纸高需为 80–600 mm');
  if (!Number.isFinite(margin) || margin < 0 || margin > 20 || height - margin * 2 < 65) throw new Error('页边距需为 0–20 mm，并为正文保留足够空间');
  return { preset: presetId, width, height, margin };
}

export function statementTitle(startDate, endDate) {
  const last = new Date(`${startDate.slice(0, 7)}-01T00:00:00Z`);
  last.setUTCMonth(last.getUTCMonth() + 1, 0);
  return startDate.endsWith('-01') && endDate === last.toISOString().slice(0, 10)
    ? `${Number(startDate.slice(0, 4))}年${Number(startDate.slice(5, 7))}月对账单`
    : `${startDate} 至 ${endDate} 对账单`;
}

export function groupDocumentRows(rows, kind) {
  if (kind === 'statement') return [{ key: 'statement', rows }];
  const groups = new Map();
  for (const row of rows) {
    // Reused delivery numbers on different dates/customers must never share a printed form.
    const key = JSON.stringify([row.customerId, row.orderDate, row.deliveryNo || row.orderNo, row.businessType]);
    if (!groups.has(key)) groups.set(key, { key, rows: [] });
    groups.get(key).rows.push(row);
  }
  return [...groups.values()];
}
