async function runEnqueueBackgroundTask(cfg, deps) {
  const fetchUserList = deps.fetchUserList;
  const enqueueFromList = deps.enqueueFromList;
  const resolveEnqueuePrefs = deps.resolveEnqueuePrefs;
  const logger = deps.logger || console;

  const username = cfg.usernameAnilist;
  logger.log(`[LIST] Buscando lista AniList de ${username}...`);
  const { mapped, readingLike } = await fetchUserList('anilist', username);
  logger.log(`[LIST] Total=${mapped.length}, em leitura/pausado=${readingLike.length}`);

  const prefs = resolveEnqueuePrefs(cfg);
  logger.log('[ENQUEUE] Iniciando enqueue com base no progresso do AniList...');

  const { output, stats, notFound } = await enqueueFromList({
    dry: false,
    priority: prefs.priority,
    allowedLangs: prefs.allowedLangs,
    sourceOrderIds: prefs.sourceOrderIds,
    limit: 200,
    onItem: (row) => {
      if (row.skipped) {
        const why = row.reason || 'already-processed';
        logger.log(`[SKIP] ${row.item.title} (${why})`);
        return;
      }

      if (row.ok) {
        const r = row.result;
        logger.log(`[RUN] ${row.item.title} => ${r.source.name} / ${r.manga.title} / indexes=${r.queuedChapterIndexes.join(',')}`);
      } else {
        logger.log(`[FAIL] ${row.item.title}: ${row.error}`);
      }
    }
  });

  const ok = output.filter(x => x.ok).length;
  const failed = output.filter(x => x.ok === false).length;
  logger.log(`[ENQUEUE] Summary: success=${ok}, failed=${failed}`);
  if (stats) {
    logger.log(`[ENQUEUE] Stats: eligible=${stats.eligibleCount}, alreadyProcessed=${stats.skippedAlreadyProcessed}, processingNow=${stats.processedCount}`);
  }

  if (Array.isArray(notFound) && notFound.length) {
    logger.log('[ENQUEUE] Nao encontrados com sugestoes:');
    notFound.slice(0, 20).forEach((nf, i) => {
      logger.log(`${i + 1}. ${nf.title}`);
      const suggestions = nf.details && Array.isArray(nf.details.suggestionsBySource)
        ? nf.details.suggestionsBySource
        : [];
      suggestions.forEach(s => {
        const titles = (s.titles || []).slice(0, 5).join(' | ');
        logger.log(`   ${s.sourceName} [${s.lang}] -> ${titles}`);
      });
    });
  }
}

module.exports = {
  runEnqueueBackgroundTask
};
