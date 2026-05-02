const { runSearchSettingsFlow } = require('../../../ui/settings/search-settings-flow');

module.exports = function createSettingsSearchMenu(deps) {
  async function settingsSearchMenu() {
    return runSearchSettingsFlow(deps);
  }

  return { settingsSearchMenu };
};
