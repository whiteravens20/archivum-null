import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import Logo from '../components/Logo.js';
import { setBrandingTags } from '../test/brandingTags.js';

describe('Logo', () => {
  it('should show the dark-theme mark on a page with no theme set', () => {
    const { container } = render(<Logo className="w-16 h-16" />);

    const img = container.querySelector('img');
    expect(img).toHaveAttribute('src', '/logo-symbol.webp');
    expect(img).toHaveClass('w-16', 'h-16');
    expect(container.querySelector('picture')).toBeNull();
  });

  it('should show the light-theme mark in the light theme', () => {
    document.documentElement.dataset.theme = 'light';
    const { container } = render(<Logo className="w-16 h-16" />);

    expect(container.querySelector('img')).toHaveAttribute('src', '/logo-symbol-light.webp');
    expect(container.querySelector('picture')).toBeNull();
  });

  it('should let the browser pick the mark by colour scheme in the auto theme', () => {
    document.documentElement.dataset.theme = 'auto';
    const { container } = render(<Logo className="w-16 h-16" />);

    const source = container.querySelector('picture > source');
    expect(source).toHaveAttribute('srcset', '/logo-symbol-light.webp');
    expect(source).toHaveAttribute('media', '(prefers-color-scheme: light)');
    // The fallback inside <picture> is the dark-theme mark, and it keeps the sizing classes.
    const img = container.querySelector('picture > img');
    expect(img).toHaveAttribute('src', '/logo-symbol.webp');
    expect(img).toHaveClass('w-16', 'h-16');
  });

  it('should show the operator logo for the theme in use', () => {
    setBrandingTags({ 'brand-logo': '/brand/logo.svg', 'brand-logo-light': '/brand/logo-light.png' });

    const dark = render(<Logo className="w-16 h-16" />);
    expect(dark.container.querySelector('img')).toHaveAttribute('src', '/brand/logo.svg');
    dark.unmount();

    document.documentElement.dataset.theme = 'light';
    const light = render(<Logo className="w-16 h-16" />);
    expect(light.container.querySelector('img')).toHaveAttribute('src', '/brand/logo-light.png');
  });

  it('should fit a logo that is not square into its box without stretching it', () => {
    const { container } = render(<Logo className="w-16 h-16" />);

    expect(container.querySelector('img')).toHaveClass('object-contain');
  });

  it('should be decorative', () => {
    const { container } = render(<Logo className="w-16 h-16" />);

    expect(container.querySelector('img')).toHaveAttribute('alt', '');
  });
});
