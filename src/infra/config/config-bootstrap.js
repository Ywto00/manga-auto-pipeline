const fs = require('fs');
const path = require('path');
const os = require('os');

const DEV_DATA_ROOT = path.join(__dirname, '..', '..', '..', '..', 'data');
const PACKAGED_STATE_ROOT = path.join(
  process.env.APPDATA || path.join(os.homedir(), '.config'),
  'manga-auto-pipeline'
);
const PACKAGED_BOOTSTRAP_PATH = path.join(PACKAGED_STATE_ROOT, 'runtime.json');
const DEFAULT_MANAGED_DIR = path.join(os.homedir(), 'MangaPipeline');

function readPackagedBootstrap() {
  try {
    const txt = fs.readFileSync(PACKAGED_BOOTSTRAP_PATH, 'utf8') || '{}';
    const parsed = JSON.parse(txt);
    if (parsed && typeof parsed === 'object') return parsed;
  } catch (e) {
    // ignore
  }
  return {};
}

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

function readDataDirFromConfigFile(configPath) {
  try {
    if (!configPath || !fs.existsSync(configPath)) return '';
    const txt = fs.readFileSync(configPath, 'utf8') || '{}';
    const parsed = JSON.parse(txt);
    return String(parsed && parsed.dataDir || '').trim();
  } catch (e) {
    return '';
  }
}

function resolveDataRoot(explicitDataDir = null) {
  if (explicitDataDir) {
    return toDataRootFromDir(explicitDataDir);
  }

  const bootstrap = readPackagedBootstrap();
  const bootstrapRoot = toDataRootFromDir(bootstrap.dataDir);
  const legacyRepoConfigPath = path.join(DEV_DATA_ROOT, 'config.json');
  const legacyDeclaredRoot = toDataRootFromDir(readDataDirFromConfigFile(legacyRepoConfigPath));
  const defaultManagedRoot = toDataRootFromDir(DEFAULT_MANAGED_DIR);

  const preferred = [bootstrapRoot, legacyDeclaredRoot, defaultManagedRoot, DEV_DATA_ROOT].filter(Boolean);
  for (const root of preferred) {
    if (hasConfigAt(root)) return root;
  }

  // If no config exists yet, keep repo-data behavior in dev and managed behavior in packaged builds.
  if (process && process.pkg) return defaultManagedRoot;
  return DEV_DATA_ROOT;
}

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

function getConfigPath() {
  return getDataPaths().config;
}

function getListPath() {
  return getDataPaths().list;
}

function getDownloadsPath() {
  return getDataPaths().downloads;
}

function getLinkCachePath() {
  return getDataPaths().linkCache;
}

module.exports = {
  DEV_DATA_ROOT,
  PACKAGED_STATE_ROOT,
  PACKAGED_BOOTSTRAP_PATH,
  DEFAULT_MANAGED_DIR,
  readPackagedBootstrap,
  writePackagedBootstrap,
  hasConfigAt,
  toDataRootFromDir,
  readDataDirFromConfigFile,
  resolveDataRoot,
  getDataPaths,
  getConfigPath,
  getListPath,
  getDownloadsPath,
  getLinkCachePath
};
