const { runGeneralSettingsFlow } = require('../../../ui/settings/general-settings-flow');

module.exports = function createSettingsGeneralMenu(deps) {
  async function settingsGeneralMenu() {
    return runGeneralSettingsFlow(deps);
  }

  return { settingsGeneralMenu };
};
