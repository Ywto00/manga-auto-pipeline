/**
 * Komga orchestration service.
 * Handles the setup, organization, and lifecycle of the Komga Media Server.
 */
const {
  loadConfig,
  applyConfigValues
} = require('../../infra/config/config-store');
const {
  startKomga
} = require('../server/server-lifecycle');
const {
  ensureJarReady
} = require('../pipeline/jar-management');
const {
  organizeDownloadsForKomga
} = require('../../infra/komga/komga-organizer');
const {
  ensureKomgaLibraryExists,
  triggerKomgaLibraryScan,
  triggerKomgaMetadataRefresh,
  syncKomgaSeriesMetadataFromLocal
} = require('../../infra/komga/komga-api');

async function organizeLibraryFlow(deps) {
  const {
    prompt,
    ui
  } = deps;

  try {
    const cfg = loadConfig();
    const defaultMode = cfg.komgaOrganizeMode === 'copy' ? 'copy' : 'hardlink';
    const defaultGhost = cfg.komgaCreateGhostFolders === true;
    const defaultMeta = cfg.komgaCreateSeriesMetadata !== false;
    const defaultCover = cfg.komgaCreateSeriesCover !== false;

    const ans = await prompt([
      {
        type: 'list',
        name: 'mode',
        message: 'Modo de organização',
        choices: [
          { name: 'Hardlink (recomendado - economiza espaço)', value: 'hardlink' },
          { name: 'Copy (cria cópias independentes)', value: 'copy' }
        ],
        default: defaultMode
      },
      {
        type: 'confirm',
        name: 'createGhost',
        message: 'Criar pastas fantasma para séries sem arquivos?',
        default: defaultGhost
      },
      {
        type: 'confirm',
        name: 'createMetadata',
        message: 'Gerar series.json com metadados do AniList?',
        default: defaultMeta
      },
      {
        type: 'confirm',
        name: 'createCover',
        message: 'Gerar capas das séries?',
        default: defaultCover
      }
    ]);

    const options = {
      mode: ans.mode,
      createGhostFolders: ans.createGhost,
      createSeriesMetadata: ans.createMetadata,
      createSeriesCover: ans.createCover,
      forceSync: true
    };

    ui.NotificationManager.instance.info('Organizando biblioteca Komga...');
    const result = await ui.withSpinner('Varredura e organização em andamento', async () => {
      return await organizeDownloadsForKomga(options);
    });

    applyConfigValues({
      komgaOrganizeMode: ans.mode,
      komgaCreateGhostFolders: ans.createGhost,
      komgaCreateSeriesMetadata: ans.createMetadata,
      komgaCreateSeriesCover: ans.createCover
    });

    // Trigger Komga operations
    const operations = [];
    try {
      operations.push(triggerKomgaMetadataRefresh().then(res => ({ type: 'refresh', result: res })));
    } catch (e) { operations.push(Promise.resolve({ type: 'refresh', error: e })); }

    try {
      operations.push(syncKomgaSeriesMetadataFromLocal().then(res => ({ type: 'metadata', result: res })));
    } catch (e) { operations.push(Promise.resolve({ type: 'metadata', error: e })); }

    try {
      operations.push(triggerKomgaLibraryScan({ scanDeep: true, scanForceModifiedTime: true }).then(res => ({ type: 'scan', result: res })));
    } catch (e) { operations.push(Promise.resolve({ type: 'scan', error: e })); }

    const opResults = await Promise.all(operations);

    return {
      success: true,
      organizeResult: result,
      opResults
    };
  } catch (e) {
    return {
      success: false,
      error: e.message
    };
  }
}

