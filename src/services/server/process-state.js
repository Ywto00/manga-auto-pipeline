const { loadConfig } = require('../../infra/config/config-store');

function isProcessAlive(pid) {
  const n = Number(pid || 0);
  if (!Number.isFinite(n) || n <= 0) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch (e) {
    return Boolean(e && e.code === 'EPERM');
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

module.exports = {
  isProcessAlive,
  isServerRunning,
  isKomgaRunning
};
