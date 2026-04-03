module.exports = function createMainMenu(deps) {
  const {
    presenter,
    t,
    ensurePrompt,
    settingsMenu,
    configureUI,
    startPipelineUI,
    cleanupReadByAniListUI,
    organizeKomgaLibraryUI,
    startKomgaUI
  } = deps;

  function mainChoices() {
    return {
      settings: t('menu.main.choice_settings'),
      startPipeline: t('menu.main.choice_start_pipeline'),
      startKomga: t('menu.main.choice_start_komga'),
      organizeKomga: t('menu.main.choice_organize_komga'),
      cleanupAniList: t('menu.main.choice_cleanup_anilist'),
      cancelDownloads: t('menu.main.choice_cancel_downloads'),
      exit: t('menu.main.choice_exit')
    };
  }

  async function stopDownloadsWithFeedback() {
    try {
      await presenter.stopDownloads();
      console.log(t('downloads.stopped'));
    } catch (e) {
      console.log(t('downloads.stopFailed', { error: e.message }));
    }
  }

  async function shutdownAll() {
    try {
      await presenter.stopDownloads();
    } catch (e) {
      // ignore
    }

    try {
      await presenter.stopServer();
    } catch (e) {
      // ignore
    }
  }

  async function mainMenu() {
    const prompt = ensurePrompt();
    const choices = mainChoices();

    const handlers = {
      [choices.settings]: settingsMenu,
      [choices.startPipeline]: startPipelineUI,
      [choices.startKomga]: startKomgaUI,
      [choices.organizeKomga]: organizeKomgaLibraryUI,
      [choices.cleanupAniList]: cleanupReadByAniListUI,
      [choices.cancelDownloads]: stopDownloadsWithFeedback,
      [choices.exit]: async () => {
        await shutdownAll();
        process.exit(0);
      }
    };

    const cfg = presenter.loadConfig();
    if (!presenter.isConfigComplete(cfg)) {
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
            choices.settings,
            choices.startPipeline,
            choices.startKomga,
            choices.organizeKomga,
            choices.cleanupAniList,
            choices.cancelDownloads,
            choices.exit
          ]
        }
      ]);

      if (handlers[ans.act]) await handlers[ans.act]();
    }
  }

  return { mainMenu };
};