async function startKomgaFlow(deps) {
  const {
    prompt,
    chooseJarPath,
    moveJarToManagedFolder,
    ui
  } = deps;

  try {
    ui.NotificationManager.instance.info('Verificando JAR do Komga...');
    let cfg = loadConfig();
    cfg = await ensureJarReady({
      cfg,
      kind: 'komga',
      prompt,
      chooseJarPath,
      moveJarToManagedFolder,
      applyConfigValues
    });

    const needsFirstKomgaLogin = !cfg.komgaUsername || !cfg.komgaPassword;

    ui.NotificationManager.instance.info('Organizando biblioteca antes de iniciar...');
    const organizeResult = await organizeDownloadsForKomga({
      mode: cfg.komgaOrganizeMode === 'copy' ? 'copy' : 'hardlink',
      createGhostFolders: cfg.komgaCreateGhostFolders === true,
      createSeriesMetadata: cfg.komgaCreateSeriesMetadata !== false,
      createSeriesCover: cfg.komgaCreateSeriesCover !== false,
      useDownloadsAsLibrary: cfg.komgaUseDownloadsAsLibrary !== false,
      forceSync: true
    });

    ui.NotificationManager.instance.info('Iniciando servidor Komga...');
    const result = await ui.withSpinner('Inicializando Komga', async () => {
      return await startKomga();
    });

    if (result.ready && needsFirstKomgaLogin) {
      const confirm = await prompt([
        {
          type: 'confirm',
          name: 'continue',
          message: 'Já concluiu o login/cadastro no Komga?',
          default: true
        }
      ]);

      if (confirm.continue) {
        const ans = await prompt([
          {
            name: 'username',
            message: 'Usuário do Komga',
            default: String(cfg.komgaUsername || '').trim()
          },
          {
            type: 'password',
            name: 'password',
            message: 'Senha do Komga',
            mask: '*',
            validate: (v) => String(v || '').trim().length ? true : 'Informe a senha'
          }
        ]);

        applyConfigValues({
          komgaUsername: String(ans.username || '').trim(),
          komgaPassword: String(ans.password || '').trim()
        });
      }
    }

    if (result.ready) {
      await runKomgaPostStartTasks(cfg, {
        ensureKomgaLibraryExists,
        triggerKomgaLibraryScan,
        triggerKomgaMetadataRefresh,
        syncKomgaSeriesMetadataFromLocal,
        logger: {
          info: (msg) => console.log(`  ${ui.colors.muted('ℹ')} ${msg}`),
          warn: (msg) => console.log(`  ${ui.colors.warning('⚠')} ${msg}`),
          error: (msg) => console.log(`  ${ui.colors.error('✗')} ${msg}`)
        }
      });
    } else {
      runKomgaPostStartWhenReady(cfg, {
        ensureKomgaLibraryExists,
        triggerKomgaLibraryScan,
        triggerKomgaMetadataRefresh,
        syncKomgaSeriesMetadataFromLocal,
        logger: {
          info: (msg) => console.log(`  ${ui.colors.muted('ℹ')} ${msg}`),
          warn: (msg) => console.log(`  ${ui.colors.warning('⚠')} ${msg}`),
          error: (msg) => console.log(`  ${ui.colors.error('✗')} ${msg}`)
        },
        tries: 24,
        intervalMs: 2500
      }).catch((e) => {
        ui.NotificationManager.instance.warning(`Auto-config pós-start falhou: ${e.message}`);
      });
    }

    return {
      success: true,
      komgaResult: result,
      organizeResult: organizeResult
    };
  } catch (e) {
    return {
      success: false,
      error: e.message
    };
  }
}

async function runKomgaPostStartTasks(cfg, tools) {
  const {
    ensureKomgaLibraryExists,
    triggerKomgaLibraryScan,
    triggerKomgaMetadataRefresh,
    syncKomgaSeriesMetadataFromLocal,
    logger
  } = tools;

  await ensureKomgaLibraryExists();
  await triggerKomgaMetadataRefresh();
  await syncKomgaSeriesMetadataFromLocal();
  await triggerKomgaLibraryScan({ scanDeep: true, scanForceModifiedTime: true });
}

async function runKomgaPostStartWhenReady(cfg, tools) {
  const {
    ensureKomgaLibraryExists,
    triggerKomgaLibraryScan,
    triggerKomgaMetadataRefresh,
    syncKomgaSeriesMetadataFromLocal,
    logger
  } = tools;

  let ready = false;
  let tries = 0;
  while (!ready && tries < (tools.tries || 24)) {
    try {
      await ensureKomgaLibraryExists();
      ready = true;
    } catch (e) {
      tries++;
      await new Promise(r => setTimeout(r, tools.intervalMs || 2500));
    }
  }

  if (ready) {
    await triggerKomgaMetadataRefresh();
    await syncKomgaSeriesMetadataFromLocal();
    await triggerKomgaLibraryScan({ scanDeep: true, scanForceModifiedTime: true });
  } else {
    throw new Error('Komga não ficou pronto a tempo');
  }
}

module.exports = { organizeLibraryFlow, startKomgaFlow };
