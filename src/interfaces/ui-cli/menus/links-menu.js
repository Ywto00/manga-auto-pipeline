const cliLogic = require('../../../cli-logic-adapter');
const { ensurePrompt } = require('../input/prompt');
const ui = require('../feedback/ui-enhancements');
const {
  computeBatchTransparency,
  collectAutoSelectedKeys,
  saveSelectedLinks
} = require('../../../features/links/application/auto-link-batch-service');

// Functions from cli-logic-adapter
const {
  loadConfig,
  saveConfig,
  fetchUserList,
  listMangaItemsForManualLink,
  searchManualLinkCandidates,
  getManualLinkRuntimeStatus,
  getCachedAutoLinkCandidates,
  buildBatchAutoLinkPreview,
  warmAutoLinkCache,
  warmAndBuildPreview,
  checkSourcesHealth,
  setManualLink,
  removeManualLink,
  startServer,
  enqueueFromList,
  getSources,
  getAutoLinkCandidates
} = cliLogic;

const { resolveEnqueuePrefs } = require('../../../features/pipeline/application/resolve-enqueue-prefs');

// Use ui.colors instead of raw ANSI codes
function scoreLabel(score) {
  const n = Number(score || 0);
  if (n >= 90) return ui.colors.success(String(n));
  if (n >= 70) return ui.colors.warning(String(n));
  return ui.colors.error(String(n));
}

function matchPercentLabel(score) {
  const n = Math.max(0, Math.min(100, Number(score || 0)));
  if (n >= 90) return ui.colors.success(`${n}%`);
  if (n >= 70) return ui.colors.warning(`${n}%`);
  return ui.colors.error(`${n}%`);
}

function chapterLabel(hasChapters) {
  if (hasChapters === true) return ui.colors.success('chapters:ok');
  if (hasChapters === false) return ui.colors.error('chapters:none');
  return ui.colors.muted('chapters:unknown');
}

function linkedStateLabel(linked) {
  return linked ? ui.colors.success('vinculado') : ui.colors.error('sem-vinculo');
}

function colorizeFoundTitle(title) {
  return ui.colors.info(String(title || ''));
}

