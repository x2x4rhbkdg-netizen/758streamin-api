const fail = (message, status = 400) => Object.assign(new Error(message), { status });

function catalogSection(value) {
  if (value == null || value === '') return 'movies';
  if (value !== 'anime') throw fail('Invalid catalog section');
  return 'anime';
}

function requireCatalogAccess(settings, section) {
  if (section === 'anime' ? settings.anime_enabled !== true : settings.enabled !== true) {
    throw fail(section === 'anime' ? 'Anime is disabled for this device' : 'Movies and Series are disabled for this device', 403);
  }
}

function isAnime(data) {
  const animated = data.genre_ids?.includes(16) || data.genres?.some((genre) => genre.id === 16);
  const japanese = data.origin_country?.includes('JP') || data.production_countries?.some((country) => country.iso_3166_1 === 'JP');
  return !data.adult && !!animated && !!japanese;
}

function requireAnime(data) {
  if (!isAnime(data)) throw fail('Anime title unavailable', 404);
  return data;
}

module.exports = { catalogSection, requireCatalogAccess, isAnime, requireAnime };
