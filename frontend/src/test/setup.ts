import '@testing-library/jest-dom/vitest';

// Branding lives in the document head and on <html>, which jsdom keeps between the
// tests of a file. The crypto tests run in the node environment, with no document.
afterEach(() => {
  if (typeof document === 'undefined') return;
  document.head.replaceChildren();
  document.documentElement.removeAttribute('data-theme');
  document.documentElement.removeAttribute('lang');
});
