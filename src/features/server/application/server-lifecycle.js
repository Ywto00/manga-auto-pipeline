const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const { loadConfig, saveConfig } = require('../../../config/infra/config-store');
const { startSuwayomiJar, waitForSuwayomiReady } = require('../../server/infra/suwayomi-runner');
const { startKomgaJar, waitForKomgaReady, getEffectiveKomgaJavaArgs, moveJarToManaged } = require('../../komga/infra/komga-runner');
const { makeApiClient, stopDownloader, waitForDownloadsToFinish } = require('../../server/infra/suwayomi-api');
const { organizeDownloadsForKomga } = require('../../komga/infra/komga-organizer');

// Helpers left in cli-logic-adapter (to be required at call time to avoid circular dep issues).
function _cliLogic() {
  // eslint-disable-next-line global-require
  const cliLogic = require('../../../cli-logic-adapter');
  return cliLogic;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function startServer() {
  const cfg = loadConfig();
  if (!cfg.jarPath) throw new Error('No JAR configured.');
  if (!cfg.dataDir) throw new Error('No data folder configured.');

  cfg.downloadsPath = cfg.downloadsPath || path.join(cfg.dataDir, 'downloads');
  fs.mkdirSync(cfg.dataDir, { recursive: true });
  fs.mkdirSync(cfg.downloadsPath, { recursive: true });
  _cliLogic().syncServerConf(cfg);
  saveConfig(cfg);

  const runner = startSuwayomiJar(cfg.jarPath, {
    javaArgs: cfg.javaArgs || [],
    detached: true,
    configOverrides: {
      'server.rootDir': cfg.dataDir,
      'server.downloadsPath': cfg.downloadsPath,
      'server.systemTrayEnabled': false,
      'server.initialOpenInBrowserEnabled': false,
      'server.webUIEnabled': Boolean(cfg.suwayomiWebUIEnabled),
      'server.ip': cfg.serverBindIp || '0.0.0.0',
      'server.downloadAsCbz': true,
      'server.maxSourcesInParallel': Number(cfg.maxSourcesInParallel) || 6,
      ...(Array.isArray(cfg.extensionRepos) && cfg.extensionRepos.length
        ? { 'server.extensionRepos': cfg.extensionRepos }
        : {})
    }
  });

  const apiUrl = cfg.apiUrl || 'http://localhost:4567';
  let ready = false;
  for (let i = 0; i < 6; i += 1) {
    try {
      await waitForSuwayomiReady(apiUrl, 2000, 500);
      ready = true;
      break;
    } catch (e) {
      await sleep(200);
    }
  }

  cfg._runnerPid = runner.proc.pid;
  saveConfig(cfg);

  return { cfg, ready, pid: runner.proc.pid, apiUrl };
}

// Backward-compatible wrapper: legacy startKomga wrapper that uses the new startKomgaJar from komga-runner
// Old callers in menus/pipelines may still reference this signature via cli-logic
async function _startKomgaLegacy() {
  const cfg = loadConfig();
  if (!cfg.komgaJarPath) throw new Error('No Komga JAR configured.');
  if (!cfg.dataDir) throw new Error('No data folder configured.');

  const managedJarDir = path.join(cfg.dataDir, 'bin');
  try {
    cfg.komgaJarPath = moveJarToManaged(cfg.komgaJarPath, managedJarDir);
  } catch (e) {
    throw new Error(`Failed to move Komga JAR to managed bin folder: ${e.message}`);
  }

  cfg.komgaDataDir = cfg.komgaDataDir || path.join(cfg.dataDir, 'komga');
  cfg.komgaUrl = cfg.komgaUrl || 'http://localhost:25600';
  fs.mkdirSync(cfg.komgaDataDir, { recursive: true });
  saveConfig(cfg);

  const runner = startKomgaJar(cfg.komgaJarPath, {
    javaArgs: getEffectiveKomgaJavaArgs(cfg),
    appArgs: cfg.komgaAppArgs || [],
    detached: true,
    cwd: cfg.komgaDataDir,
    env: { ...process.env, KOMGA_CONFIGDIR: cfg.komgaDataDir }
  });

  const ready = await waitForKomgaReady(cfg.komgaUrl, 30000, 1000);
  cfg._komgaRunnerPid = runner.proc.pid;
  saveConfig(cfg);
  return { cfg, ready, pid: runner.proc.pid, komgaUrl: cfg.komgaUrl };
}

// Re-export alias for backward compatibility
const startKomga = _startKomgaLegacy;

async function stopDownloads() {
  const cfg = loadConfig();
  const apiUrl = cfg.apiUrl || 'http://localhost:4567';
  const client = makeApiClient(apiUrl, { timeout: Math.max(5000, Number(cfg.apiTimeoutMs || 30000)) });
  await stopDownloader(client);
  return true;
}

async function stopServer() {
  const cfg = loadConfig();
  const pid = Number(cfg._runnerPid || 0);
  if (!Number.isFinite(pid) || pid <= 0) {
    return { stopped: false, reason: 'no-runner-pid' };
  }

  let primaryStopped = false;
  let primaryReason = null;
  try {
    process.kill(pid);
    primaryStopped = true;
  } catch (e) {
    primaryReason = e.message;
  }

  // Best effort: also terminate manually started Suwayomi java processes on Windows.
  let aggressiveReason = null;
  if (process.platform === 'win32') {
    try {
      const ps = [
        "$targets = Get-CimInstance Win32_Process | Where-Object { ($_.Name -match '^java(w)?\\.exe$') -and ($_.CommandLine -match 'Suwayomi-Server') }",
        "foreach($p in $targets){ try { Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop } catch {} }",
        'Write-Output ($targets | Measure-Object).Count'
      ].join('; ');
      execFileSync('powershell.exe', ['-NoProfile', '-Command', ps], { encoding: 'utf8' });
    } catch (e) {
      aggressiveReason = e.message;
    }
  }

  cfg._runnerPid = null;
  saveConfig(cfg);

  return {
    stopped: primaryStopped,
    pid,
    reason: primaryReason,
    aggressiveReason
  };
}

async function stopKomga() {
  const cfg = loadConfig();
  const pid = Number(cfg._komgaRunnerPid || 0);
  if (!Number.isFinite(pid) || pid <= 0) {
    return { stopped: false, reason: 'no-komga-runner-pid' };
  }

  let primaryStopped = false;
  let primaryReason = null;
  try {
    if (process.platform === 'win32') {
      execFileSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'pipe'
      });
    } else {
      process.kill(pid);
    }
    primaryStopped = true;
  } catch (e) {
    primaryReason = e.message;
  }

  let aggressiveReason = null;
  let aggressiveKilled = 0;
  if (process.platform === 'win32') {
    try {
      const ps = [
        "$targets = Get-CimInstance Win32_Process | Where-Object { ($_.Name -match '^java(w)?\\.exe$') -and ($_.CommandLine -match 'komga') }",
        "foreach($p in $targets){ try { Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop } catch {} }",
        'Write-Output ($targets | Measure-Object).Count'
      ].join('; ');
      const out = execFileSync('powershell.exe', ['-NoProfile', '-Command', ps], { encoding: 'utf8' });
      const n = Number(String(out || '').trim());
      aggressiveKilled = Number.isFinite(n) ? n : 0;
    } catch (e) {
      aggressiveReason = e.message;
    }
  }

  const alreadyGone = typeof primaryReason === 'string' && /ESRCH/i.test(primaryReason);
  const stopped = primaryStopped || aggressiveKilled > 0 || alreadyGone;
  if (stopped) {
    cfg._komgaRunnerPid = null;
  }
  saveConfig(cfg);

  return {
    stopped,
    pid,
    reason: primaryReason,
    aggressiveReason,
    aggressiveKilled
  };
}

