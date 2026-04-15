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
    startKomgaUI,
    downloadManualMangaUI
  } = deps;

  function mainChoices() {
    return {
      settings: t('menu.main.choice_settings'),
      startPipeline: t('menu.main.choice_start_pipeline'),
      startKomga: t('menu.main.choice_start_komga'),
      organizeKomga: t('menu.main.choice_organize_komga'),
      cleanupAniList: t('menu.main.choice_cleanup_anilist'),
      downloadManual: 'Download Manual (escolher manga)',
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
      [choices.downloadManual]: downloadManualMangaUI,
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

    while (true) {
      // Show enhanced config summary with status indicators
      ui.separator('📊 Status do Sistema');

      // AniList status with icon
      const anilistStatus = cfg.usernameAnilist
        ? `${ui.colors.success('✓')} ${cfg.usernameAnilist}`
        : `${ui.colors.error('✗')} não configurado`;
      console.log(`  ${ui.colors.primary('AniList:')} ${anilistStatus}`);

      // Downloads path status
      const downloadsStatus = cfg.downloadsPath
        ? `${ui.colors.success('✓')} configurado`
        : `${ui.colors.error('✗')} não configurado`;
      console.log(`  ${ui.colors.primary('Downloads:')} ${downloadsStatus}`);

      // Organization mode
      console.log(`  ${ui.colors.primary('Organização:')} ${ui.colors.info(cfg.komgaOrganizeMode || 'hardlink')}`);

      // Server status indicators
      const serverStatus = presenter.isServerRunning()
        ? `${ui.colors.success('●')} online`
        : `${ui.colors.error('○')} offline`;
      console.log(`  ${ui.colors.primary('Suwayomi:')} ${serverStatus}`);

      const komgaStatus = presenter.isKomgaRunning()
        ? `${ui.colors.success('●')} online`
        : `${ui.colors.error('○')} offline`;
      console.log(`  ${ui.colors.primary('Komga:')} ${komgaStatus}`);

      console.log('');

      const ans = await prompt([
        {
          type: 'list',
          name: 'act',
          message: ui.colors.primary('🎯 Menu Principal'),
          choices: [
            { name: `${ui.colors.primary('⚙️ ')} ${choices.settings}`, value: choices.settings },
            { name: `${ui.colors.success('▶️ ')} ${choices.startPipeline}`, value: choices.startPipeline },
            { name: `${ui.colors.info('📺 ')} ${choices.startKomga}`, value: choices.startKomga },
            { name: `${ui.colors.warning('📚 ')} ${choices.organizeKomga}`, value: choices.organizeKomga },
            { name: `${ui.colors.error('🧹 ')} ${choices.cleanupAniList}`, value: choices.cleanupAniList },
            { name: `${ui.colors.warning('⬇️ ')} ${choices.downloadManual}`, value: choices.downloadManual },
            { name: `${ui.colors.warning('⏹️ ')} ${choices.cancelDownloads}`, value: choices.cancelDownloads },
            '---',
            { name: `${ui.colors.muted('🚪 ')} ${choices.exit}`, value: choices.exit }
          ]
        }
      ]);

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
            // Enhanced auto-summary with icons and colors
            const stats = [];
            if (result.patched) stats.push(`${ui.colors.success(result.patched + ' atualizados')}`);
            if (result.skipped) stats.push(`${ui.colors.warning(result.skipped + ' ignorados')}`);
            if (result.failed) stats.push(`${ui.colors.error(result.failed + ' falhas')}`);
            if (stats.length) {
              ui.NotificationManager.instance.success('Concluído: ' + stats.join(' | '));
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