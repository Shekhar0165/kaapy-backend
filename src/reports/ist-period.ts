export const REPORT_PERIODS = ['today', 'month', 'all'] as const;
export type ReportPeriod = (typeof REPORT_PERIODS)[number];

// India Standard Time: UTC+05:30 all year (no daylight saving).
const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;

/**
 * The UTC instant a report period starts at, by the India calendar:
 * - 'today': 00:00 IST today
 * - 'month': 00:00 IST on the 1st of the current month
 * - 'all':   null (no lower bound)
 * Stored times stay UTC; only the boundary is computed in IST.
 */
export function istPeriodStart(period: ReportPeriod, now: Date = new Date()): Date | null {
  if (period === 'all') return null;
  // Shift so the UTC fields read as IST wall-clock time.
  const ist = new Date(now.getTime() + IST_OFFSET_MS);
  const year = ist.getUTCFullYear();
  const month = ist.getUTCMonth();
  const day = period === 'today' ? ist.getUTCDate() : 1;
  // Midnight IST on that date, converted back to UTC.
  return new Date(Date.UTC(year, month, day) - IST_OFFSET_MS);
}
