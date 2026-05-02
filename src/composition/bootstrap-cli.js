// Composition root for CLI entrypoint.

const createMainMenu = require('../interfaces/ui-cli/menus/main-menu');
const createSettingsMenu = require('../interfaces/ui-cli/menus/settings-menu');
const createSettingsGeneralMenu = require('../interfaces/ui-cli/menus/settings-general-menu');
const createSettingsSearchMenu = require('../interfaces/ui-cli/menus/settings-search-menu');
const presenter = require('../interfaces/ui-cli/adapters/presenter');
const { t, setLocale } = require('../interfaces/ui-cli/i18n');
const { ensurePrompt } = require('../interfaces/ui-cli/input/prompt');
const { pickFolderWithExplorer, chooseJarPath } = require('../interfaces/ui-cli/input/explorer-picker');
const { manageExtensionsUI } = require('../interfaces/ui-cli/menus/extensions-menu');
const { manageManualLinksUI } = require('../interfaces/ui-cli/menus/links-menu');
const {
  startPipelineUI,
  cleanupReadByAniListUI,
  organizeKomgaLibraryUI,
  startKomgaUI
} = require('../interfaces/ui-cli/menus/pipeline-menu');
const { loadConfig } = require('../shared/config');

function bootstrapCli() {
  try {
    const cfg = loadConfig();
    setLocale((cfg && cfg.locale) || 'en');
  } catch (e) {
    setLocale('en');
  }

  const { settingsGeneralMenu } = createSettingsGeneralMenu({
    presenter,
    ensurePrompt,
    pickFolderWithExplorer,
    chooseJarPath
  });

  const { settingsSearchMenu } = createSettingsSearchMenu({
    presenter,
    ensurePrompt
  });

  const { settingsMenu } = createSettingsMenu({
    t,
    ensurePrompt,
    settingsGeneralMenu,
    settingsSearchMenu,
    manageExtensionsUI,
    manageManualLinksUI
  });

  const { mainMenu } = createMainMenu({
    presenter,
    t,
    ensurePrompt,
    settingsMenu,
    openGeneralSettings: settingsGeneralMenu,
    startPipelineUI,
    cleanupReadByAniListUI,
    organizeKomgaLibraryUI,
    startKomgaUI
  });

  return { mainMenu };
}

module.exports = { bootstrapCli };
