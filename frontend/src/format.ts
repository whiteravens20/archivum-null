const UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];

/**
 * A byte count for display: `512 B`, `1.5 KB`, `100 MB`. One decimal from kilobytes
 * up, left out when it is zero.
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 1) return '0 B';
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(unit > 0 ? 1 : 0).replace(/\.0$/, '')} ${UNITS[unit]}`;
}
