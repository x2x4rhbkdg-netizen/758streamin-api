const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');

for (const mode of ['ipv6-only', 'ipv4-only', 'dual-stack']) {
  test(`native ${mode} connect failure rejects the movie request without an uncaught exception`, () => {
    const child = spawnSync(process.execPath, [require.resolve('../../test/fixtures/movie-network-worker.cjs'), mode], {
      encoding: 'utf8', timeout: 10000,
    });
    assert.equal(child.status, 0, child.stderr || child.stdout);
    assert.equal(JSON.parse(child.stdout).caught, true);
  });
}
