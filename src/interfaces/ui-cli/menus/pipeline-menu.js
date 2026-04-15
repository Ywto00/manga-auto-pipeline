const {
  loadConfig,
  applyConfigValues,
  moveJarToManagedFolder,
  startServer,
  startKomga,
  fetchUserList,
  enqueueFromList,
  deleteReadChaptersByAniList,
  getDownloadsOverview,
  organizeDownloadsForKomga,
  ensureKomgaLibraryExists,
  triggerKomgaLibraryScan,
  triggerKomgaMetadataRefresh,
  syncKomgaSeriesMetadataFromLocal,
  waitForDownloadsAndSyncKomga
} = require('../../../cli-logic-adapter');
const { ensurePrompt } = require('../input/prompt');
const { getLocalIPv4Candidates } = require('../system/network');
const { chooseJarPath } = require('../input/explorer-picker');
const { exec } = require('child_process');
const { resolveEnqueuePrefs } = require('../../../features/pipeline/application/resolve-enqueue-prefs');
const { describeError } = require('../../../features/pipeline/infra/error-utils');
const { startBackgroundEnqueueWorker } = require('../../../features/pipeline/infra/background-enqueue-worker');
const { ensureJarReady } = require('../../../features/pipeline/application/jar-management');
const { runEnqueueBackgroundTask } = require('../../../features/pipeline/application/enqueue-background-task');
const { runKomgaPostStartTasks, runKomgaPostStartWhenReady } = require('../../../features/pipeline/application/komga-post-start');
const ui = require('../feedback/ui-enhancements');

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function openInBrowser(url) {
  const target = String(url || '').trim();
  if (!target) return;
  if (process.platform === 'win32') {
    exec(`start "" "${target}"`);
    return;
  }
  if (process.platform === 'darwin') {
    exec(`open "${target}"`);
    return;
  }
  exec(`xdg-open "${target}"`);
}

