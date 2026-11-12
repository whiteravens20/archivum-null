import type { Translator } from './i18n/i18n.ts';

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];

/**
 * A byte count for display: `512 B`, `1.5 KB`, `100 MB`, with the decimal mark of the
 * locale. One decimal from kilobytes up, left out when it is zero.
 */
export function formatBytes(bytes: number, locale: string): string {
  if (!Number.isFinite(bytes) || bytes < 1) return '0 B';
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit++;
  }
  const number = new Intl.NumberFormat(locale, {
    maximumFractionDigits: unit > 0 ? 1 : 0,
    useGrouping: false,
  });
  return `${number.format(value)} ${UNITS[unit]}`;
}

/** A time span for display, in its two largest units: `14d 9h`, `3h 5m`, `5m`. */
export function formatDuration(seconds: number, t: Translator['t']): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return t('duration.daysHours', { days, hours });
  if (hours > 0) return t('duration.hoursMinutes', { hours, minutes });
  return t('duration.minutes', { minutes });
}
