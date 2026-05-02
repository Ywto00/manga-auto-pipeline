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
const { initializePipeline } = require('../../../services/pipeline/pipeline-orchestrator');
const { organizeLibraryFlow, startKomgaFlow } = require('../../../services/pipeline/komga-orchestrator');
const { cleanupReadChaptersFlow } = require('../../../services/pipeline/cleanup-orchestrator');
const { ensurePrompt } = require('../input/prompt');
const { getLocalIPv4Candidates } = require('../system/network');
const { chooseJarPath } = require('../input/explorer-picker');
const { exec } = require('child_process');
const { resolveEnqueuePrefs } = require('../../../lib/config-utils');
const { openInBrowser } = require('../../../lib/ui-helpers');
const { describeError } = require('../../../lib/errors');
const { startBackgroundEnqueueWorker } = require('../../../infra/pipeline/background-enqueue-worker');
const { ensureJarReady } = require('../../../services/pipeline/jar-management');
const { runEnqueueBackgroundTask } = require('../../../services/pipeline/enqueue-background-task');
const { runKomgaPostStartTasks, runKomgaPostStartWhenReady } = require('../../../services/pipeline/komga-post-start');
const ui = require('../feedback/ui-enhancements');

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
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
        openInBrowser(targetUrl, exec);
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

  const result = await cleanupReadChaptersFlow({
    prompt,
    ui
  });

  if (!result.success) {
    ui.NotificationManager.instance.error(`Falha na limpeza: ${result.error}`);
    return;
  }

  const { elapsed, processed, deletedTotal, failedTotal, skipped } = result;

  ui.separator('Resultado da Limpeza');
  console.log(`  Tempo: ${elapsed.toFixed(1)}s`);
  console.log(`  Processados: ${ui.colors.info(processed)} itens`);
  console.log(`  Apagados: ${ui.colors.success(deletedTotal)} capítulos`);
  console.log(`  Falhas: ${ui.colors.error(failedTotal)} itens`);
  console.log(`  Ignorados: ${ui.colors.muted(skipped)} itens`);

  ui.NotificationManager.instance.success(`Limpeza concluída: ${deletedTotal} capítulos apagados de ${processed} mangás verificados`);
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
  ui.separator('📚 Organizar Biblioteca Komga');

  const result = await organizeLibraryFlow({
    prompt,
    ui
  });

  if (!result.success) {
    ui.NotificationManager.instance.error(`Falha ao organizar Komga: ${result.error}`);
    return;
  }

  const { organizeResult, opResults } = result;

  ui.separator('✅ Organização Concluída');
  console.log(`  Biblioteca: ${organizeResult.libraryRoot}`);
  console.log(`  Modo: ${organizeResult.mode}`);
  console.log(`  CBZ encontrados: ${organizeResult.foundCbz}`);
  console.log(`  Links: ${ui.colors.success(organizeResult.linked)} | Copiados: ${organizeResult.copied} | Ignorados: ${organizeResult.skipped}`);
  console.log(`  Séries: ${organizeResult.seriesCount} | Pastas fantasma: ${organizeResult.ghostFolders}`);
  console.log(`  series.json: ${organizeResult.metadataCreated} gerados`);
  console.log(`  Capas: ${organizeResult.coverCreated} geradas`);

  if (organizeResult.skippedByRecentSync) {
    console.log(`\n${ui.colors.warning('⚠️  AVISO')}: Organização ignorada - última sincronização foi hoje (${organizeResult.lastSyncAt || 'agora'}).`);
    console.log('  Para sincronizar novamente no mesmo dia, ajuste manualmente lastKomgaLibrarySyncAt no config.');
    return;
  }

  console.log('\n🔄 Atualizando Komga...');
  opResults.forEach(op => {
    if (op.error) {
      console.log(`  ${ui.colors.error('✗')} ${op.type}: ${op.error}`);
    } else {
      const res = op.result;
      if (op.type === 'refresh') {
        console.log(`  ${ui.colors.success('✓')} Refresh metadata: ${res.strategy} (${res.triggered} jobs)`);
      } else if (op.type === 'metadata') {
        console.log(`  ${ui.colors.success('✓')} Metadata API: ${res.patched}/${res.attempted} atualizadas, ${res.skipped} sem match, ${res.failed} falhas`);
      } else if (op.type === 'scan') {
        console.log(`  ${ui.colors.success('✓')} Scan profundo: ${res.strategy} (${res.triggered} jobs)`);
      }
    }
  });

  ui.NotificationManager.instance.success('Organização Komga completa!');
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