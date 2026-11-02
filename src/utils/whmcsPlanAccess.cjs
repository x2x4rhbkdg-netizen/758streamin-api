function adultAccessForPlan(planName) {
  if (typeof planName !== 'string') return null;
  if (/\bno[\s_-]+xxx\b/i.test(planName)) return false;
  if (/\bxxx\b/i.test(planName)) return true;
  if (/\bpremium\b/i.test(planName)) return !/\btrial\b/i.test(planName);
  return null;
}

async function syncWhmcsPlanAccess(deviceId, planName, save) {
  const adultEnabled = adultAccessForPlan(planName);
  if (adultEnabled === null) return;
  const persist = save || require('./movieSettings.cjs').saveMovieSettings;
  await persist(deviceId, { adult_enabled: adultEnabled });
}

module.exports = { adultAccessForPlan, syncWhmcsPlanAccess };
