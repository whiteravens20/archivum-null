import { describe, it, expect } from 'vitest';
import { formatBytes } from '../format.js';

describe('formatBytes', () => {
  it('should format nothing, and anything that is not a size, as 0 B', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(-5)).toBe('0 B');
    expect(formatBytes(NaN)).toBe('0 B');
    expect(formatBytes(undefined as unknown as number)).toBe('0 B');
  });

  it('should format bytes without a decimal', () => {
    expect(formatBytes(1)).toBe('1 B');
    expect(formatBytes(500)).toBe('500 B');
    expect(formatBytes(1023)).toBe('1023 B');
  });

  it('should format larger sizes with one decimal, left out when it is zero', () => {
    expect(formatBytes(1024)).toBe('1 KB');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(150_000)).toBe('146.5 KB');
    expect(formatBytes(5242880)).toBe('5 MB');
    expect(formatBytes(104857600)).toBe('100 MB');
    expect(formatBytes(1073741824)).toBe('1 GB');
    expect(formatBytes(1610612736)).toBe('1.5 GB');
  });

  it('should have a unit for a storage quota of a terabyte and more', () => {
    expect(formatBytes(1024 ** 4)).toBe('1 TB');
    expect(formatBytes(2.5 * 1024 ** 5)).toBe('2.5 PB');
    // Past the last unit the number grows; the unit never runs out
    expect(formatBytes(1024 ** 6)).toBe('1024 PB');
  });
});
