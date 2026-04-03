const fs = require('fs');
const os = require('os');
const path = require('path');

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
} = require('../../cli-logic');
const { ensurePrompt } = require('../../interfaces/ui-cli/prompt');
const { getLocalIPv4Candidates } = require('../../interfaces/ui-cli/network');
const { chooseJarPath } = require('../../interfaces/ui-cli/explorer-picker');
const { resolveEnqueuePrefs } = require('./enqueue-prefs');

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function findJarInBin(dataDir, matcher) {
  const binDir = path.join(dataDir || '', 'bin');
  if (!binDir || !fs.existsSync(binDir)) return '';
  try {
    const entries = fs.readdirSync(binDir, { withFileTypes: true });
    const jars = entries
      .filter(e => e.isFile() && /\.jar$/i.test(e.name))
      .map(e => e.name)
      .filter(name => matcher.test(name))
      .sort();
    if (!jars.length) return '';
    return path.join(binDir, jars[0]);
  } catch (e) {
    return '';
  }
}

async function ensureKomgaJarReady(prompt, cfg) {
  const downloadsDir = path.join(os.homedir(), 'Downloads');
  let komgaJar = cfg.komgaJarPath || '';

  if (!komgaJar || !fs.existsSync(komgaJar)) {
    komgaJar = findJarInBin(cfg.dataDir, /komga/i);
  }

  if (!komgaJar) {
    komgaJar = await chooseJarPath(prompt, 'Komga', /komga/i, cfg.komgaJarPath || '', downloadsDir);
  }

  if (!komgaJar) {
    throw new Error('Komga JAR not provided. Please configure a valid path.');
  }

  const managedJarDir = path.join(cfg.dataDir, 'bin');
  const moved = moveJarToManagedFolder(komgaJar, managedJarDir, true);
  return applyConfigValues({ komgaJarPath: moved });
}

async function ensureSuwayomiJarReady(prompt, cfg) {
  const downloadsDir = path.join(os.homedir(), 'Downloads');
  let suwayomiJar = cfg.jarPath || '';

  if (!suwayomiJar || !fs.existsSync(suwayomiJar)) {
    suwayomiJar = findJarInBin(cfg.dataDir, /suwayomi/i);
  }

  if (!suwayomiJar) {
    suwayomiJar = await chooseJarPath(prompt, 'Suwayomi', /suwayomi/i, cfg.jarPath || '', downloadsDir);
  }

  if (!suwayomiJar) {
    throw new Error('Suwayomi JAR not provided. Please configure a valid path.');
  }

  const managedJarDir = path.join(cfg.dataDir, 'bin');
  const moved = moveJarToManagedFolder(suwayomiJar, managedJarDir, true);
  return applyConfigValues({ jarPath: moved });
}

