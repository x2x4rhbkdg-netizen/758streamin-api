const { nextTick } = require('node:process');

function createPinnedLookup(addresses) {
  // Callers must validate the complete DNS answer set before pinning it.
  const pinned = addresses.map(({ address, family }) => ({ address, family }))
    .sort((a, b) => Number(b.family === 4) - Number(a.family === 4));
  return (_hostname, options, callback) => {
    const family = typeof options === 'number' ? options : options?.family;
    const matching = pinned.filter(item => !family || item.family === family);
    // Match async DNS timing: a synchronous connect failure must not reach TLS
    // before the HTTP request has attached its socket error listeners.
    nextTick(() => {
      if (!matching.length) {
        const error = new Error('No validated address for requested family');
        error.code = 'ENOTFOUND';
        callback(error);
      } else if (options?.all) callback(null, matching.map(item => ({ ...item })));
      else callback(null, matching[0].address, matching[0].family);
    });
  };
}

module.exports = { createPinnedLookup };
