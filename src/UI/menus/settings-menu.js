// Legacy compatibility wrapper.
// Main settings flow now lives in `src/interfaces/ui-cli/menus`.

const presenter = require('../../interfaces/ui-cli/adapters/presenter');
const { ensurePrompt } = require('../../interfaces/ui-cli/input/prompt');
const { pickFolderWithExplorer, chooseJarPath } = require('../../interfaces/ui-cli/input/explorer-picker');
const createSettingsGeneralMenu = require('../../interfaces/ui-cli/menus/settings-general-menu');
const createSettingsSearchMenu = require('../../interfaces/ui-cli/menus/settings-search-menu');

async function configureUI(uiDeps = {}) {
  const { settingsGeneralMenu } = createSettingsGeneralMenu({
    presenter,
    ensurePrompt: uiDeps.ensurePrompt || ensurePrompt,
    pickFolderWithExplorer: uiDeps.pickFolderWithExplorer || pickFolderWithExplorer,
    chooseJarPath: uiDeps.chooseJarPath || chooseJarPath
  });
  return settingsGeneralMenu();
}

async function searchSettingsUI(uiDeps = {}) {
  const { settingsSearchMenu } = createSettingsSearchMenu({
    presenter,
    ensurePrompt: uiDeps.ensurePrompt || ensurePrompt
  });
  return settingsSearchMenu();
}

module.exports = {
  configureUI,
  searchSettingsUI
};
