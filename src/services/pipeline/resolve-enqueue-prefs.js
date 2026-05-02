function resolveEnqueuePrefs(cfg) {
  const prefs = cfg.enqueuePreferences || {};
  const defaultLangs = Array.isArray(cfg.preferredSearchLangs) ? cfg.preferredSearchLangs : [];
  return {
    allowedLangs: Array.isArray(prefs.allowedLangs) && prefs.allowedLangs.length ? prefs.allowedLangs : defaultLangs,
    sourceOrderIds: Array.isArray(prefs.sourceOrderIds) ? prefs.sourceOrderIds.map(String) : [],
    priority: Array.isArray(prefs.priority) ? prefs.priority : [],
    autoShutdown: prefs.autoShutdown !== false,
    timeoutMinutes: Number.isFinite(Number(prefs.timeoutMinutes)) ? Number(prefs.timeoutMinutes) : 180
  };
}

module.exports = {
  resolveEnqueuePrefs
};