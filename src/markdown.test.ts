import { expect, test } from 'bun:test';
import { renderMarkdown } from './markdown';

test('journal responses link bare URLs and Markdown labels without trailing punctuation', () => {
  const html = renderMarkdown('Fixed: https://github.com/example/paperplane/pull/42.\n\n[View release](https://example.com/release?a=1&b=2)');
  expect(html).toContain('href="https://github.com/example/paperplane/pull/42"');
  expect(html).toContain('42</a>.');
  expect(html).toContain('href="https://example.com/release?a=1&amp;b=2" target="_blank" rel="noopener noreferrer">View release</a>');
});

test('journal responses format blocks, emphasis, and code without linking code samples', () => {
  const html = renderMarkdown('# Result\n\n**Shipped** and *tested*.\n\n- First\n- Second\n\n> Ready\n\n`https://example.com`\n\n```js\nconst tag = "<script>";\n```\n\n| Test | Result |\n| --- | --- |\n| Build | Pass |');
  for (const tag of ['<h1>', '<strong>', '<em>', '<ul>', '<li>', '<blockquote>', '<pre><code', '<table>']) expect(html).toContain(tag);
  expect(html).toContain('<code>https://example.com</code>');
  expect(html).toContain('&lt;script&gt;');
  expect(html).not.toContain('<a ');
});

test('journal responses cannot inject HTML, attributes, or unsafe link protocols', () => {
  const html = renderMarkdown('<script>alert(1)</script>\n<img src=x onerror=alert(1)>\n\n[bad](javascript:alert%281%29) [encoded](jav&#x61;script:alert%281%29) [data](data:text/html,hello) [local](file:///etc/passwd)\n\n[quoted](https://example.com "\" onmouseover=\"bad")');
  expect(html).not.toMatch(/<(script|img)\b/);
  expect(html).not.toMatch(/href="(?:javascript|data|file):/i);
  expect(html).not.toContain(' onmouseover="');
  expect(html).toContain('&lt;script&gt;');
});

test('referenced images become safe links without fetching media', () => {
  const html = renderMarkdown('![Diagram](https://example.com/diagram.png)');
  expect(html).toContain('href="https://example.com/diagram.png" target="_blank" rel="noopener noreferrer">Diagram</a>');
  expect(html).not.toContain('<img');
});
