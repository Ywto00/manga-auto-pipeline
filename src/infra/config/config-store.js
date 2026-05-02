const fs = require('fs');
const {
  getConfigPath,
  getListPath,
  getDownloadsPath,
  getLinkCachePath
} = require('./config-bootstrap');

/**
 * Loads the application configuration from disk.
 * @returns {Object} The parsed configuration object or an empty object if not found/invalid.
 */
function loadConfig() {
  try {
    const path = getConfigPath();
    if (!fs.existsSync(path)) return {};
    const content = fs.readFileSync(path, 'utf8');
    return JSON.parse(content || '{}');
  } catch (e) {
    console.error('Error loading config:', e);
    return {};
  }
}

/**
 * Saves the application configuration to disk.
 * @param {Object} config The configuration object to persist.
 */
function saveConfig(config) {
  try {
    const path = getConfigPath();
    fs.mkdirSync(require('path').dirname(path), { recursive: true });
    fs.writeFileSync(path, JSON.stringify(config, null, 2), 'utf8');
  } catch (e) {
    console.error('Error saving config:', e);
    throw e;
  }
}

/**
 * Checks if the configuration contains the minimum required values.
 */
function isConfigComplete(cfg) {
  if (!cfg) return false;
  return !!(cfg.dataDir && cfg.apiUrl && cfg.komgaUrl);
}

/**
 * Synchronizes configuration values into Suwayomi's server.conf.
 */
function syncServerConf(cfg) {
  const { syncServerConf: runnerSync } = require('../server/suwayomi-runner');
  return runnerSync(cfg);
}

module.exports = {
  loadConfig,
  saveConfig,
  isConfigComplete,
  syncServerConf,
  getConfigPath,
  getListPath,
  getDownloadsPath,
  getLinkCachePath
};
