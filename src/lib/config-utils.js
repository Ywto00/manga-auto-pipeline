function filterSourcesByConfig(sources, cfg) {
  let out = Array.isArray(sources) ? [...sources] : [];
  const config = cfg || {};

  const langs = Array.isArray(config.preferredSearchLangs)
    ? config.preferredSearchLangs.map(x => String(x || '').toLowerCase()).filter(Boolean)
    : [];

  if (langs.length) {
    const langSet = new Set(langs);
    out = out.filter(s => langSet.has(String(s && s.lang || '').toLowerCase()));
  }

  if (config.fixedSourceId != null && String(config.fixedSourceId).trim() !== '') {
    const target = String(config.fixedSourceId).trim();
    out = out.filter(s => String(s && s.id) === target);
  }

  return out;
}

function resolveEnqueuePrefs(cfg) {
  const config = cfg || {};
  const prefs = config.enqueuePreferences || {};
  const defaultLangs = Array.isArray(config.preferredSearchLangs) ? config.preferredSearchLangs : [];

  return {
    allowedLangs: Array.isArray(prefs.allowedLangs) && prefs.allowedLangs.length ? prefs.allowedLangs : defaultLangs,
    sourceOrderIds: Array.isArray(prefs.sourceOrderIds) ? prefs.sourceOrderIds.map(String) : [],
    priority: Array.isArray(prefs.priority) ? prefs.priority : [],
    autoShutdown: prefs.autoShutdown !== false,
    timeoutMinutes: Number.isFinite(Number(prefs.timeoutMinutes)) ? Number(prefs.timeoutMinutes) : 180
  };
}

module.exports = {
  filterSourcesByConfig,
  resolveEnqueuePrefs
};
