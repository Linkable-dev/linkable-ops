// "▲ 12% vs previous 30 days" — null when there is nothing to compare against.
export function deltaLabel(current, previous, periodLabel) {
  if (previous == null || current == null) return null;
  if (previous === 0 && current === 0) return { text: `flat vs ${periodLabel}`, dir: 0 };
  if (previous === 0) return { text: `new vs ${periodLabel}`, dir: 1 };
  const pct = Math.round(((current - previous) / previous) * 100);
  if (pct === 0) return { text: `flat vs ${periodLabel}`, dir: 0 };
  return { text: `${pct > 0 ? "▲" : "▼"} ${Math.abs(pct)}% vs ${periodLabel}`, dir: pct > 0 ? 1 : -1 };
}
