// Central config helper: provide a single import point for app config.
// This delegates to the existing `loadConfig` implementation in `cli-logic`.

const { loadConfig: _loadConfig } = require('../..//cli-logic');

let _cached = null;

function loadConfig() {
  _cached = _loadConfig && _loadConfig();
  return _cached;
}

function getConfig() {
  if (!_cached) loadConfig();
  return _cached;
}

module.exports = {
  loadConfig,
  getConfig
};
