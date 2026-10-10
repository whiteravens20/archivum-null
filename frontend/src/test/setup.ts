import '@testing-library/jest-dom/vitest';

// Branding lives in the document head, which jsdom keeps between the tests of a file.
// The crypto tests run in the node environment, where there is no document.
afterEach(() => {
  if (typeof document !== 'undefined') document.head.replaceChildren();
});
