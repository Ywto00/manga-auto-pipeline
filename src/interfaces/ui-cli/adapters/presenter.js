const {
  loadConfig,
  saveConfig,
  moveJarToManagedFolder,
  applyConfigValues,
  getSources,
  isConfigComplete,
  stopDownloads,
  stopServer,
  stopKomga
} = require('../../../cli-logic-adapter');

const { startServer } = require('../../../cli-logic-adapter');

module.exports = {
  loadConfig,
  saveConfig,
  moveJarToManagedFolder,
  applyConfigValues,
  getSources,
  isConfigComplete,
  stopDownloads,
  stopServer,
  stopKomga,
  startServer,
  isServerRunning,
  isKomgaRunning
};

// Helper functions for UI status indicators
function isProcessAlive(pid) {
  const n = Number(pid || 0);
  if (!Number.isFinite(n) || n <= 0) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch (e) {
    // EPERM means process exists but current user cannot signal it.
    if (e && e.code === 'EPERM') return true;
    return false;
  }
}

function isServerRunning() {
  const cfg = loadConfig();
  return isProcessAlive(cfg._runnerPid);
}

function isKomgaRunning() {
  const cfg = loadConfig();
  return isProcessAlive(cfg._komgaRunnerPid);
}
