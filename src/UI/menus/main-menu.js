const {
  loadConfig,
  isConfigComplete,
  stopDownloads,
  stopServer
} = require('../../interfaces/ui-cli/presenter');
const { t } = require('../../interfaces/ui-cli/i18n');
const { ensurePrompt } = require('../../interfaces/ui-cli/prompt');
const { configureUI, searchSettingsUI } = require('./settings-menu');
const { startPipelineUI, cleanupReadByAniListUI, organizeKomgaLibraryUI, startKomgaUI } = require('./pipeline-menu');
const { manageExtensionsUI } = require('./extensions-menu');
const { manageManualLinksUI } = require('./links-menu');

async function settingsMenu() {
  const prompt = ensurePrompt();

  while (true) {
    const ans = await prompt([
      {
        type: 'list',
        name: 'act',
        message: t('menu.settings.title'),
        choices: [
          t('menu.settings.general'),
          t('menu.settings.search'),
          t('menu.settings.extensions'),
          t('menu.settings.links'),
          t('menu.settings.back')
        ]
      }
    ]);

    if (ans.act === t('menu.settings.general')) await configureUI();

    if (ans.act === t('menu.settings.search')) await searchSettingsUI();

    if (ans.act === t('menu.settings.extensions')) {
      try {
        await manageExtensionsUI();
      } catch (e) {
        console.log(t('extensions.requireSuwayomi'));
      }
    }

    if (ans.act === t('menu.settings.links')) {
      await manageManualLinksUI();
    }

    if (ans.act === t('menu.settings.back')) return;
  }
}

async function shutdownAll() {
  try {
    await stopDownloads();
  } catch (e) {
    // ignore
  }

  try {
    await stopServer();
  } catch (e) {
    // ignore
  }
}

async function mainMenu() {
  const prompt = ensurePrompt();
    const cfg = loadConfig();
    if (!isConfigComplete(cfg)) {
      console.log(t('firstRun.missingConfig'));
      await configureUI();
    }

  while (true) {
    const ans = await prompt([
      {
        type: 'list',
        name: 'act',
          message: t('menu.main.title'),
          choices: [
            t('menu.main.choice_settings'),
            t('menu.main.choice_start_pipeline'),
            t('menu.main.choice_start_komga'),
            t('menu.main.choice_organize_komga'),
            t('menu.main.choice_cleanup_anilist'),
            t('menu.main.choice_cancel_downloads'),
            t('menu.main.choice_exit')
          ]
      }
    ]);

    if (ans.act === t('menu.main.choice_settings')) await settingsMenu();

    if (ans.act === t('menu.main.choice_start_pipeline')) {
      await startPipelineUI();
    }

    if (ans.act === t('menu.main.choice_start_komga')) {
      await startKomgaUI();
    }

    if (ans.act === t('menu.main.choice_organize_komga')) {
      await organizeKomgaLibraryUI();
    }

    if (ans.act === t('menu.main.choice_cleanup_anilist')) {
      await cleanupReadByAniListUI();
    }

      if (ans.act === t('menu.main.choice_cancel_downloads')) {
        try {
          await stopDownloads();
          console.log(t('downloads.stopped'));
        } catch (e) {
          console.log(t('downloads.stopFailed', { error: e.message }));
        }
    }

    if (ans.act === t('menu.main.choice_exit')) {
      await shutdownAll();
      process.exit(0);
    }
  }
}

module.exports = {
  mainMenu
};