async function startPipelineUI() {
  const prompt = ensurePrompt();
  let cfg = loadConfig();
  if (!cfg.usernameAnilist) {
    const ans = await prompt([{ name: 'user', message: 'Usuario AniList', default: '' }]);
    if (!ans.user) {
      console.log('Usuario AniList nao informado.');
      return;
    }
    cfg = applyConfigValues({ usernameAnilist: ans.user });
  }

  cfg = await ensureSuwayomiJarReady(prompt, cfg);

  try {
    const suwayomi = await startServer();
    console.log(suwayomi.ready
      ? `[START] Suwayomi pronto em ${suwayomi.apiUrl}`
      : '[START] Suwayomi iniciado em background.');

    const ips = getLocalIPv4Candidates();
    const api = new URL(suwayomi.apiUrl || 'http://localhost:4567');
    const cfgNow = loadConfig();
    const webUiEnabled = Boolean(cfgNow.suwayomiWebUIEnabled);
    console.log(`[START] Bind IP: ${cfgNow.serverBindIp || '0.0.0.0'}`);
    console.log(`[START] WebUI Suwayomi: ${webUiEnabled ? 'ativada' : 'desativada'}`);
    if (ips.length) {
      console.log(`[START] IP(s) do PC: ${ips.join(', ')}`);
      console.log('[START] URLs para conectar no celular (mesma rede):');
      ips.slice(0, 4).forEach((ip, i) => {
        console.log(`  ${i + 1}. ${api.protocol}//${ip}:${api.port}`);
      });
      if (webUiEnabled) {
        console.log('[START] URL WebUI sugerida:');
        console.log(`  ${api.protocol}//${ips[0]}:${api.port}`);
      }
    } else {
      console.log('[START] Nao foi possivel detectar IP automaticamente. Use ipconfig no Windows.');
    }
  } catch (e) {
    console.error('[START] Falha ao iniciar Suwayomi:', e.message);
    return;
  }

  const currentCfg = loadConfig();
  const username = currentCfg.usernameAnilist;

  console.log(`[LIST] Buscando lista AniList de ${username}...`);
  try {
    const { mapped, readingLike } = await fetchUserList('anilist', username);
    console.log(`[LIST] Total=${mapped.length}, em leitura/pausado=${readingLike.length}`);
  } catch (e) {
    console.error('[LIST] Falha ao buscar AniList:', e.message);
    return;
  }

  const prefs = resolveEnqueuePrefs(currentCfg);
  console.log('[ENQUEUE] Iniciando enqueue com base no progresso do AniList...');
  try {
    const { output, stats, notFound } = await enqueueFromList({
      dry: false,
      priority: prefs.priority,
      allowedLangs: prefs.allowedLangs,
      sourceOrderIds: prefs.sourceOrderIds,
      limit: 200,
      onItem: (row) => {
        if (row.skipped) {
          const why = row.reason || 'already-processed';
          console.log(`[SKIP] ${row.item.title} (${why})`);
          return;
        }

        if (row.ok) {
          const r = row.result;
          console.log(`[RUN] ${row.item.title} => ${r.source.name} / ${r.manga.title} / indexes=${r.queuedChapterIndexes.join(',')}`);
        } else {
          console.log(`[FAIL] ${row.item.title}: ${row.error}`);
        }
      }
    });

    const ok = output.filter(x => x.ok).length;
    const failed = output.filter(x => x.ok === false).length;
    console.log(`[ENQUEUE] Summary: success=${ok}, failed=${failed}`);
    if (stats) {
      console.log(`[ENQUEUE] Stats: eligible=${stats.eligibleCount}, alreadyProcessed=${stats.skippedAlreadyProcessed}, processingNow=${stats.processedCount}`);
    }

    if (Array.isArray(notFound) && notFound.length) {
      console.log('[ENQUEUE] Nao encontrados com sugestoes:');
      notFound.slice(0, 20).forEach((nf, i) => {
        console.log(`${i + 1}. ${nf.title}`);
        const suggestions = nf.details && Array.isArray(nf.details.suggestionsBySource)
          ? nf.details.suggestionsBySource
          : [];
        suggestions.forEach(s => {
          const titles = (s.titles || []).slice(0, 5).join(' | ');
          console.log(`   ${s.sourceName} [${s.lang}] -> ${titles}`);
        });
      });
    }
  } catch (e) {
    console.error('[ENQUEUE] Falha:', e.message);
  }

  console.log(`[CONFIG] AniList user: ${currentCfg.usernameAnilist || '(nao definido)'}`);
  console.log(`[CONFIG] Caps a frente: ${Number(currentCfg.capsAhead) || 5}`);
  console.log(`[CONFIG] Max fontes por pesquisa: ${Number(currentCfg.maxSourcesToTryForSearch || 10)}`);
  console.log(`[CONFIG] Fonte fixa: ${currentCfg.fixedSourceId || '(desativada)'}`);
  console.log(`[CONFIG] Match rigido: ${currentCfg.strictTitleMatch === false ? 'nao' : 'sim'} (minScore=${Number(currentCfg.strictMinScore || 88)})`);
  console.log('[START] Enqueue finalizado. Retornando ao menu principal sem aguardar downloads.');

  if (currentCfg.komgaSyncOnStart !== false) {
    waitForDownloadsAndSyncKomga({ scanForceModifiedTime: true })
      .then((result) => {
        console.log('[KOMGA] Downloads finalizados. Organizacao e varrimento profundo executados automaticamente.');
        if (result && result.scanResult) {
          console.log(`[KOMGA] Scan profundo: modo=${result.scanResult.strategy}, jobs=${result.scanResult.triggered}.`);
        }
      })
      .catch((e) => {
        console.log(`[KOMGA] Auto-sync pos-download falhou: ${e.message}`);
      });
  }
}

