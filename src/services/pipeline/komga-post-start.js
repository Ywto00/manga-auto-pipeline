function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function runKomgaPostStartTasks(cfg, deps) {
  const {
    ensureKomgaLibraryExists,
    triggerKomgaLibraryScan,
    triggerKomgaMetadataRefresh,
    syncKomgaSeriesMetadataFromLocal,
    logger
  } = deps;

  try {
    const lib = await ensureKomgaLibraryExists({
      name: cfg.komgaAutoLibraryName || 'mangas-Suwayomi'
    });
    logger.log(`[KOMGA] Biblioteca ${lib.name} ${lib.created ? 'criada' : 'ja existente'} em ${lib.root}`);
  } catch (e) {
    logger.log(`[KOMGA] Nao foi possivel garantir biblioteca padrao: ${e.message}`);
  }

  if (cfg.komgaSyncOnStart === false) return;

  try {
    const refresh = await triggerKomgaMetadataRefresh();
    logger.log(`[KOMGA] Refresh de metadata disparado (modo=${refresh.strategy}, jobs=${refresh.triggered}).`);
  } catch (e) {
    logger.log(`[KOMGA] Nao foi possivel disparar refresh de metadata: ${e.message}`);
  }

  try {
    const patched = await syncKomgaSeriesMetadataFromLocal();
    logger.log(`[KOMGA] Metadata aplicada direto via API: tentadas=${patched.attempted}, atualizadas=${patched.patched}, sem-match=${patched.skipped}, falhas=${patched.failed}.`);
  } catch (e) {
    logger.log(`[KOMGA] Nao foi possivel aplicar metadata direta: ${e.message}`);
  }

  try {
    const sync = await triggerKomgaLibraryScan();
    logger.log(`[KOMGA] Sync disparado com sucesso (modo=${sync.strategy}, jobs=${sync.triggered}).`);
  } catch (e) {
    logger.log(`[KOMGA] Nao foi possivel disparar sync automatico: ${e.message}`);
  }
}

async function runKomgaPostStartWhenReady(cfg, deps) {
  const tries = Number(deps.tries || 24);
  const intervalMs = Number(deps.intervalMs || 2500);
  const logger = deps.logger;

  for (let i = 0; i < tries; i += 1) {
    try {
      await deps.ensureKomgaLibraryExists({
        name: cfg.komgaAutoLibraryName || 'mangas-Suwayomi'
      });
      await runKomgaPostStartTasks(cfg, deps);
      return;
    } catch (e) {
      await sleep(intervalMs);
    }
  }
  logger.log('[KOMGA] Komga demorou para ficar pronto; biblioteca/sync automaticos nao foram executados agora.');
}

module.exports = {
  runKomgaPostStartTasks,
  runKomgaPostStartWhenReady
};
