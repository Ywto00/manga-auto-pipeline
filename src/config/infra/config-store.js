const fs = require('fs');
const path = require('path');

const {
  DEV_DATA_ROOT,
  PACKAGED_STATE_ROOT,
  PACKAGED_BOOTSTRAP_PATH,
  DEFAULT_MANAGED_DIR,
  DATA_DIR_ENV_KEY,
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
} = require('../../features/config/infra/config-bootstrap');

function loadConfig() {
  const configPath = getConfigPath();
  try {
    const txt = fs.readFileSync(configPath, 'utf8') || '{}';
    const cfg = JSON.parse(txt);
    const bootstrap = readPackagedBootstrap();
    cfg.dataDir = String(cfg.dataDir || bootstrap.dataDir || DEFAULT_MANAGED_DIR).trim() || DEFAULT_MANAGED_DIR;
    return cfg;
  } catch (e) {
    const bootstrap = readPackagedBootstrap();
    return {
      dataDir: String(bootstrap.dataDir || DEFAULT_MANAGED_DIR).trim() || DEFAULT_MANAGED_DIR
    };
  }
}

function saveConfig(cfg) {
  const explicitDataDir = cfg && cfg.dataDir ? String(cfg.dataDir).trim() : null;
  if (explicitDataDir) {
    writePackagedBootstrap(explicitDataDir);
  }
  const configPath = getDataPaths(explicitDataDir).config;
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2), 'utf8');
}

module.exports = {
  DEV_DATA_ROOT,
  PACKAGED_STATE_ROOT,
  PACKAGED_BOOTSTRAP_PATH,
  DEFAULT_MANAGED_DIR,
  DATA_DIR_ENV_KEY,
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
  getLinkCachePath,
  loadConfig,
  saveConfig
};
