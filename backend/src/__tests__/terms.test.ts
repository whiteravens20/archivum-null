import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTerms, markNoTerms, renderTerms } from '../static/terms.js';

describe('renderTerms', () => {
  it('should convert the formatting a terms document uses', () => {
    const html = renderTerms(
      [
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
      ].join('\n'),
    );

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
    const html = renderTerms(
      [
        'Before <script>alert(1)</script> after.',
        '',
        '<img src=x onerror="alert(1)">',
        '',
        '<iframe src="https://example.com"></iframe>',
      ].join('\n'),
    );

    expect(html).not.toMatch(/<script|<img|<iframe/i);
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;');
  });

  it('should keep links to web and mail addresses and to paths on the site', () => {
    const html = renderTerms(
      '[web](https://example.com/terms?a=1&b=2) [plain](HTTP://example.com) [mail](mailto:legal@example.com) [home](/) [section](#privacy) [near](./privacy) [query](?lang=pl)',
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
      'utf-8',
    );
    const html = renderTerms(tos);

    expect(html).toMatch(/^<h1>Terms of Service/);
    expect(html.match(/<h2>/g)).toHaveLength(10);
    expect(html).not.toMatch(/<script/i);
  });
});

describe('loadTerms', () => {
  let dir: string;
  const write = (name: string, text: string) => fs.writeFileSync(path.join(dir, name), text);

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'terms-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('should take the translations beside TOS.md, each by its language code', () => {
    write('TOS.md', '# Terms');
    write('TOS.pl.md', '# Regulamin');

    expect(loadTerms(dir)).toEqual({
      terms: '<h1>Terms</h1>\n',
      translations: { pl: '<h1>Regulamin</h1>\n' },
    });
  });

  it('should take no other file for a translation', () => {
    write('TOS.md', '# Terms');
    for (const name of [
      'TOS.PL.md',
      'TOS.pl-PL.md',
      'TOS.pol.md',
      'TOS.p.md',
      'TOS.pl.md.bak',
      'TOS.pl.txt',
      'tos.pl.md',
    ]) {
      write(name, '# Not a translation');
    }

    expect(loadTerms(dir)?.translations).toEqual({});
  });

  it('should convert a translation the way it converts TOS.md', () => {
    write('TOS.md', '# Terms');
    write('TOS.pl.md', 'Przed <script>alert(1)</script> po. [link](javascript:alert(1))');

    const html = loadTerms(dir)!.translations.pl;
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('javascript:');
  });

  it('should skip a translation that is not a file, and say so', () => {
    // What Docker leaves for a bind mount whose file does not exist
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    write('TOS.md', '# Terms');
    fs.mkdirSync(path.join(dir, 'TOS.de.md'));
    write('TOS.pl.md', '# Regulamin');

    expect(Object.keys(loadTerms(dir)!.translations)).toEqual(['pl']);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('TOS.de.md'));
    warn.mockRestore();
  });

  it('should serve nothing without TOS.md, translations or not, and say so', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    write('TOS.pl.md', '# Regulamin');

    expect(loadTerms(dir)).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('TOS.md cannot be read'));
    warn.mockRestore();
  });

  it('should serve nothing when TOS.md is a directory, and say so', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    fs.mkdirSync(path.join(dir, 'TOS.md'));

    expect(loadTerms(dir)).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('TOS.md cannot be read'));
    warn.mockRestore();
  });
});

describe('markNoTerms', () => {
  it('should put the tag in the head, once', () => {
    const page = markNoTerms('<html><head>\n  <title>X</title>\n  </head><body></body></html>');

    expect(page.match(/<meta name="terms" content="none" \/>/g)).toHaveLength(1);
    expect(page.indexOf('name="terms"')).toBeLessThan(page.indexOf('</head>'));
  });

  it('should leave a page without a head as it is', () => {
    expect(markNoTerms('<p>no head</p>')).toBe('<p>no head</p>');
  });
});
