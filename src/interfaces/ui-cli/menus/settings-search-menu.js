const { runSearchSettingsFlow } = require('../../../features/settings/ui/search-settings-flow');

module.exports = function createSettingsSearchMenu(deps) {
  async function settingsSearchMenu() {
    return runSearchSettingsFlow(deps);
  }

  return { settingsSearchMenu };
};