async function cleanupReadByAniListUI() {
  const prompt = ensurePrompt();
  try {
    const ans = await prompt([
      {
        type: 'confirm',
        name: 'dry',
        message: 'Executar em dry-run (so mostrar, sem apagar)?',
        default: true
      },
      {
        name: 'limit',
        message: 'Quantidade max de mangas para processar',
        default: 200,
        validate: (v) => {
          const n = Number(v);
          return Number.isFinite(n) && n >= 1 ? true : 'Digite um numero >= 1';
        }
      }
    ]);

    console.log('[CLEANUP] Apagando capitulos baixados ja lidos conforme progresso AniList...');
    const result = await deleteReadChaptersByAniList({
      dry: Boolean(ans.dry),
      limit: Number(ans.limit) || 200,
      onItem: (row) => {
        if (row.skipped) {
          console.log(`[SKIP] ${row.item.title} (${row.reason})`);
          return;
        }
        if (row.ok === false) {
          console.log(`[FAIL] ${row.item.title}: ${row.error}`);
          return;
        }
        console.log(`[DONE] ${row.item.title}: candidatos=${row.candidates}, apagados=${row.deleted}, falhas=${row.failed}${row.dry ? ' [DRY]' : ''}`);
      }
    });

    console.log(`[CLEANUP] Finalizado. Itens processados: ${result.count}`);
  } catch (e) {
    console.error('Falha no cleanup AniList:', e.message);
  }
}

async function downloadsStatusUI() {
  const prompt = ensurePrompt();
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

    while (true) {
      const status = await getDownloadsOverview();
      if (dynamic) process.stdout.write('\x1Bc');

      console.log(`[DOWNLOADS] Status: ${status.status} | Queue: ${status.queueSize}`);

      if (Array.isArray(status.active) && status.active.length) {
        const activeSorted = [...status.active].sort((a, b) => {
          const ap = Number.isFinite(Number(a.percent)) ? Number(a.percent) : -1;
          const bp = Number.isFinite(Number(b.percent)) ? Number(b.percent) : -1;
          if (ap !== bp) return bp - ap;
          return String(a.title || '').localeCompare(String(b.title || ''));
        });

        console.log('[DOWNLOADS] Mangas em download (ordenado por progresso):');
        activeSorted.slice(0, 50).forEach((m, i) => {
          const p = Number.isFinite(Number(m.percent)) ? Number(m.percent) : null;
          const pct = p == null ? ' --%' : `${String(p).padStart(3, ' ')}%`;
          const bars = p == null
            ? '..........'
            : `${'#'.repeat(Math.max(0, Math.min(10, Math.round(p / 10))))}${'.'.repeat(10 - Math.max(0, Math.min(10, Math.round(p / 10))))}`;
          console.log(`${String(i + 1).padStart(2, '0')}. [${bars}] ${pct} | fila=${m.chaptersInQueue} | ${m.title}`);

          const diag = m.diag || null;
          if (diag) {
            console.log(`    - tentativas=${Number(diag.attemptsTotal || 0)} | trocasFonte=${Number(diag.sourceSwitches || 0)} | fonteAtual=${diag.sourceName || 'auto'}`);
            const firstWarning = Array.isArray(diag.warnings) && diag.warnings.length ? diag.warnings[0] : '';
            if (firstWarning) {
              console.log(`    - aviso: ${firstWarning}`);
            }
            const badSources = Array.isArray(diag.sourceAttempts)
              ? diag.sourceAttempts.filter(s => Number(s.failedAttempts || 0) > 0).slice(0, 2)
              : [];
            badSources.forEach(s => {
              console.log(`    - fail ${s.sourceName || s.sourceId || 'source'}: ${Number(s.failedAttempts || 0)} tentativa(s)${s.lastError ? ` | ultimoErro=${s.lastError}` : ''}`);
            });
          }
        });
      } else {
        console.log('[DOWNLOADS] Sem itens ativos na fila no momento.');
      }

      if (Array.isArray(status.failedRecent) && status.failedRecent.length) {
        console.log('[DOWNLOADS] Falhas recentes de enqueue:');
        status.failedRecent.slice(0, 10).forEach((f, i) => {
          const meta = f.enqueueMeta || {};
          console.log(`  ${i + 1}. ${f.title} -> ${f.error}`);
          console.log(`     tentativas=${Number(meta.attemptsTotal || 0)} | trocasFonte=${Number(meta.sourceSwitches || 0)}`);
        });
      }

      if (Array.isArray(status.files) && status.files.length) {
        const filesSorted = [...status.files].sort((a, b) => String(a).localeCompare(String(b)));
        console.log('[DOWNLOADS] Itens na pasta de downloads (ordenado):');
        filesSorted.slice(0, 20).forEach((name, i) => console.log(`${String(i + 1).padStart(2, '0')}. ${name}`));
      } else {
        console.log('[DOWNLOADS] Nenhum arquivo/pasta encontrado na pasta de downloads.');
      }

      console.log(`[CONFIG] AniList user: ${status.config.usernameAnilist || '(nao definido)'}`);
      console.log(`[CONFIG] Caps a frente: ${status.config.capsAhead}`);
      console.log(`[CONFIG] Downloads path: ${status.config.downloadsPath || '(nao definido)'}`);

      if (!dynamic) break;
      cycle += 1;
      if (status.queueSize <= 0) {
        console.log('[DOWNLOADS] Fila vazia. Encerrando monitor dinamico.');
        break;
      }
      if (cyclesMax > 0 && cycle >= cyclesMax) {
        console.log('[DOWNLOADS] Limite de ciclos atingido. Encerrando monitor dinamico.');
        break;
      }
      await sleep(intervalMs);
    }
  } catch (e) {
    console.error('Falha ao ler status de downloads:', e.message);
  }
}

