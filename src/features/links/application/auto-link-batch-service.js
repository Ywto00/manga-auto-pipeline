function computeBatchTransparency(previewRows, minScore) {
  const withSuggestion = previewRows.filter(r => r.best).length;
  const withoutSuggestion = previewRows.length - withSuggestion;
  const belowScore = previewRows.filter(r => r.best && Number(r.best.score || 0) < minScore).length;
  const acceptedByRule = previewRows.filter(r => r.best && Number(r.best.score || 0) >= minScore).length;
  return {
    total: previewRows.length,
    withSuggestion,
    withoutSuggestion,
    belowScore,
    acceptedByRule
  };
}

function collectAutoSelectedKeys(previewRows, minScore) {
  return previewRows
    .filter(r => r.best && Number(r.best.score || 0) >= minScore)
    .map(r => String(r.key));
}

async function saveSelectedLinks(previewRows, selectedKeys, deps) {
  const setManualLink = deps.setManualLink;
  let savedCount = 0;

  for (const row of previewRows) {
    if (!row.best) continue;
    if (!selectedKeys.includes(String(row.key))) continue;

    await setManualLink(row.item, {
      sourceId: row.best.sourceId,
      sourceName: row.best.sourceName,
      mangaId: row.best.mangaId,
      mangaTitle: row.best.mangaTitle
    });
    savedCount += 1;
  }

  return savedCount;
}

async function warmAndBuildPreview(opts, deps) {
  const warm = await deps.warmAutoLinkCache({
    onlyUnlinked: opts.onlyUnlinked,
    limit: opts.limit,
    concurrency: opts.concurrency,
    maxSourcesToTry: opts.maxSourcesToTry,
    searchConcurrency: opts.searchConcurrency,
    forceRefresh: opts.forceRefresh,
    cacheOnly: opts.cacheOnly,
    verifyChapters: true,
    onProgress: opts.onProgress
  });

  const previewRows = await deps.buildBatchAutoLinkPreview({
    onlyUnlinked: opts.onlyUnlinked,
    limit: opts.limit,
    concurrency: opts.concurrency,
    maxSourcesToTry: opts.maxSourcesToTry,
    searchConcurrency: opts.searchConcurrency,
    verifyChapters: true,
    useCache: true,
    forceRefresh: false,
    cacheOnly: opts.cacheOnly
  });

  return { warm, previewRows };
}

module.exports = {
  computeBatchTransparency,
  collectAutoSelectedKeys,
  saveSelectedLinks,
  warmAndBuildPreview
};