async function waitForDownloadsAndShutdown(options = {}) {
  const cfg = loadConfig();
  const apiUrl = cfg.apiUrl || 'http://localhost:4567';
  const timeoutMs = Number(options.timeoutMs || 0);
  const idleGraceMs = Number(options.idleGraceMs || 5000);

  const watcherResult = await waitForDownloadsToFinish(apiUrl, { timeoutMs, idleGraceMs });
  const stopped = await stopServer();
  return { watcherResult, stopped };
}

async function waitForDownloadsAndSyncKomga(options = {}) {
  const cliLogic = _cliLogic();
  const cfg = loadConfig();
  const apiUrl = cfg.apiUrl || 'http://localhost:4567';
  const timeoutMs = Number(options.timeoutMs || 0);
  const idleGraceMs = Number(options.idleGraceMs || 10000);

  const watcherResult = await waitForDownloadsToFinish(apiUrl, { timeoutMs, idleGraceMs });

  const organizeResult = await organizeDownloadsForKomga({
    mode: cfg.komgaOrganizeMode === 'copy' ? 'copy' : 'hardlink',
    createGhostFolders: cfg.komgaCreateGhostFolders === true,
    createSeriesMetadata: cfg.komgaCreateSeriesMetadata !== false,
    createSeriesCover: cfg.komgaCreateSeriesCover !== false,
    useDownloadsAsLibrary: cfg.komgaUseDownloadsAsLibrary !== false,
    forceSync: true
  });

  const scanResult = await cliLogic.triggerKomgaLibraryScan({
    scanDeep: true,
    scanForceModifiedTime: options.scanForceModifiedTime === true
  });

  const refreshResult = await cliLogic.triggerKomgaMetadataRefresh();
  const metadataPatchResult = await cliLogic.syncKomgaSeriesMetadataFromLocal();

  return {
    watcherResult,
    organizeResult,
    scanResult,
    refreshResult,
    metadataPatchResult
  };
}

module.exports = {
  startServer,
  _startKomgaLegacy,
  startKomga,
  stopDownloads,
  stopServer,
  stopKomga,
  waitForDownloadsAndShutdown,
  waitForDownloadsAndSyncKomga
};