async function organizeKomgaLibraryUI() {
  const cfg = loadConfig();
  const mode = cfg.komgaOrganizeMode === 'copy' ? 'copy' : 'hardlink';
  const createGhostFolders = cfg.komgaCreateGhostFolders === true;
  const createSeriesMetadata = cfg.komgaCreateSeriesMetadata !== false;
  const createSeriesCover = cfg.komgaCreateSeriesCover !== false;

  try {
    const result = await organizeDownloadsForKomga({
      mode,
      createGhostFolders,
      createSeriesMetadata,
      createSeriesCover,
      forceSync: true
    });

    if (result.skippedByRecentSync) {
      console.log(`[KOMGA] Organizacao ignorada: ultima sincronizacao foi hoje (${result.lastSyncAt || 'agora'}).`);
      console.log('[KOMGA] Para sincronizar novamente no mesmo dia, ajuste manualmente lastKomgaLibrarySyncAt no config.');
      return;
    }

    applyConfigValues({
      komgaOrganizeMode: mode,
      komgaCreateGhostFolders: createGhostFolders,
      komgaCreateSeriesMetadata: createSeriesMetadata,
      komgaCreateSeriesCover: createSeriesCover
    });

    console.log(`[KOMGA] Organizacao concluida em: ${result.libraryRoot}`);
    console.log(`[KOMGA] Modo: ${result.mode}`);
    console.log(`[KOMGA] CBZ encontrados: ${result.foundCbz}`);
    console.log(`[KOMGA] linked=${result.linked}, copied=${result.copied}, skipped=${result.skipped}`);
    console.log(`[KOMGA] Series: ${result.seriesCount}, ghostFolders=${result.ghostFolders}`);
    console.log(`[KOMGA] series.json gerados: ${result.metadataCreated}`);
    console.log(`[KOMGA] covers geradas: ${result.coverCreated}`);
    console.log(`[KOMGA] ultima sincronizacao: ${result.lastSyncAt || '(nao registrado)'}`);

    try {
      const deepScan = await triggerKomgaLibraryScan({ scanDeep: true, scanForceModifiedTime: true });
      console.log(`[KOMGA] Varrimento profundo disparado (modo=${deepScan.strategy}, jobs=${deepScan.triggered}).`);
    } catch (e) {
      console.log(`[KOMGA] Nao foi possivel disparar varrimento profundo: ${e.message}`);
    }

    try {
      const refresh = await triggerKomgaMetadataRefresh();
      console.log(`[KOMGA] Refresh de metadata disparado (modo=${refresh.strategy}, jobs=${refresh.triggered}).`);
    } catch (e) {
      console.log(`[KOMGA] Nao foi possivel disparar refresh de metadata: ${e.message}`);
    }

    try {
      const patched = await syncKomgaSeriesMetadataFromLocal();
      console.log(`[KOMGA] Metadata aplicada direto via API: tentadas=${patched.attempted}, atualizadas=${patched.patched}, sem-match=${patched.skipped}, falhas=${patched.failed}.`);
    } catch (e) {
      console.log(`[KOMGA] Nao foi possivel aplicar metadata direta: ${e.message}`);
    }
  } catch (e) {
    console.error('[KOMGA] Falha ao organizar biblioteca:', e.message);
  }
}

async function runKomgaPostStartTasks(cfg) {
  try {
    const lib = await ensureKomgaLibraryExists({
      name: cfg.komgaAutoLibraryName || 'mangas-Suwayomi'
    });
    console.log(`[KOMGA] Biblioteca ${lib.name} ${lib.created ? 'criada' : 'ja existente'} em ${lib.root}`);
  } catch (e) {
    console.log(`[KOMGA] Nao foi possivel garantir biblioteca padrao: ${e.message}`);
  }

  if (cfg.komgaSyncOnStart === false) return;

  try {
    const sync = await triggerKomgaLibraryScan();
    console.log(`[KOMGA] Sync disparado com sucesso (modo=${sync.strategy}, jobs=${sync.triggered}).`);
  } catch (e) {
    console.log(`[KOMGA] Nao foi possivel disparar sync automatico: ${e.message}`);
  }

  try {
    const refresh = await triggerKomgaMetadataRefresh();
    console.log(`[KOMGA] Refresh de metadata disparado (modo=${refresh.strategy}, jobs=${refresh.triggered}).`);
  } catch (e) {
    console.log(`[KOMGA] Nao foi possivel disparar refresh de metadata: ${e.message}`);
  }

  try {
    const patched = await syncKomgaSeriesMetadataFromLocal();
    console.log(`[KOMGA] Metadata aplicada direto via API: tentadas=${patched.attempted}, atualizadas=${patched.patched}, sem-match=${patched.skipped}, falhas=${patched.failed}.`);
  } catch (e) {
    console.log(`[KOMGA] Nao foi possivel aplicar metadata direta: ${e.message}`);
  }
}

