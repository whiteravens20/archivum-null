import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderTerms } from '../static/terms.js';

describe('renderTerms', () => {
  it('should convert the formatting a terms document uses', () => {
    const html = renderTerms([
      '# Terms',
      '',
      'You agree **not** to do *this*:',
      '',
      '- one',
      '- two',
      '',
      '> A notice.',
      '',
      '---',
      '',
      '| Plan | Limit |',
      '|---|---|',
      '| Free | 100 MB |',
    ].join('\n'));

    expect(html).toContain('<h1>Terms</h1>');
    expect(html).toContain('<strong>not</strong>');
    expect(html).toContain('<em>this</em>');
    expect(html).toMatch(/<ul>\s*<li>one<\/li>\s*<li>two<\/li>\s*<\/ul>/);
    expect(html).toMatch(/<blockquote>\s*<p>A notice\.<\/p>\s*<\/blockquote>/);
    expect(html).toContain('<hr>');
    expect(html).toContain('<table>');
    expect(html).toContain('<td>100 MB</td>');
  });

  it('should show raw HTML as the text it is', () => {
    const html = renderTerms([
      'Before <script>alert(1)</script> after.',
      '',
      '<img src=x onerror="alert(1)">',
      '',
      '<iframe src="https://example.com"></iframe>',
    ].join('\n'));

    expect(html).not.toMatch(/<script|<img|<iframe/i);
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;');
  });

  it('should keep links to web and mail addresses and to paths on the site', () => {
    const html = renderTerms(
      '[web](https://example.com/terms?a=1&b=2) [plain](HTTP://example.com) [mail](mailto:legal@example.com) [home](/) [section](#privacy) [near](./privacy) [query](?lang=pl)'
    );

    expect(html).toContain('<a href="https://example.com/terms?a=1&amp;b=2">web</a>');
    expect(html).toContain('<a href="HTTP://example.com">plain</a>');
    expect(html).toContain('<a href="mailto:legal@example.com">mail</a>');
    expect(html).toContain('<a href="/">home</a>');
    expect(html).toContain('<a href="#privacy">section</a>');
    expect(html).toContain('<a href="./privacy">near</a>');
    expect(html).toContain('<a href="?lang=pl">query</a>');
  });

  it.each([
    'javascript:alert(1)',
    'JavaScript:alert(1)',
    ' javascript:alert(1)',
    'java&#x09;script:alert(1)',
    'javascript&colon;alert(1)',
    '&#106;avascript:alert(1)',
    'vbscript:msgbox(1)',
    'data:text/html,<script>alert(1)</script>',
    'file:///etc/passwd',
    'https:example.com',
    // Begins with a letter, so it could be read as a scheme: not worth telling apart
    'terms.html',
  ])('should leave a link to %s as plain text', (address) => {
    const html = renderTerms(`[click **here**](${address})`);

    expect(html).not.toContain('<a');
    expect(html).not.toMatch(/href/i);
    expect(html).toContain('click <strong>here</strong>');
  });

  it('should not load an image from an address it would not link to', () => {
    const html = renderTerms('![a diagram](javascript:alert(1)) ![logo](/logo-symbol.webp)');

    expect(html).not.toContain('javascript:');
    expect(html).toContain('a diagram');
    expect(html).toContain('<img src="/logo-symbol.webp" alt="logo">');
  });

  it('should convert the terms file this repository ships', () => {
    const tos = fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'TOS.md'),
      'utf-8'
    );
    const html = renderTerms(tos);

    expect(html).toMatch(/^<h1>Terms of Service/);
    expect(html.match(/<h2>/g)).toHaveLength(10);
    expect(html).not.toMatch(/<script/i);
  });
});
