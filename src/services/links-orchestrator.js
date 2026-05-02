const {
  listMangaItemsForManualLink,
  getAutoLinkCandidates,
  getCachedAutoLinkCandidates,
  buildBatchAutoLinkPreview,
  setManualLink,
  removeManualLink,
  getManualLinkRuntimeStatus,
  searchManualLinkCandidates
} = require('./auto-link-service');
const { getSources } = require('../infra/server/suwayomi-api');
const { startServer } = require('../infra/server/suwayomi-runner');
const { loadConfig, saveConfig } = require('../infra/config/config-store');

async function viewLinksFlow(deps) {
  const { prompt } = deps;
  const rows = await listMangaItemsForManualLink(2000);
  if (!rows.length) {
    return { ok: false, error: 'Nenhum item elegível encontrado' };
  }

  const ans = await prompt([
    {
      name: 'limit',
      message: 'Quantos itens listar?',
      default: 50,
      validate: (v) => {
        const n = Number(v);
        return Number.isFinite(n) && n >= 1 && n <= 200 ? true : 'Digite um numero entre 1 e 200';
      }
    },
    {
      type: 'list',
      name: 'viewMode',
      message: 'Formato da lista',
      choices: [
        { name: 'Compacto (recomendado - rápido)', value: 'compact' },
        { name: 'Detalhado (com mais informações)', value: 'detailed' }
      ],
      default: 'compact'
    }
  ]);

  const limit = Number(ans.limit) || 50;
  const selected = rows.slice(0, limit);
  const previewsByKey = new Map();

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

  return {
    ok: true,
    data: {
      selected,
      previewsByKey,
      viewMode: ans.viewMode,
      total: rows.length,
      limit
    }
  };
}

async function updateAniListSnapshotFlow(deps) {

  const { prompt, syncService } = deps;
  const cfg = loadConfig();
  let username = String(cfg.usernameAnilist || '').trim();
  if (!username) {
    const ans = await prompt([{ name: 'user', message: 'Usuario AniList', default: '' }]);
    username = String(ans.user || '').trim();
  }
  if (!username) {
    return { ok: false, error: 'Usuario AniList nao informado.' };
  }

  const result = await syncService.refreshUserList(username);
  if (!result.ok) {
    return { ok: false, error: result.error };
  }
  return { ok: true, data: result.data };
}

async function runSourceHealthCheckFlow(deps) {
  const { prompt, monitoringService } = deps;
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

  const result = await monitoringService.runHealthCheck({
    maxSourcesToTry: Number(ans.maxSourcesToTry) || Number(cfg.maxExtensionsForAutoLink || 12),
    probeTerm: ans.probeTerm || 'one piece'
  });

  return result;
}

