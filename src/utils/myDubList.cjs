const DATA_URL = 'https://raw.githubusercontent.com/Joelis57/MyDubList/main/dubs/confidence/high/dubbed_english.json';
const DAY = 24 * 60 * 60 * 1000;
const unavailable = () => Object.assign(new Error('English dub filter temporarily unavailable. Try again later.'), { status: 503 });

function parseDubIndex(value) {
  if (value?.language !== 'English' || !Array.isArray(value.dubbed) || !value.dubbed.length || value.dubbed.length > 10000 ||
      value.dubbed.some(id => !Number.isSafeInteger(id) || id < 1 || id > 2147483647)) throw unavailable();
  return Object.freeze([...new Set(value.dubbed)]);
}

function createDubIndex({ fetchImpl = globalThis.fetch, now = Date.now } = {}) {
  let cached, updated = 0, pending, retryAt = 0;
  return async function getEnglishDubIds() {
    if (cached && now() - updated < DAY) return cached;
    const fallback = () => {
      if (cached && now() - updated < 7 * DAY) return cached;
      throw unavailable();
    };
    if (now() < retryAt) return fallback();
    if (pending) return pending;
    pending = (async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);
      try {
        const response = await fetchImpl(DATA_URL, { signal: controller.signal, redirect: 'error', headers: { Accept: 'application/json' } });
        if (!response.ok || Number(response.headers.get('content-length')) > 256 * 1024) throw unavailable();
        const chunks = [];
        let size = 0;
        for await (const chunk of response.body) {
          size += chunk.byteLength;
          if (size > 256 * 1024) { controller.abort(); throw unavailable(); }
          chunks.push(Buffer.from(chunk));
        }
        const ids = parseDubIndex(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        cached = ids; updated = now(); retryAt = 0;
        return cached;
      } catch {
        retryAt = now() + 60000;
        return fallback();
      } finally { clearTimeout(timer); }
    })();
    try { return await pending; } finally { pending = undefined; }
  };
}

module.exports = { createDubIndex, parseDubIndex, getEnglishDubIds: createDubIndex() };
