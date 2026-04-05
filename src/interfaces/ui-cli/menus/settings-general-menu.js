const { runGeneralSettingsFlow } = require('../../../features/settings/ui/general-settings-flow');

module.exports = function createSettingsGeneralMenu(deps) {
  async function settingsGeneralMenu() {
    return runGeneralSettingsFlow(deps);
  }

  return { settingsGeneralMenu };
};