async function runBatchAutoMatchFlow(deps) {
  const { prompt, linksService } = deps;

  try {
    await getSources();
  } catch (e) {
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

  const result = await linksService.getAutoMatchPreview({
    onlyUnlinked,
    limit: Number(opts.limit) || 80,
    concurrency: Number(opts.concurrency) || 10,
    maxSourcesToTry: Number(opts.maxSourcesToTry) || Number(cfg.maxExtensionsForAutoLink || 12),
    searchConcurrency: Number(opts.sourceConcurrency) || Number(cfg.autoLinkSourceConcurrency || cfg.maxSourcesInParallel || 20),
    forceRefresh: Boolean(opts.forceRefresh),
    cacheOnly: Boolean(opts.cacheOnly),
    onProgress: (p) => {
      process.stdout.write(`\r  Progresso: ${p.done}/${p.total} | sugestões=${p.withBest} | cache=${p.cacheHits} | erros=${p.errors}`);
    }
  });

  if (!result.ok) {
    return { ok: false, error: result.error };
  }

  const { previewRows } = result;
  const minScore = Number(opts.autoAcceptScore || 90);

  let selectedKeys = [];
  if (opts.autoApply) {
    selectedKeys = linksService.getSelectedKeys(previewRows, minScore);
  } else {
    const choices = previewRows
      .filter(r => r.best)
      .map(r => ({
        name: `${r.item.title} → ${r.best.sourceName} / ${r.best.mangaTitle} (${r.best.score})`,
        value: r.key,
        checked: Number(r.best.score || 0) >= 90
      }));

    if (!choices.length) {
      return { ok: false, error: 'Sem sugestões válidas para aceitar neste lote' };
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
    return { ok: false, error: 'Nenhum vinculo selecionado para salvar' };
  }

  const commitResult = await linksService.commitAutoMatches(selectedKeys, previewRows);
  if (!commitResult.ok) {
    return { ok: false, error: commitResult.error };
  }

  return {
    ok: true,
    matchedCount: commitResult.matchedCount,
    selectedKeys,
    previewRows,
    minScore,
    opts
  };
}

async function runManualLinkFlow(deps) {
  const { prompt } = deps;
  const rows = await listMangaItemsForManualLink(2000);

  if (!rows.length) {
    return { ok: false, error: 'Nenhum item elegível encontrado' };
  }

  // This flow is very interactive. We'll implement the logic of choosing the item and setting the link.
  // 1. Filter and Pick item
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
    return { ok: false, error: 'Nenhum item encontrado com esse filtro.' };
  }

  const pickItem = await prompt([
    {
      type: 'list',
      name: 'key',
      message: 'Escolha o manga da sua lista',
      pageSize: 20,
      choices: filteredRows.map(r => ({
        name: `${r.item.title} ${r.linked ? '-> ' + r.linked.sourceName : ''}`,
        value: r.key
      }))
    }
  ]);

  const selected = rows.find(r => r.key === pickItem.key);
  if (!selected) return { ok: false, error: 'Item não encontrado.' };

  const runtime = await getManualLinkRuntimeStatus(selected.item);

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

  if (action.mode === 'Voltar') return { ok: true, action: 'back' };

  if (action.mode === 'Remover da biblioteca') {
    if (!selected.linked) return { ok: false, error: 'Este item nao esta vinculado.' };
    await removeManualLink(selected.item);
    return { ok: true, action: 'removed', item: selected.item };
  }

  const cfg = loadConfig();
  const sources = await getSources();
  const filteredSources = sources.filter(s => {
    // Simplified filter for now, in real app it uses filterSourcesByConfig
    return true;
  });

  const pickSource = await prompt([
    {
      type: 'list',
      name: 'sourceId',
      message: `Escolha a fonte para ${selected.item.title}`,
      pageSize: 20,
      choices: filteredSources.map(s => ({
        name: `${s.name} [${s.lang}]`,
        value: String(s.id)
      }))
    }
  ]);

  const queryAns = await prompt([
    {
      name: 'q',
      message: 'Texto de busca na fonte',
      default: selected.item.title || selected.item.searchKey || ''
    }
  ]);

  const candidates = await searchManualLinkCandidates(selected.item, String(pickSource.sourceId), queryAns.q);
  if (!candidates.length) return { ok: false, error: 'Nenhum resultado retornado.' };

  const pickManga = await prompt([
    {
      type: 'list',
      name: 'mangaId',
      message: 'Escolha o manga correto',
      pageSize: 20,
      choices: candidates.map(c => ({ name: c.title, value: String(c.id) }))
    }
  ]);

  const manga = candidates.find(c => String(c.id) === String(pickManga.mangaId));
  if (!manga) return { ok: false, error: 'Manga não encontrado.' };

  const saved = await setManualLink(selected.item, {
    sourceId: String(pickSource.sourceId),
    sourceName: filteredSources.find(s => String(s.id) === String(pickSource.sourceId))?.name || String(pickSource.sourceId),
    mangaId: Number(manga.id),
    mangaTitle: manga.title
  });

  return { ok: true, action: 'linked', saved, item: selected.item };
}

module.exports = {
  viewLinksFlow,
  updateAniListSnapshotFlow,
  runSourceHealthCheckFlow,
  runBatchAutoMatchFlow,
  runManualLinkFlow
};
