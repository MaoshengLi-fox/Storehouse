import { normalizePaper } from '../../shared/documents.js';

export const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const quantity = value => Number(value || 0).toLocaleString('zh-CN', { maximumFractionDigits: 6 });
const money = value => Number(value || 0).toFixed(2);
const chineseDate = date => `${Number(date.slice(0, 4))}年${Number(date.slice(5, 7))}月${Number(date.slice(8, 10))}日`;

export function buildDocumentHtml(document, options = {}) {
  const paper = normalizePaper(options, document.kind);
  const statement = document.kind === 'statement', returned = document.kind === 'blank-return';
  const settings = document.settings;
  const widths = statement ? [3, 8, 10, 9, 12, 27, 6, 7, 5, 7, 6] : returned ? [3, 13, 16, 34, 10, 10, 14] : [3, 12, 16, 36, 10, 10, 13];
  const labels = statement
    ? ['序号', '送货日期', '送货单号', '订单号', '物料编码', '品名规格', '镀种', '交货数量', '单价', '金额', '备注']
    : returned ? ['序', '单号', '型号', '品名规格', '镀种', '退货数量', '备注']
      : ['序', '加工单号', '物料编码', '规格/尺寸', '镀种', '交货数量', '备注'];
  const groups = document.groups.filter(g => g.rows.length);
  const pages = groups.map((group, groupIndex) => {
    const first = group.rows[0];
    const rows = group.rows.map((r, i) => {
      const cells = statement
        ? [r.sequence, r.orderDate, r.deliveryNo, r.processNo || r.outsourceNo, r.itemCode, r.specification || r.itemName, r.plating, quantity(r.quantity), quantity(r.unitPrice), money(r.amount), r.remark]
        : [i + 1, r.processNo || r.outsourceNo, r.itemCode, r.specification || r.itemName, r.plating, quantity(r.quantity), r.remark];
      return `<tr data-record-id="${r.id}" data-quantity="${r.quantity}" data-amount="${r.amount}">${cells.map((v, j) => `<td class="${j === (statement ? 5 : 3) || j === cells.length - 1 ? 'description' : ''}">${escapeHtml(v)}</td>`).join('')}</tr>`;
    }).join('');
    const header = statement ? `
      <h1>${escapeHtml(settings.companyName)}</h1>
      <div class="company-contact">${escapeHtml([settings.phone && `联系电话：${settings.phone}`, settings.email && `邮箱：${settings.email}`].filter(Boolean).join('　'))}</div>
      <h2>${escapeHtml(document.title)}</h2>
      <div class="document-meta"><span>客户：${escapeHtml(document.customer.name)}</span><span>币种：RMB</span><span>账期：${document.customer.settlementDays}天</span><span>${document.partial ? '所选明细 · ' : ''}${escapeHtml(document.startDate)} 至 ${escapeHtml(document.endDate)}</span></div>` : `
      <h1>${escapeHtml(settings.companyName)}</h1>
      <div class="company-contact">地址：${escapeHtml(settings.address)}</div>
      <div class="document-contact"><span>${escapeHtml([settings.phone && `电话：${settings.phone}`, settings.email && `邮箱：${settings.email}`, settings.fax && `传真：${settings.fax}`].filter(Boolean).join('　'))}</span><strong>NO:${escapeHtml(first.deliveryNo || first.orderNo)}</strong></div>
      <div class="document-meta"><strong>客户：${escapeHtml(document.customer.name)}</strong><h2>${returned ? '退货单（退胚）' : first.businessType === '返工出货' ? '出货单（返工）' : '出货单'}</h2><strong>${returned ? '退货' : '出货'}日期：${escapeHtml(chineseDate(first.orderDate))}</strong></div>`;
    const footer = statement ? `
      <div class="statement-sum"><span class="page-sum"></span><strong class="grand-total">${document.partial ? '所选明细合计' : '对账合计'}：${money(document.totals.amount)} 元</strong></div>
      <p class="terms">${escapeHtml(settings.statementNote)}</p><div class="signatures"><span>客户确认：________________</span><span>制表：${escapeHtml(document.preparedBy)}</span><span>${escapeHtml(document.issuedDate)}<br>${escapeHtml(settings.companyName)}</span></div>` : `
      <div class="signatures"><span>客户：</span>${returned ? '<span>审核：</span>' : ''}<span>生管：</span><span>制表：${escapeHtml(document.preparedBy || first.operator)}</span></div>
      <p class="terms">${escapeHtml(settings.deliveryNote)}</p>`;
    return `<section class="print-page" data-group="${groupIndex}"><div class="page-body"><header>${header}</header><div class="form-table"><table><colgroup>${widths.map(w => `<col style="width:${w}%">`).join('')}</colgroup><thead><tr>${labels.map(t => `<th>${t}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table>${statement ? '' : '<aside class="copy-label">1存根（白）　2客户（红）　3仓库（黄）　4采购（蓝）</aside>'}</div><footer>${footer}</footer><div class="page-end"></div></div><div class="page-number"></div></section>`;
  }).join('');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${escapeHtml(document.customer.name)}-${escapeHtml(document.title)}</title><style>
    @page { size: ${paper.width}mm ${paper.height}mm; margin: 0; }
    * { box-sizing: border-box; } html,body { margin:0; padding:0; } body { color:#000; background:#e9ece8; font-family:SimSun,"Songti SC","Microsoft YaHei",serif; }
    .print-page { width:${paper.width}mm; height:calc(${paper.height}mm - .3mm); padding:${paper.margin}mm; padding-bottom:${paper.margin + 4}mm; background:#fff; position:relative; margin:12px auto; box-shadow:0 1px 8px #0002; break-after:page; }
    .print-page:last-child { break-after:auto; } h1 { font-size:${paper.height < 110 ? 15 : 19}pt; text-align:center; margin:0 0 1mm; font-weight:700; line-height:1.2; } h2 { font-size:${statement ? 14 : 12}pt; text-align:center; margin:1mm 0; line-height:1.2; }
    .company-contact { text-align:center; font-size:9pt; line-height:1.3; } .document-contact { display:flex; justify-content:space-between; align-items:center; font-size:9pt; margin:1mm 0; gap:3mm; }
    .document-meta { display:flex; gap:3mm; justify-content:space-between; align-items:center; margin:1mm 0; font-size:9pt; } .document-meta h2 { flex:1; } .document-meta span,.document-meta strong { overflow-wrap:anywhere; }
    .form-table { position:relative; padding-right:${statement ? 0 : 3}mm; } table { width:100%; border-collapse:collapse; table-layout:fixed; font-size:${statement ? 9 : 10}pt; line-height:1.25; }
    th,td { border:.25mm solid #000; padding:${paper.height < 110 ? '.55mm' : '.8mm'} .7mm; text-align:center; vertical-align:middle; overflow-wrap:anywhere; } th { font-weight:600; } td.description { text-align:left; white-space:pre-wrap; } td { height:${statement ? 7 : 7.4}mm; } tr { break-inside:avoid; }
    .copy-label { writing-mode:vertical-rl; position:absolute; top:0; bottom:0; right:-.5mm; width:3mm; font-size:6.5pt; line-height:3mm; letter-spacing:0; white-space:nowrap; overflow:hidden; text-align:center; }
    .signatures { display:flex; justify-content:space-between; align-items:flex-start; gap:3mm; font-size:10pt; padding:1.3mm 0; min-height:6mm; } .signatures span { min-width:18%; overflow-wrap:anywhere; } .signatures span:last-child { text-align:right; }
    .terms { margin:.7mm 0 0; font-size:${paper.height < 110 ? 7 : 8}pt; line-height:1.4; white-space:pre-wrap; overflow-wrap:anywhere; } .statement-sum { display:flex; justify-content:space-between; border-bottom:.25mm solid #000; padding:2mm 0; font-size:10pt; }
    .page-number { position:absolute; right:${paper.margin}mm; bottom:${Math.max(1, paper.margin - 1)}mm; font:8pt sans-serif; } .page-end { height:.1px; } .print-page:not(.last-in-group) .grand-total { visibility:hidden; }
    @media print { html,body { background:white; } .print-page { margin:0; box-shadow:none; } }
  </style></head><body data-kind="${document.kind}">${pages}</body></html>`;
}

// Use the browser's actual font metrics so long specifications move to the next
// physical sheet rather than being clipped or squeezed into an eight-row form.
export function paginatePrintDocument(dom) {
  const statement = dom.body.dataset.kind === 'statement';
  const sources = [...dom.querySelectorAll('.print-page')];
  const pageFits = page => {
    const style = dom.defaultView.getComputedStyle(page);
    return page.querySelector('.page-end').getBoundingClientRect().bottom <= page.getBoundingClientRect().bottom - parseFloat(style.paddingBottom) + 0.5;
  };
  for (const source of sources) {
    const rows = [...source.querySelectorAll('tbody tr')];
    const template = source.cloneNode(true);
    template.querySelector('tbody').replaceChildren();
    const pages = [];
    const addPage = () => {
      const page = template.cloneNode(true);
      source.before(page); pages.push(page); return page;
    };
    let page = addPage();
    for (const row of rows) {
      let tbody = page.querySelector('tbody');
      if (!statement && tbody.children.length >= 8) { page = addPage(); tbody = page.querySelector('tbody'); }
      tbody.append(row);
      if (!pageFits(page)) {
        row.remove();
        if (!tbody.children.length) throw new Error('当前纸张放不下完整表头、明细和签收说明，请选择更高的纸张或减小边距');
        page = addPage(); page.querySelector('tbody').append(row);
        if (!pageFits(page)) throw new Error('单条规格或说明超过一页，请增大纸张尺寸');
      }
    }
    pages.forEach((p, index) => {
      p.classList.toggle('last-in-group', index === pages.length - 1);
      const tbody = p.querySelector('tbody');
      const realRows = [...tbody.children];
      if (!statement) {
        while (tbody.children.length < 8) {
          const blank = dom.createElement('tr'); blank.className = 'blank-row';
          blank.innerHTML = '<td>&nbsp;</td>'.repeat(7); tbody.append(blank);
          if (!pageFits(p)) { blank.remove(); break; }
        }
      } else {
        const total = realRows.reduce((n, r) => n + Math.round(Number(r.dataset.amount) * 100), 0) / 100;
        p.querySelector('.page-sum').textContent = `本页金额：${money(total)} 元`;
      }
      p.querySelector('.page-number').textContent = `第 ${index + 1} / ${pages.length} 页`;
    });
    source.remove();
  }
  return dom.querySelectorAll('.print-page').length;
}
