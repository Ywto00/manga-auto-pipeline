/**
 * Central config helper: delegate to the feature module config-store.
 * This keeps old require calls (e.g. from bootstrap-cli.js) working.
 */
const { loadConfig, saveConfig, isConfigComplete, syncServerConf } = require('../features/config/infra/config-store');

function getConfig() {
  return loadConfig();
}

module.exports = {
  loadConfig,
  saveConfig,
  getConfig,
  isConfigComplete,
  syncServerConf
};
