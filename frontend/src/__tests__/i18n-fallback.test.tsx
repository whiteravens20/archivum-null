import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { createTranslator } from '../i18n/i18n.js';

// A Polish file with only part of the messages, which no language offered may have: the
// pages still show every message, the missing ones in English
vi.mock('../i18n/messages/pl.json', () => ({
  default: {
    'vault.subtitle': 'Odbiór sejfu',
    'vaultConfig.downloads_one': '{count} pobranie',
  },
}));

describe('a message the language lacks', () => {
  const { t, plural, rich, message } = createTranslator('pl', 'pl', () => {});

  it('should be shown in English, not as its key', () => {
    expect(t('vault.subtitle')).toBe('Odbiór sejfu');
    expect(t('vault.loading')).toBe('Loading vault...');
    expect(t('admin.lockedOut', { seconds: 42 })).toBe(
      'Too many failed login attempts. Try again in 42 s.',
    );
    expect(message({ key: 'admin.backendUnavailable', vars: { status: 502 } })).toBe(
      'Backend unavailable (502). Is the backend container running?',
    );
  });

  it('should keep the markup of the English message', () => {
    const { container } = render(
      <p>{rich('admin.updateCheckOff', { setting: <code>X=1</code> })}</p>,
    );
    expect(container.querySelector('p')!.innerHTML).toBe('Update check off — set <code>X=1</code>');
  });

  it('should take the English forms, chosen by the English rules', () => {
    expect(plural('vaultConfig.downloads', 1)).toBe('1 pobranie');
    // Polish wants `many` for 5, which the file lacks: English `other`
    expect(plural('vaultConfig.downloads', 5)).toBe('5 downloads');
    expect(plural('vaultConfig.hours', 1)).toBe('1 hour');
    expect(plural('vaultConfig.hours', 22)).toBe('22 hours');
  });
});
