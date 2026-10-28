import test from 'node:test';
import assert from 'node:assert/strict';
import { createTavilyClient, formatSearchResults } from '../src/search/tavily.js';

function fakeHttp() {
  return {
    calls: [],
    async requestJson(url, opts) {
      this.calls.push({ url, body: JSON.parse(opts.body), retries: opts.retries });
      return {
        status: 200,
        latencyMs: 1,
        data: {
          query: 'gold',
          results: [{ title: 'Result', url: 'https://example.com/a', content: 'hello world' }],
          images: [],
          usage: { credits: 1 },
        },
      };
    },
  };
}

test('search: drops country for fast/ultra-fast and never retries a billed POST', async () => {
  const http = fakeHttp();
  const client = createTavilyClient({ apiKey: 'k', http, cacheTtlMs: 60_000 });
  await client.search('gold', { searchDepth: 'fast', country: 'vietnam' });
  assert.equal('country' in http.calls[0].body, false);
  assert.equal(http.calls[0].retries, 0);

  await client.search('gold basic', { searchDepth: 'basic', country: 'vietnam' });
  assert.equal(http.calls[1].body.country, 'vietnam');
});

test('search: caches identical requests', async () => {
  const http = fakeHttp();
  const client = createTavilyClient({ apiKey: 'k', http, cacheTtlMs: 60_000 });
  const first = await client.search('gold', { searchDepth: 'fast' });
  const second = await client.search('gold', { searchDepth: 'fast' });
  assert.equal(http.calls.length, 1);
  assert.equal(first.results.length, 1);
  assert.equal(second.results.length, 1);
});

test('formatSearchResults: caps items/chars and handles empty input', () => {
  assert.equal(formatSearchResults([]), '(no results)');
  const text = formatSearchResults(
    [
      { title: 'A', url: 'https://a', content: 'x'.repeat(20) },
      { title: 'B', url: 'https://b', content: 'y' },
    ],
    { maxChars: 5, maxItems: 1 },
  );
  assert.match(text, /^1\. A/);
  assert.equal(text.includes('https://b'), false);
  assert.equal(text.includes('xxxxx…'), false);
  assert.equal(text.includes('xxxxx'), true);
});
