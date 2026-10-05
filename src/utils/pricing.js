// Same rule as the server: latest eligible date, then latest revision on that day.
export function priceAtDate(prices, item, date) {
  const history = prices.filter((row) => Number(row.itemId) === Number(item.id));
  const eligible = history.filter((row) => row.effectiveDate <= date)
    .sort((a, b) => b.effectiveDate.localeCompare(a.effectiveDate) || b.id - a.id);
  return eligible[0] || { unitPrice: history.length ? 0 : (item.unitPrice ?? 0), remark: item.processNote || '' };
}
