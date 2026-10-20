import { describe, it, expect } from 'vitest';
import { formatBytes, formatDuration } from '../format.js';
import { createTranslator } from '../i18n/i18n.js';

describe('formatBytes', () => {
  it('should format nothing, and anything that is not a size, as 0 B', () => {
    expect(formatBytes(0, 'en')).toBe('0 B');
    expect(formatBytes(-5, 'en')).toBe('0 B');
    expect(formatBytes(NaN, 'en')).toBe('0 B');
    expect(formatBytes(undefined as unknown as number, 'en')).toBe('0 B');
  });

  it('should format bytes without a decimal', () => {
    expect(formatBytes(1, 'en')).toBe('1 B');
    expect(formatBytes(500, 'en')).toBe('500 B');
    expect(formatBytes(1023, 'en')).toBe('1023 B');
  });

  it('should format larger sizes with one decimal, left out when it is zero', () => {
    expect(formatBytes(1024, 'en')).toBe('1 KB');
    expect(formatBytes(1536, 'en')).toBe('1.5 KB');
    expect(formatBytes(150_000, 'en')).toBe('146.5 KB');
    expect(formatBytes(5242880, 'en')).toBe('5 MB');
    expect(formatBytes(104857600, 'en')).toBe('100 MB');
    expect(formatBytes(1073741824, 'en')).toBe('1 GB');
    expect(formatBytes(1610612736, 'en')).toBe('1.5 GB');
  });

  it('should have a unit for a storage quota of a terabyte and more', () => {
    expect(formatBytes(1024 ** 4, 'en')).toBe('1 TB');
    expect(formatBytes(2.5 * 1024 ** 5, 'en')).toBe('2.5 PB');
    // Past the last unit the number grows; the unit never runs out
    expect(formatBytes(1024 ** 6, 'en')).toBe('1024 PB');
  });

  it('should write the decimal mark of the locale, and no grouping', () => {
    expect(formatBytes(1536, 'de')).toBe('1,5 KB');
    expect(formatBytes(1024 ** 6, 'de')).toBe('1024 PB');
  });
});

describe('formatDuration', () => {
  const { t } = createTranslator('en', 'en');

  it('should give a time span in its two largest units', () => {
    expect(formatDuration(1244994, t)).toBe('14d 9h');
    expect(formatDuration(3900, t)).toBe('1h 5m');
    expect(formatDuration(300, t)).toBe('5m');
    expect(formatDuration(59, t)).toBe('0m');
  });
});
