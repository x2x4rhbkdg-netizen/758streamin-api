async function tmdb(settings, path, params = {}) {
  const url = new URL(`https://api.themoviedb.org/3/${path}`);
  url.searchParams.set('language', 'en-US');
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(url, { signal: controller.signal, redirect: 'error', headers: {
      Authorization: `Bearer ${settings.tmdb_read_access_token}`, Accept: 'application/json',
    } });
    if (!response.ok) throw Object.assign(new Error(response.status === 401 || response.status === 403
      ? 'TMDB rejected the configured token. Update Media Settings in the dashboard.' : 'Movie catalog temporarily unavailable'), { status: 502 });
    return await response.json();
  } finally { clearTimeout(timer); }
}
module.exports = { tmdb };
