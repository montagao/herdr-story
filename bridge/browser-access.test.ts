import { expect, test } from 'bun:test';
import { browserAccess } from './browser-access';

const allow = browserAccess({ port: 7788, host: '127.0.0.1', origins: 'https://office.example.test' });
const request = (url: string, origin?: string, site?: string) => new Request(url, { headers: {
  ...(origin === undefined ? {} : { origin }), ...(site ? { 'sec-fetch-site': site } : {}),
} });
test('local CLI, browser, Vite proxy and explicitly trusted HTTPS proxy work', () => {
  expect(allow(request('http://127.0.0.1:7788/api/state'))).toBe(true);
  expect(allow(request('http://localhost:7788/ws', 'http://localhost:7788'))).toBe(true);
  expect(allow(request('http://127.0.0.1:5173/ws', 'http://127.0.0.1:5173'))).toBe(true);
  expect(allow(request('http://office.example.test/api/call', 'https://office.example.test'))).toBe(true);
});
test('foreign WebSockets, opaque origins, no-CORS requests and DNS rebinding are rejected', () => {
  for (const origin of ['https://evil.example', 'null', 'http://localhost:9999', 'https://office.example.test.evil.example'])
    expect(allow(request('http://127.0.0.1:7788/ws', origin))).toBe(false);
  expect(allow(request('http://127.0.0.1:7788/api/image', undefined, 'cross-site'))).toBe(false);
  expect(allow(request('http://rebound.example:7788/api/state'))).toBe(false);
  expect(allow(new Request('http://127.0.0.1:7788/api/state', { headers: { host: 'rebound.example:7788' } }))).toBe(false);
  expect(allow(request('http://rebound.example:7788/ws', 'http://localhost:7788'))).toBe(false);
});
test('configuration rejects paths and wildcards instead of silently widening access', () => {
  for (const origins of ['*', 'https://office.example.test/', 'https://office.example.test/path', 'file:///tmp'])
    expect(() => browserAccess({ port: 7788, host: '127.0.0.1', origins })).toThrow();
});
