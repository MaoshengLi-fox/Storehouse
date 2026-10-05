let businessTimeZone = 'Asia/Shanghai';
export function setBusinessTimeZone(value) { businessTimeZone = value || 'Asia/Shanghai'; }

export function formatCurrency(value) {
  return new Intl.NumberFormat('zh-CN', {
    style: 'currency',
    currency: 'CNY',
    minimumFractionDigits: 2
  }).format(Number(value || 0));
}

export function formatNumber(value) {
  return new Intl.NumberFormat('zh-CN', {
    maximumFractionDigits: 6
  }).format(Number(value || 0));
}

export function todayString() {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: businessTimeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

// Returns an error message for an invalid stock quantity, or '' when it is fine.
export function checkQuantity(value) {
  const number = Number(value);
  if (value === '' || value === null || value === undefined || !Number.isFinite(number)) return '请填写数量';
  if (number <= 0) return '数量必须大于 0';
  if (Math.abs(number * 1e6 - Math.round(number * 1e6)) > 1e-6) return '数量最多保留 6 位小数';
  return '';
}

// ISO timestamps (stored in UTC) shown as local "YYYY-MM-DD HH:mm" in the business time zone.
export function formatDateTime(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat('sv-SE', { timeZone: businessTimeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(date);
}
