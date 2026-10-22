const test = require('node:test');
const assert = require('node:assert/strict');
const { createThePornDbClient } = require('./thePornDb.cjs');
const json = data => new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } });
const settings = { theporndb_enabled: true, theporndb_token: 'private-token' };
const record = { id: 'fixture-1', title: 'Fixture title', description: 'Description', poster: 'https://cdn.example/poster.jpg',
  url: 'https://publisher.example/page', trailer: 'https://cdn.example/trailer.mp4', hashes: [{ hash: 'not-a-torrent', type: 'OSHASH' }] };

test('ThePornDB maps metadata, paging and search without exposing webpage/trailer/hash fields', async () => {
  const calls = [];
  const client = createThePornDbClient({ fetcher: async (url, options) => { calls.push({ url, options }); return json({ data: [record], meta: { current_page: 2, last: 3 } }); } });
  const result = await client.catalog(settings, { catalog_id: 'scenes', type: 'movie', page: 2, query: 'A & B' });
  assert.equal(result.has_more, true);
  assert.equal(result.items[0].id, 'tpdb:scenes:fixture-1');
  for (const field of ['url', 'trailer', 'hashes']) assert.equal(Object.hasOwn(result.items[0], field), false);
  const url = new URL(calls[0].url);
  assert.equal(url.origin, 'https://api.theporndb.net');
  assert.equal(url.searchParams.get('q'), 'A & B');
  assert.equal(url.searchParams.get('page'), '2');
  assert.equal(url.searchParams.get('per_page'), '25');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer private-token');
  assert.equal(calls[0].options.redirect, 'error');
  await client.catalog(settings, { catalog_id: 'scenes', type: 'movie', page: 2, query: 'A & B' });
  assert.equal(calls.length, 1);
  await client.catalog({ ...settings, theporndb_token: 'another-token' }, { catalog_id: 'scenes', type: 'movie', page: 2, query: 'A & B' });
  assert.equal(calls.length, 2);
});

test('ThePornDB details preserve exact resource identity and do not manufacture playback', async () => {
  const client = createThePornDbClient({ fetcher: async () => json({ data: record }) });
  const item = { id: 'tpdb:movies:fixture-1', tpdb_kind: 'movies', tpdb_id: 'fixture-1', addon_id: '__tpdb', addon_version: 'version' };
  const result = await client.details(settings, item);
  assert.equal(result.id, item.id); assert.equal(result.addon_id, '__tpdb');
  assert.deepEqual(result.videos, []);
  await assert.rejects(client.details(settings, { ...item, tpdb_id: '../scenes' }), { status: 400 });
  await assert.rejects(client.details(settings, { ...item, id: 'tpdb:scenes:fixture-1' }), { status: 400 });
});

test('ThePornDB rejects disabled access, invalid input and upstream credential failures', async () => {
  let calls = 0;
  const client = createThePornDbClient({ fetcher: async () => { calls++; return new Response('secret provider error', { status: 401 }); } });
  const input = { catalog_id: 'scenes', type: 'movie' };
  for (const value of [{ ...input, catalog_id: '../auth/user' }, { ...input, page: 101 }, { ...input, query: {} }]) {
    await assert.rejects(client.catalog(settings, value), { status: 400 });
  }
  await assert.rejects(client.catalog({ ...settings, theporndb_enabled: false }, input), { status: 409 });
  await assert.rejects(client.test('bad\nheader'), { status: 409 });
  assert.equal(calls, 0);
  await assert.rejects(client.catalog(settings, input), error => error.status === 409 && !error.message.includes('secret provider error'));
});

test('ThePornDB honors 429 cooldowns and bounds/validates response bodies', async () => {
  let time = 0, calls = 0;
  const limited = createThePornDbClient({ now: () => time, fetcher: async () => { calls++; return new Response('', { status: 429, headers: { 'retry-after': '2' } }); } });
  await assert.rejects(limited.test('token'), { status: 429 });
  await assert.rejects(limited.test('token'), { status: 429 });
  assert.equal(calls, 1); time = 3000;
  await assert.rejects(limited.test('token'), { status: 429 }); assert.equal(calls, 2);
  for (const response of [new Response('<html>Error</html>'), json({ error: 'Invalid' }), json({ data: 'x'.repeat(2100000) })]) {
    const client = createThePornDbClient({ fetcher: async () => response });
    await assert.rejects(client.test('token'), { status: 502 });
  }
});

test('ThePornDB deduplicates pending reads, bounds concurrency and tests fresh credentials', async () => {
  const releases = [];
  let calls = 0;
  const client = createThePornDbClient({ fetcher: () => { calls++; return new Promise(resolve => releases.push(() => resolve(json({ data: [record], meta: { last: 1 } })))); } });
  const input = { catalog_id: 'scenes', type: 'movie' };
  const first = client.catalog(settings, input), same = client.catalog(settings, input);
  const others = [2, 3, 4].map(page => client.catalog(settings, { ...input, page }));
  assert.equal(calls, 4);
  await assert.rejects(client.catalog(settings, { ...input, page: 5 }), { status: 429 });
  releases.forEach(release => release());
  await Promise.all([first, same, ...others]);
  assert.equal(calls, 4);
  const testOne = client.test(settings.theporndb_token);
  releases.at(-1)(); await testOne;
  const testTwo = client.test(settings.theporndb_token);
  releases.at(-1)(); await testTwo;
  assert.equal(calls, 6);
});
