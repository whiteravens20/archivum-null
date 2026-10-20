import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { createTranslator, type PluralKey, type TextKey } from '../i18n/i18n.js';

describe('translator', () => {
  const { t, plural, rich, message } = createTranslator('en', 'en');

  it('should give the message for a key, with its values filled in', () => {
    expect(t('vault.subtitle')).toBe('Vault retrieval');
    expect(t('admin.lockedOut', { seconds: 42 })).toBe('Too many failed login attempts. Try again in 42 s.');
  });

  it('should write a number the way the locale does', () => {
    expect(t('admin.vaultList', { count: 1234 })).toBe('Active Vaults (1,234)');
  });

  it('should not read what a value brings in as a placeholder or a replacement pattern', () => {
    // A sender chooses file names; one may look like a placeholder or a pattern of String.replace
    expect(t('admin.updateAvailable', { version: '{version} $& $1 $$' })).toBe('Update available — {version} $& $1 $$');
  });

  it('should take only messages of its own as messages', () => {
    for (const name of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
      // Cast to a key without placeholders, so the call compiles
      expect(t(name as Extract<TextKey, 'vault.subtitle'>)).toBe(name);
      expect(plural(name as PluralKey, 2)).toBe(name);
    }
  });

  it('should choose the plural form by the count', () => {
    expect(plural('vaultConfig.downloads', 1)).toBe('1 download');
    expect(plural('vaultConfig.downloads', 0)).toBe('0 downloads');
    expect(plural('vaultConfig.downloads', 10)).toBe('10 downloads');
  });

  it('should keep a message kept for later as it was given', () => {
    expect(message({ key: 'admin.authFailed' })).toBe('Authentication failed');
    expect(message({ key: 'admin.backendUnavailable', vars: { status: 502 } })).toBe(
      'Backend unavailable (502). Is the backend container running?'
    );
  });

  describe('rich', () => {
    it('should put nodes into the placeholders', () => {
      const { container } = render(<p>{rich('admin.updateCheckOff', { setting: <code>X=1</code> })}</p>);
      expect(container.querySelector('p')!.innerHTML).toBe('Update check off — set <code>X=1</code>');
    });

    it('should show markup in a value as text', () => {
      const { container } = render(
        <p>
          {rich('vault.mismatch.detail', {
            expected: '<img src=x onerror=alert(1)>',
            actual: '{expected}',
          })}
        </p>
      );
      expect(container.querySelector('img')).toBeNull();
      expect(container.textContent).toBe(
        'The link indicated <img src=x onerror=alert(1)> but the decrypted file is actually {expected}. The link may have been tampered with.'
      );
    });
  });
});
