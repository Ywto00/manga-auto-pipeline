/**
 * Pipeline orchestration service.
 * Handles the startup sequence, synchronization, and high-level pipeline flows.
 */
const {
  loadConfig,
  applyConfigValues
} = require('../../infra/config/config-store');
const {
  startServer,
  startKomga,
  waitForDownloadsAndSyncKomga
} = require('../server/server-lifecycle');
const {
  ensureJarReady
} = require('../pipeline/jar-management');
const {
  startBackgroundEnqueueWorker,
  runEnqueueBackgroundTask
} = require('../../infra/pipeline/background-enqueue-worker');
const {
  fetchUserList,
  enqueueFromList
} = require('../sync-service');
const {
  resolveEnqueuePrefs
} = require('../pipeline/resolve-enqueue-prefs');

async function initializePipeline(deps) {
  const {
    prompt,
    chooseJarPath,
    moveJarToManagedFolder,
    logger = console,
    ui = {
      NotificationManager: {
        instance: {
          info: () => {},
          success: () => {},
          warning: () => {},
          error: () => {}
        }
      },
      withSpinner: async (msg, fn) => await fn(),
      colors: {
        primary: (s) => s,
        success: (s) => s,
        warning: (s) => s,
        error: (s) => s,
        muted: (s) => s,
        info: (s) => s
      }
    }
  } = deps;

  try {
    ui.NotificationManager.instance.info('Verificando configuração...');
    let cfg = loadConfig();
    if (!cfg.usernameAnilist) {
      const ans = await prompt([{ name: 'user', message: ui.colors.primary('Usuário AniList') }]);
      if (!ans.user) {
        throw new Error('Usuário AniList não informado');
      }
      cfg = applyConfigValues({ usernameAnilist: ans.user });
      ui.NotificationManager.instance.success('Usuário configurado: ' + ans.user);
    }

    ui.NotificationManager.instance.info('Verificando JAR do Suwayomi...');
    cfg = await ensureJarReady({
      cfg,
      kind: 'suwayomi',
      prompt,
      chooseJarPath,
      moveJarToManagedFolder,
      applyConfigValues
    });

    ui.NotificationManager.instance.info('Iniciando Suwayomi...');
    const suwayomi = await ui.withSpinner('Iniciando servidor Suwayomi', async () => {
      return await startServer();
    });

    const cfgNow = loadConfig();
    const workerStart = startBackgroundEnqueueWorker();
    if (workerStart.ok) {
      ui.NotificationManager.instance.success(`Worker background iniciado (pid=${workerStart.pid})`);
    } else {
      ui.NotificationManager.instance.warning(`Usando enqueue local (${workerStart.reason})`);
      // We don't await this since it's a background task
      runEnqueueBackgroundTask(cfgNow, {
        fetchUserList,
        enqueueFromList,
        resolveEnqueuePrefs,
        logger: console
      }).catch((e) => {
        logger.error(`[ENQUEUE] Falha: ${e.message}`);
      });
    }

    const currentCfg = loadConfig();
    if (currentCfg.komgaSyncOnStart !== false) {
      await waitForDownloadsAndSyncKomga({ scanForceModifiedTime: true });
    }

    return {
      success: true,
      suwayomi,
      cfg: currentCfg
    };
  } catch (e) {
    return {
      success: false,
      error: e.message
    };
  }
}

module.exports = { initializePipeline };
