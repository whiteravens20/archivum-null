import { describe, it, expect } from 'vitest';
import { getBranding } from '../branding.js';
import { setBrandingTags } from '../test/brandingTags.js';

describe('getBranding', () => {
  it('should fall back to the built-in branding on a page the server has not touched', () => {
    expect(getBranding()).toEqual({
      name: 'Archivum Null',
      tagline: 'Zero trust file relay',
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

  it('should return markup in a value as plain text', () => {
    setBrandingTags({ 'application-name': '<img src=x onerror=alert(1)>' });

    // The value is only ever rendered as a React text node, never as HTML.
    expect(getBranding().name).toBe('<img src=x onerror=alert(1)>');
  });
});
