/**
 * Central configuration store for the application.
 *
 * Manages config resolution across multiple sources (env, bootstrap, legacy, defaults),
 * file I/O for config.json and supporting data files (list, downloads, link cache).
 *
 * All paths are derived from a single `dataDir` root that can be set
 * explicitly, via environment variable, or defaults.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

// ---------------------------------------------------------------------------
// Constants & root resolution
// ---------------------------------------------------------------------------

const DEV_DATA_ROOT = path.join(__dirname, '..', '..', '..', '..', 'data');
const PACKAGED_STATE_ROOT = path.join(
  process.env.APPDATA || path.join(os.homedir(), '.config'),
  'manga-auto-pipeline'
);
const PACKAGED_BOOTSTRAP_PATH = path.join(PACKAGED_STATE_ROOT, 'runtime.json');
const DEFAULT_MANAGED_DIR = path.join(os.homedir(), 'MangaPipeline');

/** Reads the packaged bootstrap file (created when running as pkg binary) */
function readPackagedBootstrap() {
  try {
    const txt = fs.readFileSync(PACKAGED_BOOTSTRAP_PATH, 'utf8') || '{}';
    const parsed = JSON.parse(txt);
    if (parsed && typeof parsed === 'object') return parsed;
  } catch (e) { /* ignore */ }
  return {};
}

/** Persists the dataDir into the packaged bootstrap file */
function writePackagedBootstrap(dataDir) {
  const dir = String(dataDir || '').trim() || DEFAULT_MANAGED_DIR;
  fs.mkdirSync(path.dirname(PACKAGED_BOOTSTRAP_PATH), { recursive: true });
  fs.writeFileSync(PACKAGED_BOOTSTRAP_PATH, JSON.stringify({ dataDir: dir }, null, 2), 'utf8');
}

function hasConfigAt(root) {
  if (!root) return false;
  return fs.existsSync(path.join(root, 'config.json'));
}

function toDataRootFromDir(baseDir) {
  const raw = String(baseDir || '').trim();
  if (!raw) return null;
  return path.join(path.resolve(raw), 'data');
}

/** Reads dataDir from an existing config.json file */
function readDataDirFromConfigFile(configPath) {
  try {
    if (!configPath || !fs.existsSync(configPath)) return '';
    const txt = fs.readFileSync(configPath, 'utf8') || '{}';
    return String(JSON.parse(txt).dataDir || '').trim();
  } catch (e) {
    return '';
  }
}

/**
 * Resolves the data root directory by checking multiple fallback sources in order:
 * 1. Explicit value passed as override
 * 2. Environment variable
 * 3. Packaged bootstrap file
 * 4. Legacy repo-data config
 * 5. Default managed directory
 * 6. Dev data root (for development)
 */
function resolveDataRoot(explicitDataDir = null) {
  if (explicitDataDir) return toDataRootFromDir(explicitDataDir);

  const bootstrap = readPackagedBootstrap();
  const bootstrapRoot = toDataRootFromDir(bootstrap.dataDir);
  const legacyRepoConfigPath = path.join(DEV_DATA_ROOT, 'config.json');
  const legacyDeclaredRoot = toDataRootFromDir(readDataDirFromConfigFile(legacyRepoConfigPath));
  const defaultManagedRoot = toDataRootFromDir(DEFAULT_MANAGED_DIR);

  const preferred = [bootstrapRoot, legacyDeclaredRoot, defaultManagedRoot, DEV_DATA_ROOT]
    .filter(Boolean);
  for (const root of preferred) {
    if (hasConfigAt(root)) return root;
  }

  // If no config exists yet, use managed behavior for packaged and dev behavior for source runs
  if (process && process.pkg) return defaultManagedRoot;
  return DEV_DATA_ROOT;
}

// ---------------------------------------------------------------------------
// File path helpers
// ---------------------------------------------------------------------------

function getDataPaths(explicitDataDir = null) {
  const root = resolveDataRoot(explicitDataDir);
  return {
    root,
    config: path.join(root, 'config.json'),
    list: path.join(root, 'list.json'),
    downloads: path.join(root, 'downloads.json'),
    linkCache: path.join(root, 'link-cache.json')
  };
}

function getConfigPath() { return getDataPaths().config; }
function getListPath() { return getDataPaths().list; }
function getDownloadsPath() { return getDataPaths().downloads; }
function getLinkCachePath() { return getDataPaths().linkCache; }