async function startPipelineUI() {
  const prompt = ensurePrompt();
  ui.separator('🚀 Iniciar Pipeline Completo');

  try {
    ui.NotificationManager.instance.info('Verificando configuração...');
    let cfg = loadConfig();
    if (!cfg.usernameAnilist) {
      const ans = await prompt([{ name: 'user', message: ui.colors.primary('Usuário AniList') }]);
      if (!ans.user) {
        ui.NotificationManager.instance.warning('Usuário AniList não informado');
        return;
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

    const ips = getLocalIPv4Candidates();
    const api = new URL(suwayomi.apiUrl || 'http://localhost:4567');
    const cfgNow = loadConfig();
    const webUiEnabled = Boolean(cfgNow.suwayomiWebUIEnabled);

    console.log('');
    ui.separator('✅ Suwayomi Iniciado');
    console.log(`  ${ui.colors.primary('URL da API:')} ${suwayomi.apiUrl}`);
    console.log(`  ${ui.colors.muted('Bind IP:')} ${cfgNow.serverBindIp || '0.0.0.0'}`);
    console.log(`  ${ui.colors.muted('WebUI:')} ${webUiEnabled ? ui.colors.success('ativada') : ui.colors.error('desativada')}`);

    if (ips.length) {
      console.log(`  ${ui.colors.muted('IPs detectados:')} ${ips.join(', ')}`);
      console.log(ui.colors.muted('  URLs para conectar no celular (mesma rede):'));
      ips.slice(0, 4).forEach((ip, i) => {
        console.log(`    ${i + 1}. ${api.protocol}//${ip}:${api.port}`);
      });
      if (webUiEnabled) {
        console.log(`  ${ui.colors.success('WebUI URL sugerida:')}`);
        console.log(`    ${api.protocol}//${ips[0]}:${api.port}`);
      }
    } else {
      console.log(`  ${ui.colors.warning('IPs não detectados automaticamente')} - execute 'ipconfig' no Windows`);
    }

    if (webUiEnabled && cfgNow.suwayomiOpenWebUIOnStart === true) {
      const targetUrl = `${api.protocol}//localhost:${api.port}`;
      try {
        openInBrowser(targetUrl);
        console.log(`  ${ui.colors.info('Abrindo WebUI no navegador:')} ${targetUrl}`);
      } catch (e) {
        console.log(`  ${ui.colors.warning('Não foi possível abrir navegador automaticamente:')} ${e.message}`);
      }
    }

    const currentCfg = loadConfig();
    const workerStart = startBackgroundEnqueueWorker();
    if (workerStart.ok) {
      ui.NotificationManager.instance.success(`Worker background iniciado (pid=${workerStart.pid})`);
      console.log(`  Processo separado para enqueue rodando em outro console`);
    } else {
      ui.NotificationManager.instance.warning(`Usando enqueue local (${workerStart.reason})`);
      setTimeout(() => {
        runEnqueueBackgroundTask(currentCfg, {
          fetchUserList,
          enqueueFromList,
          resolveEnqueuePrefs,
          logger: console
        }).catch((e) => {
          console.error(`[ENQUEUE] Falha: ${describeError(e)}`);
          if (e && e.report) {
            console.error(`  Diagnóstico: tentativas=${Number(e.report.attemptsTotal || 0)}, trocasFonte=${Number(e.report.sourceSwitches || 0)}`);
            if (Array.isArray(e.report.warnings) && e.report.warnings.length) {
              e.report.warnings.slice(0, 5).forEach((w, i) => {
                console.error(`  [WARN ${i + 1}] ${w}`);
              });
            }
          }
        });
      }, 300);
    }

    // Print config summary
    console.log('');
    ui.separator('📋 Configuração Atual');
    const anilistStatus = currentCfg.usernameAnilist
      ? `${ui.colors.success(currentCfg.usernameAnilist)}`
      : `${ui.colors.error('não configurado')}`;
    console.log(`  ${ui.colors.primary('AniList:')}     ${anilistStatus}`);
    console.log(`  ${ui.colors.primary('Caps ahead:')}  ${Number(currentCfg.capsAhead) || 5}`);
    console.log(`  ${ui.colors.primary('Max fontes:')}  ${Number(currentCfg.maxSourcesToTryForSearch || 10)}`);
    const fixedSource = currentCfg.fixedSourceId
      ? `${ui.colors.info(currentCfg.fixedSourceId)}`
      : `${ui.colors.muted('(desativada)')}`;
    console.log(`  ${ui.colors.primary('Fonte fixa:')}  ${fixedSource}`);
    const matchRigid = currentCfg.strictTitleMatch === false
      ? `${ui.colors.warning('não')} (minScore=${Number(currentCfg.strictMinScore || 88)})`
      : `${ui.colors.success('sim')} (minScore=${Number(currentCfg.strictMinScore || 88)})`;
    console.log(`  ${ui.colors.primary('Match rígido:')}  ${matchRigid}`);
    console.log('');
    ui.NotificationManager.instance.success('Pipeline inicializado! Retornando ao menu principal.');

    // Automatic sync with Komga if enabled
    if (currentCfg.komgaSyncOnStart !== false) {
      console.log(ui.colors.info('[KOMGA] Auto-sync habilitado - aguardando downloads finalizarem...'));
      waitForDownloadsAndSyncKomga({ scanForceModifiedTime: true })
        .then((result) => {
          console.log(ui.colors.success('[KOMGA] Downloads finalizados! Organização e scan executados.'));
          if (result && result.scanResult) {
            console.log(`  Scan: modo=${result.scanResult.strategy}, jobs=${result.scanResult.triggered}`);
          }
          if (result && result.organizeResult) {
            console.log(`  Organização: ${result.organizeResult.linked} links, ${result.organizeResult.copied} copiados`);
          }
        })
        .catch((e) => {
          ui.NotificationManager.instance.warning(`Auto-sync pós-download falhou: ${e.message}`);
        });
    }

  } catch (e) {
    ui.NotificationManager.instance.error(`Falha ao iniciar pipeline: ${e.message}`);
  }
}

async function cleanupReadByAniListUI() {
  const prompt = ensurePrompt();
  ui.separator('🧹 Limpeza de Capítulos Lidos (AniList)');

  try {
    const ans = await prompt([
      {
        type: 'confirm',
        name: 'dry',
        message: 'Executar em dry-run (apenas mostrar, sem apagar)?',
        default: true
      },
      {
        name: 'limit',
        message: 'Quantidade máxima de mangás para processar',
        default: 200,
        validate: (v) => {
          const n = Number(v);
          return Number.isFinite(n) && n >= 1 ? true : 'Digite um número >= 1';
        }
      }
    ]);

    const dry = Boolean(ans.dry);
    const limit = Number(ans.limit) || 200;

    console.log('');
    ui.NotificationManager.instance.info(`Varredura de capítulos lidos (dry-run: ${dry ? 'sim' : 'não'}, limite: ${limit})`);

    let processed = 0, deletedTotal = 0, failedTotal = 0, skipped = 0;
    const startTime = Date.now();

    const result = await deleteReadChaptersByAniList({
      dry,
      limit,
      onItem: (row) => {
        processed += 1;
        if (row.skipped) {
          skipped += 1;
          if (processed <= 50) console.log(`  ${ui.colors.muted('SKIP')} ${row.item.title} (${row.reason})`);
          return;
        }
        if (row.ok === false) {
          failedTotal += 1;
          if (processed <= 50) console.log(`  ${ui.colors.error('FAIL')} ${row.item.title}: ${row.error}`);
          return;
        }
        deletedTotal += (row.deleted || 0);
        if (processed <= 50) {
          console.log(`  ${ui.colors.success('OK')} ${row.item.title}: ${row.candidates} capítulos candidatos, ${row.deleted} apagados${row.dry ? ' [DRY]' : ''}`);
        }
      }
    });

    const elapsed = (Date.now() - startTime) / 1000;
    ui.separator('Resultado da Limpeza');
    console.log(`  Tempo: ${elapsed.toFixed(1)}s`);
    console.log(`  Processados: ${ui.colors.info(processed)} itens`);
    console.log(`  Apagados: ${ui.colors.success(deletedTotal)} capítulos`);
    console.log(`  Falhas: ${ui.colors.error(failedTotal)} itens`);
    console.log(`  Ignorados: ${ui.colors.muted(skipped)} itens`);

    ui.NotificationManager.instance.success(`Limpeza concluída: ${deletedTotal} capítulos apagados de ${processed} mangás verificados`);

  } catch (e) {
    ui.NotificationManager.instance.error(`Falha na limpeza: ${e.message}`);
  }
}

async function downloadsStatusUI() {
  const prompt = ensurePrompt();
  const dashboard = new (require('../feedback/ui-enhancements')).LiveDashboard();
  dashboard.section('Downloads', () => {
    try {
      const status = getDownloadsOverview();
      return `${status.queueSize} na fila | ${(status.active || []).length} ativos`;
    } catch (e) {
      return '--';
    }
  });

  try {
    const mode = await prompt([
      {
        type: 'confirm',
        name: 'dynamic',
        message: 'Monitorar dinamicamente (atualiza em tempo real)?',
        default: true
      },
      {
        name: 'intervalSec',
        message: 'Intervalo de atualizacao (segundos)',
        default: 2,
        when: (a) => a.dynamic,
        validate: (v) => {
          const n = Number(v);
          return Number.isFinite(n) && n >= 1 && n <= 30 ? true : 'Digite um numero entre 1 e 30';
        }
      },
      {
        name: 'cycles',
        message: 'Quantidade maxima de ciclos (0 = sem limite)',
        default: 0,
        when: (a) => a.dynamic,
        validate: (v) => {
          const n = Number(v);
          return Number.isFinite(n) && n >= 0 ? true : 'Digite um numero >= 0';
        }
      }
    ]);

    const dynamic = Boolean(mode.dynamic);
    const intervalMs = Math.max(1000, Number(mode.intervalSec || 2) * 1000);
    const cyclesMax = Math.max(0, Number(mode.cycles || 0));
    let cycle = 0;

    if (dynamic) {
      console.log('');
      console.log('Pressione Ctrl+C para sair do monitoramento');
      dashboard.start(intervalMs);
    }

    while (true) {
      const status = await getDownloadsOverview();

      if (dynamic) {
        // Dashboard updates automatically
      } else {
        console.clear && console.clear();
        console.log(`[DOWNLOADS] Status: ${status.status} | Queue: ${status.queueSize}`);
      }

      if (Array.isArray(status.active) && status.active.length) {
        const activeSorted = [...status.active].sort((a, b) => {
          const ap = Number.isFinite(Number(a.percent)) ? Number(a.percent) : -1;
          const bp = Number.isFinite(Number(b.percent)) ? Number(b.percent) : -1;
          if (ap !== bp) return bp - ap;
          return String(a.title || '').localeCompare(String(b.title || ''));
        });

        if (!dynamic) console.log('[DOWNLOADS] Mangas em download (ordenado por progresso):');
        activeSorted.slice(0, 50).forEach((m, i) => {
          const p = Number.isFinite(Number(m.percent)) ? null : Number(m.percent);
          const pct = p == null ? ' --%' : `${String(Math.round(p)).padStart(3, ' ')}%`;
          const bars = p == null
            ? '..........'
            : `${'█'.repeat(Math.max(0, Math.min(10, Math.round(p / 10))))}${'░'.repeat(10 - Math.max(0, Math.min(10, Math.round(p / 10))))}`;

          if (dynamic) {
            // Show only progress bar in compact mode
            process.stdout.write(`\r${String(i + 1).padStart(2, '0')}. ${bars} ${pct} | ${m.title.substring(0, 50)}`);
          } else {
            console.log(`${String(i + 1).padStart(2, '0')}. [${bars}] ${pct} | fila=${m.chaptersInQueue} | ${m.title}`);
          }

          const diag = m.diag || null;
          if (diag && !dynamic) {
            console.log(`    - tentativas=${Number(diag.attemptsTotal || 0)} | trocasFonte=${Number(diag.sourceSwitches || 0)} | fonteAtual=${diag.sourceName || 'auto'}`);
            const firstWarning = Array.isArray(diag.warnings) && diag.warnings.length ? diag.warnings[0] : '';
            if (firstWarning) {
              console.log(`    - aviso: ${firstWarning}`);
            }
          }
        });
      } else {
        if (!dynamic) console.log('[DOWNLOADS] Sem itens ativos na fila no momento.');
      }

      if (Array.isArray(status.failedRecent) && status.failedRecent.length) {
        if (dynamic) {
          console.log(`\n[Falhas recentes: ${status.failedRecent.length}]`);
        } else {
          console.log('[DOWNLOADS] Falhas recentes de enqueue:');
          status.failedRecent.slice(0, 10).forEach((f, i) => {
            const meta = f.enqueueMeta || {};
            console.log(`  ${i + 1}. ${f.title} -> ${f.error}`);
            console.log(`     tentativas=${Number(meta.attemptsTotal || 0)} | trocasFonte=${Number(meta.sourceSwitches || 0)}`);
          });
        }
      }

      console.log(`\n[CONFIG] AniList: ${status.config.usernameAnilist || '(nao definido)'} | Caps: ${status.config.capsAhead} | Downloads: ${status.config.downloadsPath}`);

      if (!dynamic) {
        await new Promise(resolve => setTimeout(resolve, intervalMs));
        console.clear && console.clear();
      } else {
        await new Promise(resolve => setTimeout(resolve, intervalMs));
      }

      if (!dynamic) cycle += 1;
      if (status.queueSize <= 0 && dynamic) {
        console.log('\n[DOWNLOADS] Fila vazia. Encerrando monitor dinamico.');
        break;
      }
      if (cyclesMax > 0 && cycle >= cyclesMax) {
        console.log('[DOWNLOADS] Limite de ciclos atingido. Encerrando monitor dinamico.');
        break;
      }
    }

    dashboard.stop();
  } catch (e) {
    dashboard.stop();
    console.error('Falha ao ler status de downloads:', e.message);
  }
}

async function organizeKomgaLibraryUI() {
  const prompt = ensurePrompt();
  const cfg = loadConfig();
  const defaultMode = cfg.komgaOrganizeMode === 'copy' ? 'copy' : 'hardlink';
  const defaultGhost = cfg.komgaCreateGhostFolders === true;
  const defaultMeta = cfg.komgaCreateSeriesMetadata !== false;
  const defaultCover = cfg.komgaCreateSeriesCover !== false;

  ui.separator('📚 Organizar Biblioteca Komga');

  try {
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

    // Save preferences
    applyConfigValues({
      komgaOrganizeMode: ans.mode,
      komgaCreateGhostFolders: ans.createGhost,
      komgaCreateSeriesMetadata: ans.createMetadata,
      komgaCreateSeriesCover: ans.createCover
    });

    ui.separator('✅ Organização Concluída');
    console.log(`  Biblioteca: ${result.libraryRoot}`);
    console.log(`  Modo: ${result.mode}`);
    console.log(`  CBZ encontrados: ${result.foundCbz}`);
    console.log(`  Links: ${ui.colors.success(result.linked)} | Copiados: ${result.copied} | Ignorados: ${result.skipped}`);
    console.log(`  Séries: ${result.seriesCount} | Pastas fantasma: ${result.ghostFolders}`);
    console.log(`  series.json: ${result.metadataCreated} gerados`);
    console.log(`  Capas: ${result.coverCreated} geradas`);

    if (result.skippedByRecentSync) {
      console.log(`\n${ui.colors.warning('⚠️  AVISO')}: Organização ignorada - última sincronização foi hoje (${result.lastSyncAt || 'agora'}).`);
      console.log('  Para sincronizar novamente no mesmo dia, ajuste manualmente lastKomgaLibrarySyncAt no config.');
      return;
    }

    // Trigger Komga operations (lightweight first, heavy scan last)
    console.log('\n🔄 Atualizando Komga...');

    try {
      const refresh = await triggerKomgaMetadataRefresh();
      console.log(`  ${ui.colors.success('✓')} Refresh metadata: ${refresh.strategy} (${refresh.triggered} jobs)`);
    } catch (e) {
      console.log(`  ${ui.colors.error('✗')} Refresh falhou: ${e.message}`);
    }

    try {
      const patched = await syncKomgaSeriesMetadataFromLocal();
      console.log(`  ${ui.colors.success('✓')} Metadata API: ${patched.patched}/${patched.attempted} atualizadas, ${patched.skipped} sem match, ${patched.failed} falhas`);
    } catch (e) {
      console.log(`  ${ui.colors.error('✗')} Metadata API falhou: ${e.message}`);
    }

    try {
      const deepScan = await triggerKomgaLibraryScan({ scanDeep: true, scanForceModifiedTime: true });
      console.log(`  ${ui.colors.success('✓')} Scan profundo: ${deepScan.strategy} (${deepScan.triggered} jobs)`);
    } catch (e) {
      console.log(`  ${ui.colors.error('✗')} Scan falhou: ${e.message}`);
    }

    ui.NotificationManager.instance.success('Organização Komga completa!');

  } catch (e) {
    ui.NotificationManager.instance.error(`Falha ao organizar Komga: ${e.message}`);
  }
}

async function startKomgaUI() {
  const prompt = ensurePrompt();
  ui.separator('📺 Iniciar Komga Media Server');

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

    // Pre-start organization
    console.log('');
    ui.NotificationManager.instance.info('Organizando biblioteca antes de iniciar...');
    const organizeResult = await organizeDownloadsForKomga({
      mode: cfg.komgaOrganizeMode === 'copy' ? 'copy' : 'hardlink',
      createGhostFolders: cfg.komgaCreateGhostFolders === true,
      createSeriesMetadata: cfg.komgaCreateSeriesMetadata !== false,
      createSeriesCover: cfg.komgaCreateSeriesCover !== false,
      useDownloadsAsLibrary: cfg.komgaUseDownloadsAsLibrary !== false,
      forceSync: true
    });

    if (!organizeResult.skippedByRecentSync) {
      console.log(`  ${ui.colors.success('✓')} Organização concluída em: ${organizeResult.libraryRoot}`);
      console.log(`    Links: ${organizeResult.linked} | Copiados: ${organizeResult.copied} | Ignorados: ${organizeResult.skipped}`);
    } else {
      console.log(`  ${ui.colors.warning('⚠')} Organização ignorada (sync recente: ${organizeResult.lastSyncAt || 'hoje'})`);
    }

    // Start Komga
    ui.NotificationManager.instance.info('Iniciando servidor Komga...');
    const result = await ui.withSpinner('Inicializando Komga', async () => {
      return await startKomga();
    });

    if (result.ready) {
      console.log(`\n${ui.colors.success('✅ Komga está pronto!')}`);
      console.log(`  ${ui.colors.primary('URL:')} ${result.komgaUrl}`);
    } else {
      console.log(`\n${ui.colors.warning('⏳ Komga iniciado em background')}`);
      console.log(`  ${ui.colors.primary('URL:')} ${result.komgaUrl}`);
      console.log(`  PID: ${result.pid}`);
    }
    console.log(`  ${ui.colors.muted('JAR:')} ${result.cfg.komgaJarPath}`);

    // First login handling
    if (result.ready && needsFirstKomgaLogin) {
      console.log(`\n${ui.colors.warning('🔐 Primeiro acesso detectado')}`);
      console.log(`  ${ui.colors.muted('Se ainda não criou usuário/senha, abra o link acima e crie agora.')}`);
      console.log(`  Link: ${result.komgaUrl}\n`);

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

        cfg = applyConfigValues({
          komgaUsername: String(ans.username || '').trim(),
          komgaPassword: String(ans.password || '').trim()
        });
        ui.NotificationManager.instance.success('Credenciais salvas');
      }
    }

    // Post-start tasks
    if (result.ready) {
      console.log('\n🔄 Executando tarefas pós-inicialização...');
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
      ui.NotificationManager.instance.success('Komga configurado e sincronizado!');
    } else {
      console.log('\n⏳ Aguardando background ficar pronto...');
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
      ui.NotificationManager.instance.success('Komga em background; config automática iniciada');
    }

  } catch (e) {
    ui.NotificationManager.instance.error(`Falha ao iniciar Komga: ${e.message}`);
  }
}

module.exports = {
  startPipelineUI,
  cleanupReadByAniListUI,
  downloadsStatusUI,
  organizeKomgaLibraryUI,
  startKomgaUI
};