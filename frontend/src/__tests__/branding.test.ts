import { describe, it, expect } from 'vitest';
import { getBranding } from '../branding.js';
import { setBrandingTags } from '../test/brandingTags.js';

describe('getBranding', () => {
  it('should fall back to the built-in branding on a page the server has not touched', () => {
    expect(getBranding()).toEqual({
      name: 'Archivum Null',
      tagline: 'Anonymous encrypted file sharing',
      theme: 'dark',
      logo: '/logo-symbol.webp',
      logoLight: '/logo-symbol-light.webp',
    });
  });

  it('should read the name and tagline the server wrote into the page', () => {
    setBrandingTags({ 'application-name': 'Acme Drop', 'brand-tagline': 'Files, sealed' });

    expect(getBranding()).toMatchObject({ name: 'Acme Drop', tagline: 'Files, sealed' });
  });

  it('should fall back for a tag that is present but empty', () => {
    setBrandingTags({ 'application-name': '' });

    expect(getBranding().name).toBe('Archivum Null');
  });

  it.each(['light', 'auto', 'dark'] as const)(
    'should read the %s theme from the root element',
    (theme) => {
      document.documentElement.dataset.theme = theme;

      expect(getBranding().theme).toBe(theme);
    },
  );

  it('should use the logos the server points at', () => {
    setBrandingTags({
      'brand-logo': '/brand/logo.svg',
      'brand-logo-light': '/brand/logo-light.png',
    });

    expect(getBranding()).toMatchObject({
      logo: '/brand/logo.svg',
      logoLight: '/brand/logo-light.png',
    });
  });

  it('should keep the built-in mark for the theme the operator supplied no logo for', () => {
    setBrandingTags({ 'brand-logo-light': '/brand/logo-light.png' });

    expect(getBranding()).toMatchObject({
      logo: '/logo-symbol.webp',
      logoLight: '/brand/logo-light.png',
    });
  });

  it('should treat an unknown theme as dark', () => {
    document.documentElement.dataset.theme = 'sepia';

    expect(getBranding().theme).toBe('dark');
  });

  it('should return markup in a value as plain text', () => {
    setBrandingTags({ 'application-name': '<img src=x onerror=alert(1)>' });

    // The value is only ever rendered as a React text node, never as HTML.
    expect(getBranding().name).toBe('<img src=x onerror=alert(1)>');
  });
});