// ---------------------------------------------------------------------------
// Config CRUD
// ---------------------------------------------------------------------------

/**
 * Loads and parses config.json with sensible defaults for missing values.
 */
function loadConfig() {
  const cfg = {};
  try {
    var _readFileSync = fs.readFileSync(getConfigPath(), 'utf8') || '{}';
    var _parsed = JSON.parse(_readFileSync);
    Object.assign(cfg, _parsed);
  } catch (e) { /* use defaults */ }

  const bootstrap = readPackagedBootstrap();
  cfg.dataDir = String(cfg.dataDir || bootstrap.dataDir || DEFAULT_MANAGED_DIR).trim() || DEFAULT_MANAGED_DIR;
  return cfg;
}

/** Persists config to disk and updates bootstrap file if needed */
function saveConfig(cfg) {
  const explicitDataDir = cfg && cfg.dataDir ? String(cfg.dataDir).trim() : null;
  if (explicitDataDir) writePackagedBootstrap(explicitDataDir);
  const configPath = getDataPaths(explicitDataDir).config;
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2), 'utf8');
}

/** Checks if the minimum required configuration is present */
function isConfigComplete(cfg) {
  return Boolean(
    cfg &&
    cfg.jarPath &&
    cfg.dataDir &&
    cfg.downloadsPath &&
    (cfg.usernameAnilist || cfg.usernameMal) &&
    cfg.capsAhead
  );
}

// ---------------------------------------------------------------------------
// Config validation & server.conf sync
// ---------------------------------------------------------------------------

function quotePathForHocon(v) {
  return String(v || '').replace(/\\/g, '/');
}

function upsertHoconLine(hoconText, key, rawValue) {
  const rx = new RegExp('^\\s*' + key.replace(/[.*+?${}()|[\]\\]/g, '\\$&') + '\\s*=.*$', 'm');
  const line = `${key} = ${rawValue}`;
  if (rx.test(hoconText)) return hoconText.replace(rx, line);
  const suffix = hoconText.endsWith('\n') ? '' : '\n';
  return `${hoconText}${suffix}${line}\n`;
}

function toHoconString(v) {
  const s = String(v || '').replace(/\\/g, '/').replace(/"/g, '\\"');
  return `"${s}"`;
}

function toHoconStringArray(values) {
  const items = (values || []).map(v => `  ${toHoconString(v)}`).join(',\n');
  return `[\n${items}\n]`;
}

function replaceHoconArrayBlock(hoconText, key, arrayRawValue) {
  const keyEscaped = key.replace(/[.*+?${}()|[\]\\]/g, '\\$&');
  const blockPattern = new RegExp('^\\s*' + keyEscaped + '\\s*=\\s*\\[[\\s\\S]*?^\\s*\\]\\s*$', 'm');
  const singleLinePattern = new RegExp('^\\s*' + keyEscaped + '\\s*=.*$', 'm');
  const newBlock = `${key} = ${arrayRawValue}`;

  if (blockPattern.test(hoconText)) return hoconText.replace(blockPattern, newBlock);
  if (singleLinePattern.test(hoconText)) return hoconText.replace(singleLinePattern, newBlock);
  const suffix = hoconText.endsWith('\n') ? '' : '\n';
  return `${hoconText}${suffix}${newBlock}\n`;
}

/**
 * Synchronizes configuration values into Suwayomi's server.conf file.
 * Only touches values that have been explicitly configured; leaves the rest untouched.
 */
function syncServerConf(cfg) {
  if (!cfg || !cfg.dataDir) return;
  const confPath = path.join(cfg.dataDir, 'server.conf');
  let txt = '';
  if (fs.existsSync(confPath)) txt = fs.readFileSync(confPath, 'utf8');

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

function sanitizeFsName(name) {
  return String(name || 'unknown')
    .replace(/[<>:"/\\|?*]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

module.exports = {
  // Roots
  DEV_DATA_ROOT,
  DEFAULT_MANAGED_DIR,
  resolveDataRoot,

  // Paths
  getDataPaths,
  getConfigPath,
  getListPath,
  getDownloadsPath,
  getLinkCachePath,

  // CRUD
  loadConfig,
  saveConfig,
  isConfigComplete,

  // Server.conf
  quotePathForHocon,
  syncServerConf,
  sanitizeFsName
};