function truncateText(value, max = 68) {
  const text = String(value || '').trim();
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}...`;
}

function printLinksConfigSummary(cfg) {
  const langs = Array.isArray(cfg.preferredSearchLangs) && cfg.preferredSearchLangs.length
    ? cfg.preferredSearchLangs.join(',')
    : 'all';
  const sourceLimit = Number(cfg.maxExtensionsForAutoLink || 12);
  const sourceConcurrency = Number(cfg.autoLinkSourceConcurrency || cfg.maxSourcesInParallel || 8);
  const cacheTtl = Number(cfg.linkCacheTtlMinutes || 720);
  const cleanup = cfg.cleanupLibraryDuplicates === true ? 'on' : 'off';
  console.log(`\n[CFG] langs=${langs} | maxSources=${sourceLimit} | parallel=${sourceConcurrency} | cacheTtl=${cacheTtl}m | dedupeLibrary=${cleanup}`);
}

function filterSourcesByConfig(sources, cfg) {
  let out = Array.isArray(sources) ? [...sources] : [];

  const langs = Array.isArray(cfg.preferredSearchLangs)
    ? cfg.preferredSearchLangs.map(x => String(x || '').toLowerCase()).filter(Boolean)
    : [];
  if (langs.length) {
    const langSet = new Set(langs);
    out = out.filter(s => langSet.has(String(s && s.lang || '').toLowerCase()));
  }

  if (cfg.fixedSourceId != null && String(cfg.fixedSourceId).trim() !== '') {
    const target = String(cfg.fixedSourceId).trim();
    out = out.filter(s => String(s && s.id) === target);
  }

  return out;
}

async function updateAniListSnapshot(prompt) {
  const cfg = loadConfig();
  let username = String(cfg.usernameAnilist || '').trim();
  if (!username) {
    const ans = await prompt([{ name: 'user', message: 'Usuario AniList', default: '' }]);
    username = String(ans.user || '').trim();
  }
  if (!username) {
    console.log('Usuario AniList nao informado.');
    return false;
  }

  console.log(`[LISTA] Atualizando lista AniList de ${username}...`);
  const { mapped, readingLike } = await fetchUserList('anilist', username);
  console.log(`[LISTA] Total=${mapped.length}, leitura/pausado=${readingLike.length}`);
  return true;
}

async function showUnifiedList(rows, prompt) {
  const ans = await prompt([
    {
      name: 'limit',
      message: 'Quantos itens listar?',
      default: 50,
      validate: (v) => {
        const n = Number(v);
        return Number.isFinite(n) && n >= 1 && n <= 200 ? true : `${ui.colors.error('Erro:')} Digite um numero entre 1 e 200`;
      }
    },
    {
      type: 'list',
      name: 'viewMode',
      message: 'Formato da lista',
      choices: [
        { name: `${ui.colors.success('🟢 ')} Compacto (recomendado - rápido)`, value: 'compact' },
        { name: `${ui.colors.info('📋 ')} Detalhado (com mais informações)`, value: 'detailed' }
      ],
      default: 'compact'
    }
  ]);

  const limit = Number(ans.limit) || 50;
  const selected = rows.slice(0, limit);
  const showSuggestions = true;

  let previewsByKey = new Map();
  if (showSuggestions) {
    ui.separator('🔄 Carregando sugestões...');
    for (const r of selected) {
      const preview = getCachedAutoLinkCandidates(r.item, {
        maxSourcesToTry: 12,
        verifyChapters: true
      });
      previewsByKey.set(String(r.key), {
        key: r.key,
        item: r.item,
        linked: r.linked || null,
        best: preview.best || null,
        sources: Array.isArray(preview.sources) ? preview.sources : [],
        cached: Boolean(preview.cached)
      });
    }
  }

  const linkedRows = selected.filter(r => Boolean(r.linked));
  const unlinkedRows = selected.filter(r => !r.linked);

  ui.separator('📋 Lista Completa');
  console.log(`${ui.colors.muted('Total:')} ${ui.colors.info(selected.length)} | ${ui.colors.success(linkedRows.length + ' vinculados')} | ${ui.colors.error(unlinkedRows.length + ' sem vínculo')}`);
  console.log('');

  const width = Math.min(process.stdout.columns || 80, 100);
  const divider = '─'.repeat(width);
  console.log(ui.colors.muted(divider));

  selected.forEach((r, i) => {
    const preview = previewsByKey.get(String(r.key));
    const linkedScore = r.linked && Number.isFinite(Number(r.linked.score))
      ? Number(r.linked.score)
      : null;
    const matchPct = r.linked
      ? (linkedScore != null ? matchPercentLabel(linkedScore) : '--')
      : (preview && preview.best ? matchPercentLabel(preview.best.score) : '--');

    // Status icon and color
    const isLinked = Boolean(r.linked);
    const statusIcon = isLinked ? `${ui.colors.success('✓')}` : `${ui.colors.error('✗')}`;
    const statusText = isLinked ? ui.colors.success('VINCULADO') : ui.colors.error('SEM VÍNCULO');

    if (ans.viewMode === 'compact') {
      // Compact mode - cleaner layout
      console.log(`${ui.colors.muted(String(i + 1).padStart(3, ' '))}. ${statusIcon} ${ui.colors.primary(truncateText(r.item.title, width - 15))}`);

      if (isLinked) {
        const linkedSource = r.linked.sourceName || r.linked.sourceId;
        const linkedTitle = truncateText(r.linked.mangaTitle, 40);
        console.log(`   ${ui.colors.muted('└─')} ${ui.colors.info(linkedSource)} / ${ui.colors.success(linkedTitle)} ${matchPct !== '--' ? ui.colors.muted(`(${matchPct})`) : ''}`);
      } else if (preview && preview.best) {
        const bestSource = preview.best.sourceName;
        const bestTitle = truncateText(preview.best.mangaTitle, 40);
        const score = scoreLabel(Number(preview.best.score || 0));
        const cache = preview.cached ? ui.colors.muted('[cache]') : '';
        console.log(`   ${ui.colors.muted('└─')} ${ui.colors.warning(bestSource)} / ${colorizeFoundTitle(bestTitle)} ${score} ${cache}`);
      } else {
        console.log(`   ${ui.colors.muted('└─')} ${ui.colors.error('Nenhuma sugestão disponível')}`);
      }
    } else {
      // Detailed mode - more info
      console.log(`${statusIcon} ${ui.colors.bold(truncateText(r.item.title, width - 10))} [${statusText}]`);

      if (Array.isArray(r.item.altTitles) && r.item.altTitles.length) {
        const altTitles = r.item.altTitles.slice(0, 3).join(' | ');
        console.log(`   ${ui.colors.muted('Alt:')} ${ui.colors.info(altTitles)}`);
      }

      if (isLinked) {
        const linkedSource = r.linked.sourceName || r.linked.sourceId;
        const linkedTitle = r.linked.mangaTitle;
        console.log(`   ${ui.colors.muted('Vínculo:')} ${ui.colors.success(linkedSource)} / ${colorizeFoundTitle(linkedTitle)} ${matchPct !== '--' ? ui.colors.muted(`[match:${matchPct}]`) : ''}`);
      } else if (preview && preview.best) {
        const bestSource = preview.best.sourceName;
        const bestTitle = preview.best.mangaTitle;
        const score = preview.best.score;
        const match = matchPercentLabel(score);
        const by = preview.best.matchedAgainst ? ` (by='${preview.best.matchedAgainst}')` : '';
        const cache = preview.cached ? ui.colors.muted('[cache]') : '';
        console.log(`   ${ui.colors.muted('Sugestão:')} ${ui.colors.warning(bestSource)} / ${colorizeFoundTitle(bestTitle)} ${scoreLabel(score)} ${match}${by}${cache}`);
      } else {
        console.log(`   ${ui.colors.muted('Sugestão:')} ${ui.colors.error('Nenhuma sugestão disponível')}`);
      }

      // Show source availability
      if (preview && Array.isArray(preview.sources) && preview.sources.length) {
        const sourcesLine = preview.sources
          .slice(0, 3)
          .map(s => {
            const top = Array.isArray(s.mangas) && s.mangas[0] ? s.mangas[0] : null;
            if (!top) return `${s.sourceName}[${s.lang}]`;
            return `${s.sourceName}[${s.lang}]: ${scoreLabel(top.score)} ${chapterLabel(top.hasChapters)}`;
          })
          .join(' | ');
        console.log(`   ${ui.colors.muted('Fontes:')} ${sourcesLine}`);
      }
    }

    // Add spacing between items (except last)
    if (i < selected.length - 1) {
      console.log('');
    }
  });

  console.log('');
  console.log(ui.colors.muted(divider));

  const showMore = rows.length > limit;
  if (showMore) {
    console.log(`${ui.colors.warning('⚠️')} Mostrando ${limit} de ${rows.length} itens. Use um limite maior para ver mais.`);
  }
}

async function runSourceHealthCheck(prompt) {
  const cfg = loadConfig();
  const ans = await prompt([
    {
      name: 'maxSourcesToTry',
      message: 'Quantas fontes testar?',
      default: Number(cfg.maxExtensionsForAutoLink || 12),
      validate: (v) => {
        const n = Number(v);
        return Number.isFinite(n) && n >= 1 && n <= 50 ? true : 'Digite um numero entre 1 e 50';
      }
    },
    {
      name: 'probeTerm',
      message: 'Termo de teste',
      default: 'one piece'
    }
  ]);

  console.log('[HEALTH] Testando fontes (inclui detecao de erro 500)...');
  const result = await checkSourcesHealth({
    maxSourcesToTry: Number(ans.maxSourcesToTry) || Number(cfg.maxExtensionsForAutoLink || 12),
    probeTerm: ans.probeTerm || 'one piece'
  });

  console.log(`[HEALTH] Total=${result.total} | OK=${result.ok} | Falhas=${result.failed}`);
  result.rows.forEach((r, i) => {
    if (r.ok) {
      console.log(`${i + 1}. OK ${r.sourceName} [${r.lang}] resultados=${r.sampleResults}`);
      return;
    }
    const status = r.httpStatus ? `HTTP ${r.httpStatus}` : 'sem status HTTP';
    const marker = Number(r.httpStatus) === 500 ? ' [ERRO 500]' : '';
    console.log(`${i + 1}. FAIL ${r.sourceName} [${r.lang}] ${status}${marker} -> ${r.error || 'erro desconhecido'}`);
  });
}

async function runBatchAutoMatch(rows, prompt) {
  try {
    await getSources();
  } catch (e) {
    ui.NotificationManager.instance.info('Suwayomi offline. Iniciando servidor para varredura...');
    await startServer();
  }

  const cfg = loadConfig();
  const defaultBatchLimit = Number(cfg.autoLinkBatchLimit || 80);
  const defaultBatchConcurrency = Number(cfg.autoLinkBatchConcurrency || 12);
  const defaultSourceConcurrency = Number(cfg.autoLinkSourceConcurrency || cfg.maxSourcesInParallel || 20);
  const defaultSourcesToTry = Number(cfg.maxExtensionsForAutoLink || 12);
  const defaultMinScore = Number(cfg.autoLinkMinScore || 90);
  const defaultCacheOnly = Boolean(cfg.autoLinkCacheOnly);
  const opts = await prompt([
    {
      type: 'list',
      name: 'mode',
      message: 'Modo de varredura',
      choices: [
        { name: 'Atualizar todos os vinculos da lista', value: 'all' },
        { name: 'Somente itens sem vinculo', value: 'missing' }
      ],
      default: 'missing'
    },
    {
      name: 'limit',
      message: 'Quantos itens processar no lote?',
      default: defaultBatchLimit,
      validate: (v) => {
        const n = Number(v);
        return Number.isFinite(n) && n >= 1 && n <= 2000 ? true : 'Digite um numero entre 1 e 2000';
      }
    },
    {
      name: 'concurrency',
      message: 'Paralelismo por item (1-40)',
      default: defaultBatchConcurrency,
      validate: (v) => {
        const n = Number(v);
        return Number.isFinite(n) && n >= 1 && n <= 40 ? true : 'Digite um numero entre 1 e 40';
      }
    },
    {
      name: 'sourceConcurrency',
      message: 'Paralelismo entre fontes por manga (1-40)',
      default: defaultSourceConcurrency,
      validate: (v) => {
        const n = Number(v);
        return Number.isFinite(n) && n >= 1 && n <= 40 ? true : 'Digite um numero entre 1 e 40';
      }
    },
    {
      name: 'maxSourcesToTry',
      message: 'Max fontes por item (1-50)',
      default: defaultSourcesToTry,
      validate: (v) => {
        const n = Number(v);
        return Number.isFinite(n) && n >= 1 && n <= 50 ? true : 'Digite um numero entre 1 e 50';
      }
    },
    {
      type: 'confirm',
      name: 'cacheOnly',
      message: 'Usar apenas cache (sem buscar online)?',
      default: defaultCacheOnly
    },
    {
      type: 'confirm',
      name: 'forceRefresh',
      message: 'Ignorar cache e refazer busca agora?',
      default: false,
      when: (a) => !a.cacheOnly
    },
    {
      type: 'confirm',
      name: 'autoApply',
      message: 'Aplicar automaticamente sugestoes acima do score minimo?',
      default: true
    },
    {
      name: 'autoAcceptScore',
      message: 'Score minimo para aplicacao automatica (60-99)',
      default: defaultMinScore,
      when: (a) => a.autoApply,
      validate: (v) => {
        const n = Number(v);
        return Number.isFinite(n) && n >= 60 && n <= 99 ? true : 'Digite um numero entre 60 e 99';
      }
    }
  ]);

  const onlyUnlinked = opts.mode === 'missing';

  cfg.autoLinkBatchLimit = Math.max(1, Math.min(2000, Number(opts.limit) || defaultBatchLimit));
  cfg.autoLinkBatchConcurrency = Math.max(1, Math.min(40, Number(opts.concurrency) || defaultBatchConcurrency));
  cfg.autoLinkSourceConcurrency = Math.max(1, Math.min(40, Number(opts.sourceConcurrency) || defaultSourceConcurrency));
  cfg.maxExtensionsForAutoLink = Math.max(1, Math.min(50, Number(opts.maxSourcesToTry) || defaultSourcesToTry));
  cfg.autoLinkCacheOnly = Boolean(opts.cacheOnly);
  cfg.autoLinkMinScore = Math.max(60, Math.min(99, Number(opts.autoAcceptScore || defaultMinScore)));
  saveConfig(cfg);

  ui.separator('Varredura Automática - ' + ui.colors.primary('Processando...'));

  const { warm, previewRows } = await ui.withSpinner('Analisando lista e aquecendo cache', async () => {
    return await warmAndBuildPreview({
      onlyUnlinked,
      limit: Number(opts.limit) || 80,
      concurrency: Number(opts.concurrency) || 10,
      maxSourcesToTry: Number(opts.maxSourcesToTry) || Number(cfg.maxExtensionsForAutoLink || 12),
      searchConcurrency: Number(opts.sourceConcurrency) || Number(cfg.autoLinkSourceConcurrency || cfg.maxSourcesInParallel || 20),
      forceRefresh: Boolean(opts.forceRefresh),
      cacheOnly: Boolean(opts.cacheOnly),
      onProgress: (p) => {
        // Update same line with progress
        process.stdout.write(`\r  Progresso: ${p.done}/${p.total} | sugestões=${p.withBest} | cache=${p.cacheHits} | erros=${p.errors}`);
      }
    }, {
      warmAutoLinkCache,
      buildBatchAutoLinkPreview
    });
  });

  console.log(`\n[STATS] Cache: total=${warm.total}, com sugestão=${warm.withBest}, hits=${warm.cacheHits}, erros=${warm.errors}`);

  if (!previewRows.length) {
    ui.NotificationManager.instance.warning('Nenhum item retornado no lote');
    return;
  }

  // Show preview in a nice format
  ui.separator('Resultados (top 20)');
  previewRows.slice(0, 20).forEach((r, i) => {
    if (r.best) {
      const scoreColor = r.best.score >= 90 ? ui.colors.success : (r.best.score >= 70 ? ui.colors.warning : ui.colors.error);
      console.log(`  ${i + 1}. ${ui.colors.muted(r.item.title.substring(0, 60))}`);
      console.log(`     → ${r.best.sourceName} / ${scoreColor(r.best.mangaTitle)} (score=${scoreColor(r.best.score)})${r.cached ? ' [cache]' : ''}`);
    } else {
      console.log(`  ${i + 1}. ${ui.colors.muted(r.item.title.substring(0, 60))}`);
      console.log(`     → ${ui.colors.error('sem sugestão')}`);
    }
  });

  if (previewRows.length > 20) {
    console.log(`  ... e mais ${previewRows.length - 20} itens`);
  }

  const minScore = Number(opts.autoAcceptScore || 90);
  const transparency = computeBatchTransparency(previewRows, minScore);
  console.log(`\n[TRANSPARÊNCIA] Total: ${transparency.total} | Com sugestão: ${transparency.withSuggestion} | Sem sugestão: ${transparency.withoutSuggestion} | Abaixo score (${minScore}): ${transparency.belowScore} | Auto-aplicáveis: ${transparency.acceptedByRule}`);

  let selectedKeys = [];
  if (opts.autoApply) {
    selectedKeys = collectAutoSelectedKeys(previewRows, minScore);
    const autoRejectedRows = previewRows
      .filter(r => r.best && Number(r.best.score || 0) < minScore)
      .slice(0, 10);
    if (autoRejectedRows.length) {
      console.log(`[REJEITADOS AUTO] Top ${autoRejectedRows.length} (score < ${minScore}):`);
      autoRejectedRows.forEach((r, idx) => {
        console.log(`  ${idx + 1}. ${r.item.title.substring(0, 50)} | score=${Number(r.best.score || 0)}`);
      });
    }

    const noSuggestionRows = previewRows.filter(r => !r.best).slice(0, 10);
    if (noSuggestionRows.length) {
      console.log('[SEM SUGESTÃO] Top 10:');
      noSuggestionRows.forEach((r, idx) => {
        const reason = opts.cacheOnly
          ? 'cache sem entrada'
          : 'nenhum candidato válido';
        console.log(`  ${idx + 1}. ${r.item.title.substring(0, 50)} | ${reason}`);
      });
    }
  } else {
    const choices = previewRows
      .filter(r => r.best)
      .map(r => ({
        name: `${r.item.title} → ${r.best.sourceName} / ${r.best.mangaTitle} (${r.best.score})`,
        value: r.key,
        checked: Number(r.best.score || 0) >= 90
      }));

    if (!choices.length) {
      ui.NotificationManager.instance.warning('Sem sugestões válidas para aceitar neste lote');
      return;
    }

    const accept = await prompt([
      {
        type: 'checkbox',
        name: 'keys',
        message: 'Selecione os vinculos para salvar',
        pageSize: 20,
        choices
      }
    ]);
    selectedKeys = (accept.keys || []).map(String);
  }

  if (!selectedKeys.length) {
    ui.NotificationManager.instance.warning('Nenhum vinculo selecionado para salvar');
    return;
  }

  ui.separator('Salvando vínculos...');
  const savedCount = await saveSelectedLinks(previewRows, selectedKeys, { setManualLink });
  ui.NotificationManager.instance.success(`${savedCount} vínculos adicionados à biblioteca`);

  const selectedSet = new Set(selectedKeys.map(String));
  const rowsToUnlink = previewRows.filter(r => r.linked && !selectedSet.has(String(r.key)));
  if (rowsToUnlink.length > 0) {
    const unlinkAns = await prompt([
      {
        type: 'confirm',
        name: 'confirmUnlink',
        message: `Remover da biblioteca os ${rowsToUnlink.length} itens não vinculados neste lote?`,
        default: true
      }
    ]);

    if (unlinkAns.confirmUnlink) {
      let unlinkedCount = 0;
      let unlinkFail = 0;
      for (const row of rowsToUnlink) {
        try {
          // Keep library aligned with links: items not selected as linked are removed.
          await removeManualLink(row.item);
          unlinkedCount += 1;
        } catch (e) {
          unlinkFail += 1;
        }
      }
      console.log(`[BIBLIOTECA] Removidos: ${ui.colors.success(unlinkedCount)} | Falhas: ${ui.colors.error(unlinkFail)}`);
    }
  }

  const runAns = await prompt([
    {
      type: 'confirm',
      name: 'runNow',
      message: 'Baixar agora os itens vinculados neste lote?',
      default: true
    }
  ]);

  if (runAns.runNow) {
    const cfgNow = loadConfig();
    const prefs = resolveEnqueuePrefs(cfgNow);
    console.log('[ENQUEUE] Iniciando download dos itens selecionados...');
    const run = await enqueueFromList({
      dry: false,
      priority: prefs.priority,
      allowedLangs: prefs.allowedLangs,
      sourceOrderIds: prefs.sourceOrderIds,
      itemKeysFilter: selectedKeys,
      limit: selectedKeys.length,
      onItem: (row) => {
        if (row.skipped) {
          console.log(`  ${ui.colors.warning('SKIP')} ${row.item.title} (${row.reason || 'skip'})`);
          return;
        }
        if (row.ok) {
          if (row.result && row.result.fallbackUsed) {
            const persisted = row.result.linkUpdated ? ' [link padrão atualizado]' : '';
            console.log(`  ${ui.colors.success('OK')} ${row.item.title} → capítulos ${row.result.queuedChapterIndexes.join(',')} [${row.result.fallbackSourceName}]${persisted}`);
          } else {
            console.log(`  ${ui.colors.success('OK')} ${row.item.title} → capítulos ${row.result.queuedChapterIndexes.join(',')}`);
          }
        } else {
          console.log(`  ${ui.colors.error('FAIL')} ${row.item.title}: ${row.error}`);
        }
      }
    });

    const ok = run.output.filter(x => x.ok).length;
    const failed = run.output.filter(x => x.ok === false).length;
    console.log(`\n[RESUMO] Sucesso: ${ui.colors.success(ok)} | Falhas: ${ui.colors.error(failed)}`);
    ui.NotificationManager.instance.success(`Download batch concluído: ${ok} sucessos, ${failed} falhas`);
  }

  ui.separator();
}

async function createOrUpdateLink(rows, prompt) {
  await showUnifiedList(rows, prompt);

  const filterAns = await prompt([
    {
      type: 'list',
      name: 'scope',
      message: 'Filtrar itens para selecao manual',
      choices: [
        { name: 'Todos', value: 'all' },
        { name: 'Somente sem vinculo', value: 'unlinked' },
        { name: 'Somente vinculados', value: 'linked' }
      ],
      default: 'unlinked'
    },
    {
      name: 'query',
      message: 'Filtro por titulo (opcional)',
      default: ''
    }
  ]);

  const q = String(filterAns.query || '').trim().toLowerCase();
  const filteredRows = rows
    .filter(r => {
      if (filterAns.scope === 'unlinked' && r.linked) return false;
      if (filterAns.scope === 'linked' && !r.linked) return false;
      if (!q) return true;
      const title = String(r.item && r.item.title || '').toLowerCase();
      const alt = Array.isArray(r.item && r.item.altTitles) ? r.item.altTitles.join(' ').toLowerCase() : '';
      return title.includes(q) || alt.includes(q);
    })
    .slice(0, 500);

  if (!filteredRows.length) {
    console.log('Nenhum item encontrado com esse filtro.');
    return;
  }

  const pickItem = await prompt([
    {
      type: 'list',
      name: 'key',
      message: 'Escolha o manga da sua lista',
      pageSize: 20,
      choices: filteredRows.map(r => ({
        name: `${linkedStateLabel(r.linked)} ${truncateText(r.item.title, 60)}${r.linked ? ` -> ${truncateText(r.linked.sourceName || r.linked.sourceId, 24)}` : ''}`,
        value: r.key
      }))
    }
  ]);

  const selected = rows.find(r => r.key === pickItem.key);
  if (!selected) return;

  const runtime = await getManualLinkRuntimeStatus(selected.item);
  const runtimeLink = runtime && runtime.linked
    ? `${runtime.linked.sourceName || runtime.linked.sourceId} / ${runtime.linked.mangaTitle}`
    : 'sem vinculo';

  console.log(`\n[ITEM] ${ui.colors.info(selected.item.title)}`);
  if (Array.isArray(selected.item.altTitles) && selected.item.altTitles.length) {
    console.log(`[ITEM] Alt: ${selected.item.altTitles.slice(0, 6).join(' | ')}`);
  }
  console.log(`[ITEM] Vinculo atual: ${runtimeLink}`);
  if (runtime && runtime.linked) {
    if (runtime.ok) {
      console.log(`[ITEM] Suwayomi: ${chapterLabel(runtime.hasChapters)} | baixados=${ui.colors.success(String(runtime.downloadedCount || 0))} / total=${runtime.chapterCount || 0} | maxCap=${runtime.maxDownloaded || 0}`);
    } else {
      console.log(`[ITEM] Suwayomi: ${ui.colors.error('erro ao consultar')} (${runtime.error || 'erro desconhecido'})`);
    }
  }

  const action = await prompt([
    {
      type: 'list',
      name: 'mode',
      message: `Acao para ${selected.item.title}`,
      choices: [
        'Adicionar/ajustar vinculo na biblioteca',
        'Remover da biblioteca',
        'Voltar'
      ]
    }
  ]);

  if (action.mode === 'Voltar') return;
  if (action.mode === 'Remover da biblioteca') {
    if (!selected.linked) {
      console.log('Este item nao esta vinculado na biblioteca do Suwayomi.');
      return;
    }
    await removeManualLink(selected.item);
    selected.linked = null;
    console.log(`Removido da biblioteca: ${selected.item.title}`);
    return;
  }

  const cfg = loadConfig();
  const sources = await getSources();
  if (!Array.isArray(sources) || !sources.length) {
    console.log('Sem fontes instaladas no Suwayomi.');
    return;
  }

  const filteredSources = filterSourcesByConfig(sources, cfg);
  if (!filteredSources.length) {
    console.log('Nenhuma fonte apos aplicar filtros atuais de configuracao (idioma/fonte fixa).');
    return;
  }

  if (selected.linked) {
    console.log(`[LINK] Atual: ${selected.linked.sourceName || selected.linked.sourceId} / ${selected.linked.mangaTitle} (${selected.linked.mangaId})`);
  }

  const pickSource = await prompt([
    {
      type: 'list',
      name: 'sourceId',
      message: `Escolha a fonte para ${selected.item.title}`,
      pageSize: 20,
      choices: filteredSources.map(s => ({
        name: `${s.name} [${s.lang}] (${s.id})${selected.linked && String(selected.linked.sourceId) === String(s.id) ? ` ${ui.colors.success('[atual]')}` : ''}`,
        value: String(s.id)
      }))
    }
  ]);

  const source = filteredSources.find(s => String(s.id) === String(pickSource.sourceId));
  const queryAns = await prompt([
    {
      name: 'q',
      message: 'Texto de busca na fonte',
      default: selected.item.title || selected.item.searchKey || ''
    }
  ]);

  const candidates = await searchManualLinkCandidates(selected.item, String(pickSource.sourceId), queryAns.q);
  if (!candidates.length) {
    console.log('Nenhum resultado retornado para essa busca/fonte.');
    return;
  }

  const pickManga = await prompt([
    {
      type: 'list',
      name: 'mangaId',
      message: 'Escolha o manga correto para adicionar na biblioteca',
      pageSize: 20,
      choices: candidates.map(c => ({ name: `${c.title} (${c.id})`, value: String(c.id) }))
    }
  ]);

  const manga = candidates.find(c => String(c.id) === String(pickManga.mangaId));
  if (!manga) return;

  const saved = await setManualLink(selected.item, {
    sourceId: String(pickSource.sourceId),
    sourceName: source ? source.name : String(pickSource.sourceId),
    mangaId: Number(manga.id),
    mangaTitle: manga.title
  });

  selected.linked = saved;
  console.log(`Adicionado na biblioteca: ${selected.item.title} => ${saved.sourceName || saved.sourceId} / ${saved.mangaTitle}`);
}

async function manageManualLinksUI() {
  const prompt = ensurePrompt();
  const ui = require('../feedback/ui-enhancements');

  try {
    let rows = await listMangaItemsForManualLink(2000);

    while (true) {
      const cfg = loadConfig();
      printLinksConfigSummary(cfg);

      // Create quick stats
      const linked = rows.filter(r => r.linked).length;
      const unlinked = rows.filter(r => !r.linked).length;
      const total = rows.length;

      console.log(ui.colors.muted(`  Stats: ${ui.colors.success(linked + ' vinculados')} | ${ui.colors.error(unlinked + ' sem vínculo')} | Total: ${total}`));
      console.log('');

      const action = await prompt([
        {
          type: 'list',
          name: 'act',
          message: ui.colors.primary('🔗 Gerenciar Vínculos'),
          choices: [
            { name: `${ui.colors.info('📱 ')} Atualizar lista AniList`, value: 'refresh' },
            { name: `${ui.colors.primary('📋 ')} Ver lista completa (${total} itens)`, value: 'view' },
            { name: `${ui.colors.success('⚡ ')} Varredura automática`, value: 'batch' },
            { name: `${ui.colors.warning('🩺 ')} Testar saúde das fontes`, value: 'health' },
            { name: `${ui.colors.warning('🔧 ')} Gerenciar vínculo manual`, value: 'manual' },
            '---',
            { name: `${ui.colors.muted('🔙 ')} Voltar`, value: 'back' }
          ]
        }
      ]);

      if (action.act === 'back') return;

      if (action.act === 'refresh') {
        ui.separator('Atualizar Lista AniList');
        const ok = await ui.withSpinner('Buscando dados da AniList', async () => {
          return await updateAniListSnapshot(prompt);
        });
        if (ok) {
          rows = await listMangaItemsForManualLink(2000);
          ui.NotificationManager.instance.success('Lista AniList atualizada!');
        } else {
          ui.NotificationManager.instance.error('Falha ao atualizar lista');
        }
        ui.separator();
        continue;
      }

      if (action.act === 'view') {
        ui.separator('📋 Lista Completa');
        rows = await listMangaItemsForManualLink(2000);
        if (!rows.length) {
          ui.NotificationManager.instance.warning('Nenhum item elegível encontrado');
        } else {
          await showUnifiedList(rows, prompt);
        }
        ui.separator();
        continue;
      }

      if (action.act === 'batch') {
        ui.separator('⚡ Varredura Automática');
        rows = await listMangaItemsForManualLink(2000);
        if (!rows.length) {
          ui.NotificationManager.instance.warning('Nenhum item elegível encontrado');
        } else {
          await runBatchAutoMatch(rows, prompt);
        }
        ui.separator();
        continue;
      }

      if (action.act === 'health') {
        ui.separator('🩺 Saúde das Fontes');
        await runSourceHealthCheck(prompt);
        ui.separator();
        continue;
      }

      if (action.act === 'manual') {
        ui.separator('🔧 Gerenciamento Manual');
        rows = await listMangaItemsForManualLink(2000);
        if (!rows.length) {
          ui.NotificationManager.instance.warning('Nenhum item elegível encontrado');
        } else {
          await createOrUpdateLink(rows, prompt);
        }
        ui.separator();
        continue;
      }
    }
  } catch (e) {
    ui.NotificationManager.instance.error('Falha no gerenciamento: ' + e.message);
  }
}

module.exports = {
  manageManualLinksUI
};
