const test = require('node:test');
const assert = require('node:assert/strict');
const { rewriteAdultHls } = require('./adultHls.cjs');
test('Adult HLS rewrites variants, segments, encryption keys and subtitle/audio playlists', () => {
  const urls = [];
  const playlist = '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="keys/file.key?token=secret"\n#EXT-X-MEDIA:TYPE=AUDIO,URI="audio.m3u8"\n#EXTINF:10,\nsegment.ts\nhttps://other.example/video.m3u8?key=secret\n';
  const result = rewriteAdultHls(playlist, 'https://cdn.example/dir/master.m3u8', (url) => { urls.push(url); return `https://api.example/ticket/${urls.length}`; });
  assert.deepEqual(urls, ['https://cdn.example/dir/keys/file.key?token=secret', 'https://cdn.example/dir/audio.m3u8',
    'https://cdn.example/dir/segment.ts', 'https://other.example/video.m3u8?key=secret']);
  assert.equal(result.includes('secret'), false);
  assert.match(result, /URI="https:\/\/api.example\/ticket\/1"/);
});
test('Adult HLS rejects non-playlists, unsafe schemes, credentials, ports and oversized input', () => {
  const wrap = () => 'ticket';
  for (const playlist of ['not HLS', '#EXTM3U\nfile:///local',
    '#EXTM3U\nhttps://user:pass@cdn.example/file.ts', '#EXTM3U\nhttps://cdn.example:3306/file.ts', `#EXTM3U\n#${'x'.repeat(1024 * 1024)}`]) {
    assert.throws(() => rewriteAdultHls(playlist, 'https://cdn.example/master.m3u8', wrap));
  }
});

test('Adult HLS supports HTTP media without exposing it in rewritten player links', () => {
  const targets = [];
  const result = rewriteAdultHls('#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="http://cdn.example/key"\npart.ts\n',
    'http://cdn.example/master.m3u8', url => { targets.push(url); return `https://api.example/protected/${targets.length}`; });
  assert.deepEqual(targets, ['http://cdn.example/key', 'http://cdn.example/part.ts']);
  assert.equal(result.includes('http://'), false);
});

test('extensionless variant/audio/subtitle playlist links retain HLS type but segments, keys and maps do not', () => {
  const links = [];
  rewriteAdultHls('#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,URI="audio"\n#EXT-X-MEDIA:TYPE=SUBTITLES,URI="subtitles"\n#EXT-X-STREAM-INF:BANDWIDTH=1000\nvariant\n#EXT-X-KEY:METHOD=AES-128,URI="key"\n#EXT-X-MAP:URI="init"\nsegment.ts\n',
    'https://cdn.example/master', (url, playlist) => { links.push({ url, playlist }); return 'protected'; });
  assert.deepEqual(links.map(link => link.playlist), [true, true, true, false, false, false]);
});