async function runKomgaPostStartWhenReady(cfg, tries = 24, intervalMs = 2500) {
  for (let i = 0; i < tries; i += 1) {
    try {
      await ensureKomgaLibraryExists({
        name: cfg.komgaAutoLibraryName || 'mangas-Suwayomi'
      });
      // Once library endpoint is available, run full post-start flow.
      await runKomgaPostStartTasks(cfg);
      return;
    } catch (e) {
      await sleep(intervalMs);
    }
  }
  console.log('[KOMGA] Komga demorou para ficar pronto; biblioteca/sync automaticos nao foram executados agora.');
}

async function startKomgaUI() {
  try {
    const prompt = ensurePrompt();
    let cfg = loadConfig();
    cfg = await ensureKomgaJarReady(prompt, cfg);
    const needsFirstKomgaLogin = !cfg.komgaUsername || !cfg.komgaPassword;

    const organizeResult = await organizeDownloadsForKomga({
      mode: cfg.komgaOrganizeMode === 'copy' ? 'copy' : 'hardlink',
      createGhostFolders: cfg.komgaCreateGhostFolders === true,
      createSeriesMetadata: cfg.komgaCreateSeriesMetadata !== false,
      createSeriesCover: cfg.komgaCreateSeriesCover !== false,
      useDownloadsAsLibrary: cfg.komgaUseDownloadsAsLibrary !== false,
      forceSync: true
    });

    if (!organizeResult.skippedByRecentSync) {
      console.log(`[KOMGA] Organizacao pre-start concluida em ${organizeResult.libraryRoot}`);
      console.log(`[KOMGA] moved=${organizeResult.moved || 0}, linked=${organizeResult.linked}, copied=${organizeResult.copied}, skipped=${organizeResult.skipped}`);
    }

    const result = await startKomga();
    if (result.ready) {
      console.log(`[KOMGA] Komga pronto em ${result.komgaUrl}`);
    } else {
      console.log(`[KOMGA] Komga iniciado em background (pid=${result.pid}). URL: ${result.komgaUrl}`);
    }
    console.log(`[KOMGA] JAR em uso: ${result.cfg.komgaJarPath}`);

    if (result.ready && needsFirstKomgaLogin) {
      console.log('[KOMGA] Primeiro acesso detectado: se ainda nao criou usuario/senha, abra o Komga e crie agora.');
      console.log(`[KOMGA] Link: ${result.komgaUrl}`);

      await prompt([
        {
          type: 'confirm',
          name: 'continueAfterLogin',
          message: 'Ja concluiu o login/cadastro no Komga? (continuar)',
          default: true
        }
      ]);

      const ans = await prompt([
        {
          name: 'komgaUsername',
          message: 'Usuario do Komga',
          default: String(cfg.komgaUsername || '').trim()
        },
        {
          type: 'password',
          name: 'komgaPassword',
          message: 'Senha do Komga',
          mask: '*',
          validate: (v) => String(v || '').trim().length ? true : 'Informe a senha do Komga'
        }
      ]);

      cfg = applyConfigValues({
        komgaUsername: String(ans.komgaUsername || '').trim(),
        komgaPassword: String(ans.komgaPassword || '').trim()
      });
    }

    if (result.ready) {
      await runKomgaPostStartTasks(cfg);
    } else {
      console.log('[KOMGA] Iniciado em background; aguardando ficar pronto para garantir biblioteca e sync...');
      runKomgaPostStartWhenReady(cfg).catch((e) => {
        console.log(`[KOMGA] Pos-start automatico falhou: ${e.message}`);
      });
    }
  } catch (e) {
    console.error('[KOMGA] Falha ao iniciar Komga:', e.message);
  }
}

module.exports = {
  startPipelineUI,
  cleanupReadByAniListUI,
  downloadsStatusUI,
  organizeKomgaLibraryUI,
  startKomgaUI
};