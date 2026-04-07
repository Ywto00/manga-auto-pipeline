const ui = require('../feedback/ui-enhancements');
const { ensurePrompt } = require('../input/prompt');
const { getDownloadsOverview } = require('../../../cli-logic-adapter');

module.exports = function createMainMenu(deps) {
  const {
    presenter,
    t,
    settingsMenu,
    openGeneralSettings,
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
      ui.NotificationManager.instance.success(t('downloads.stopped'));
    } catch (e) {
      ui.NotificationManager.instance.error(t('downloads.stopFailed', { error: e.message }));
    }
  }

  async function shutdownAll() {
    try {
      await presenter.stopDownloads();
    } catch (e) { /* ignore */ }
    try {
      await presenter.stopServer();
    } catch (e) { /* ignore */ }
    try {
      await presenter.stopKomga();
    } catch (e) { /* ignore */ }
  }

  function createDashboard() {
    const dashboard = new ui.LiveDashboard();

    // Add live status sections
    dashboard.section('Downloads', () => {
      try {
        const status = presenter.getDownloadsStatus && presenter.getDownloadsStatus();
        if (status) {
          return `${status.queueSize || 0} na fila`;
        }
        return '--';
      } catch (e) {
        return '--';
      }
    });

    dashboard.section('Suwayomi', () => {
      const cfg = presenter.loadConfig();
      return cfg.serverBindIp || 'parado';
    });

    dashboard.section('Komga', () => {
      const cfg = presenter.loadConfig();
      return cfg.komgaUrl || 'parado';
    });

    return dashboard;
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

    // Show banner on first run
    if (process.env.NODE_ENV !== 'test') {
      ui.showBanner();
    }

    // Setup initial config
    const cfg = presenter.loadConfig();
    if (!presenter.isConfigComplete(cfg)) {
      ui.NotificationManager.instance.warning(t('firstRun.missingConfig'));
      await openGeneralSettings();
    }

    // Create hotkeys for quick actions
    const hotkeys = new ui.HotkeyManager();
    hotkeys.bind('ctrl+c', () => {
      ui.NotificationManager.instance.info('Saindo...');
      setTimeout(() => process.exit(0), 500);
    });
    hotkeys.bind('escape', () => {
      ui.NotificationManager.instance.info('Retornando ao menu...');
    });

    // Create live dashboard
    const dashboard = createDashboard();

    while (true) {
      // Start dashboard
      dashboard.start();

      // Show config summary
      ui.separator('Configuração Atual');
      console.log(`  ${ui.colors.muted('AniList:')} ${cfg.usernameAnilist || ' não configurado '}`);
      console.log(`  ${ui.colors.muted('Downloads:')} ${cfg.downloadsPath || ' não configurado '}`);
      console.log(`  ${ui.colors.muted('Modo de organização:')} ${cfg.komgaOrganizeMode || 'hardlink'}`);
      console.log('');

      const ans = await prompt([
        {
          type: 'list',
          name: 'act',
          message: ui.colors.primary('📋 Menu Principal'),
          choices: [
            ...Object.values(choices).slice(0, -1), // All except exit
            ui.colors.error('🚪 ' + choices.exit)
          ]
        }
      ]);

      // Stop dashboard before action
      dashboard.stop();

      if (ans.act === choices.exit) {
        await shutdownAll();
        break;
      }

      if (handlers[ans.act]) {
        try {
          ui.separator();
          const result = await handlers[ans.act]();
          ui.separator();

          if (result && typeof result === 'object') {
            // Auto-summary if function returned stats
            const stats = [];
            if (result.patched) stats.push(`${result.patched} atualizados`);
            if (result.skipped) stats.push(`${result.skipped} ignorados`);
            if (result.failed) stats.push(`${result.failed} falhas`);
            if (stats.length) {
              ui.NotificationManager.instance.success('Concluído: ' + stats.join(', '));
            }
          } else {
            ui.NotificationManager.instance.success('Operação concluída');
          }
        } catch (e) {
          ui.NotificationManager.instance.error(`Erro: ${e.message}`);
        }
      }
    }

    hotkeys.destroy();
    return;
  }

  return { mainMenu };
};