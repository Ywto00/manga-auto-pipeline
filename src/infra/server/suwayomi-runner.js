/**
 * Suwayomi server runner.
 *
 * Starts and stops the Suwayomi JAR as a subprocess,
 * configures server.conf, and waits for the API to become available.
 */
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const axios = require('axios');

// ---------------------------------------------------------------------------
// JAR process
// ---------------------------------------------------------------------------

/**
 * Starts the Suwayomi JAR.
 * @param {{ jarPath: string, dataDir: string, downloadsPath?: string, serverBindIp?: string, webUIEnabled?: boolean, extensionRepos?: string[], maxSourcesInParallel?: number, javaArgs?: string[] }} cfg
 * @returns {{ proc: import('child_process').ChildProcess, apiUrl: string, stop: Function }}
 */
function startSuwayomiJar(cfg) {
  const webUIEnabled = cfg.webUIEnabled != null
    ? Boolean(cfg.webUIEnabled)
    : Boolean(cfg.suwayomiWebUIEnabled);

  const configOverrides = {
    'server.rootDir': cfg.dataDir,
    'server.downloadsPath': cfg.downloadsPath || path.join(cfg.dataDir, 'downloads'),
    'server.systemTrayEnabled': false,
    'server.initialOpenInBrowserEnabled': false,
    'server.webUIEnabled': webUIEnabled,
    'server.ip': cfg.serverBindIp || '0.0.0.0',
    'server.downloadAsCbz': true,
    'server.maxSourcesInParallel': Number(cfg.maxSourcesInParallel) || 6
  };

  if (Array.isArray(cfg.extensionRepos) && cfg.extensionRepos.length) {
    configOverrides['server.extensionRepos'] = cfg.extensionRepos;
  }

  const javaArgs = cfg.javaArgs || [];
  const allArgs = [];

  // Build -D overrides
  for (const [key, value] of Object.entries(configOverrides)) {
    allArgs.push(`-Dsuwayomi.tachidesk.config.${key}=${serializeHoconConfig(value)}`);
  }
  allArgs.push(...javaArgs);
  allArgs.push('-jar', cfg.jarPath);

  const proc = spawn('java', allArgs, {
    stdio: 'ignore',
    detached: true
  });
  proc.unref && proc.unref();

  return {
    proc,
    apiUrl: cfg.apiUrl || 'http://localhost:4567',
    stop: () => { try { proc.kill(); } catch (e) { /* ignore */ } }
  };
}

/**
 * Writes/updates a single key=value line in server.conf, replacing it if present.
 */
function upsertHoconLine(hoconText, key, rawValue) {
  const rx = new RegExp('^\\s*' + key.replace(/[.*+?${}()|[\]\\]/g, '\\$&') + '\\s*=.*$', 'm');
  const line = `${key} = ${rawValue}`;
  if (rx.test(hoconText)) return hoconText.replace(rx, line);
  return `${hoconText}${hoconText.endsWith('\n') ? '' : '\n'}${line}\n`;
}

/**
 * Replaces a multi-line HOCON array with a new one.
 */
function replaceHoconArrayBlock(hoconText, key, arrayRawValue) {
  const keyEscaped = key.replace(/[.*+?${}()|[\]\\]/g, '\\$&');
  const blockPattern = new RegExp('^\\s*' + keyEscaped + '\\s*=\\s*\\[[\\s\\S]*?^\\s*\\]\\s*$', 'm');
  const singleLinePattern = new RegExp('^\\s*' + keyEscaped + '\\s*=.*$', 'm');
  const newBlock = `${key} = ${arrayRawValue}`;

  if (blockPattern.test(hoconText)) return hoconText.replace(blockPattern, newBlock);
  if (singleLinePattern.test(hoconText)) return hoconText.replace(singleLinePattern, newBlock);
  return `${hoconText}${hoconText.endsWith('\n') ? '' : '\n'}${newBlock}\n`;
}

function toHoconString(v) {
  const s = String(v || '').replace(/\\/g, '/').replace(/"/g, '\\"');
  return `"${s}"`;
}

function toHoconStringArray(values) {
  return `[\n${(values || []).map(v => `  ${toHoconString(v)}`).join(',\n')}\n]`;
}

function quotePathForHocon(v) {
  return String(v || '').replace(/\\/g, '/');
}

function serializeHoconConfig(v) {
  if (Array.isArray(v)) {
    const quoted = v.map(item => `"${String(item).replace(/\\/g, '/').replace(/"/g, '\\"')}"`);
    return `[${quoted.join(',')}]`;
  }
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (v == null) return '';
  return String(v);
}

/**
 * Synchronizes config values into the Suwayomi server.conf file.
 */
function syncServerConf(cfg) {
  if (!cfg || !cfg.dataDir) return;
  const confPath = path.join(cfg.dataDir, 'server.conf');
  let txt = fs.existsSync(confPath) ? fs.readFileSync(confPath, 'utf8') : '';

  txt = upsertHoconLine(txt, 'server.systemTrayEnabled', 'false');
  txt = upsertHoconLine(txt, 'server.initialOpenInBrowserEnabled', 'false');
  txt = upsertHoconLine(txt, 'server.webUIEnabled', cfg.suwayomiWebUIEnabled ? 'true' : 'false');
  txt = upsertHoconLine(txt, 'server.ip', toHoconString(cfg.serverBindIp || '0.0.0.0'));
  txt = upsertHoconLine(txt, 'server.downloadAsCbz', 'true');
  txt = upsertHoconLine(txt, 'server.downloadsPath', toHoconString(quotePathForHocon(cfg.downloadsPath || '')));
  if (Number.isFinite(Number(cfg.maxSourcesInParallel)) && Number(cfg.maxSourcesInParallel) >= 1) {
    txt = upsertHoconLine(txt, 'server.maxSourcesInParallel', String(Number(cfg.maxSourcesInParallel)));
  }
  if (Array.isArray(cfg.extensionRepos) && cfg.extensionRepos.length > 0) {
    txt = replaceHoconArrayBlock(txt, 'server.extensionRepos', toHoconStringArray(cfg.extensionRepos));
  }

  fs.mkdirSync(path.dirname(confPath), { recursive: true });
  fs.writeFileSync(confPath, txt, 'utf8');
}

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------

/**
 * Polls the Suwayomi API until it responds with HTTP 200 or times out.
 */
async function waitForSuwayomiReady(apiUrl, timeout = 30000, interval = 1000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      const aboutUrl = `${String(apiUrl || '').replace(/\/+$/, '')}/api/v1/settings/about`;
      const res = await axios.get(aboutUrl, {
        timeout: 3000,
        validateStatus: () => true
      });
      if (res.status >= 200 && res.status < 500) return true;
    } catch (e) { /* ignore and retry */ }
    await new Promise(r => setTimeout(r, interval));
  }
  throw new Error(`Suwayomi did not become ready at ${apiUrl} within ${timeout}ms`);
}

module.exports = {
  startSuwayomiJar,
  waitForSuwayomiReady,
  syncServerConf,
  quotePathForHocon
};
