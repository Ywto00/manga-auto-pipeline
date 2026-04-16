const configStore = require('./services/config-store');
const { applyConfigValues, isConfigComplete } = require('./features/settings/infra/config-validation');
const { postGraphQL } = require('./shared/utils/api-common');
const { fetchAniList, fetchAniListMediaById } = require('./features/sync/infra/anilist-adapter');
const { fetchUserList } = require('./features/sync/application/fetch-user-list');
const { getDownloadsOverview } = require('./features/pipeline/application/downloads-overview');
const { isServerRunning, isKomgaRunning } = require('./features/server/application/process-state');
const { deleteReadChaptersByAniList } = require('./features/cleanup/application/delete-read-chapters');

const suwayomiApi = require('./features/server/infra/suwayomi-api');
const {
  startSuwayomiJar,
  waitForSuwayomiReady,
  syncServerConf,
  quotePathForHocon
} = require('./features/server/infra/suwayomi-runner');
const {
  startServer,
  startKomga,
  stopDownloads,
  stopServer,
  stopKomga,
  waitForDownloadsAndSyncKomga
} = require('./features/server/application/server-lifecycle');

const {
  waitForKomgaReady,
  moveJarToManaged
} = require('./features/komga/infra/komga-runner');

const {
  organizeDownloadsForKomga
} = require('./features/komga/infra/komga-organizer');

const {
  ensureKomgaLibraryExists,
  triggerKomgaLibraryScan,
  triggerKomgaMetadataRefresh,
  syncKomgaSeriesMetadataFromLocal
} = require('./features/komga/infra/komga-api');

const {
  listMangaItemsForManualLink,
  searchManualLinkCandidates,
  getManualLinkRuntimeStatus,
  getCachedAutoLinkCandidates,
  getAutoLinkCandidates,
  buildBatchAutoLinkPreview,
  warmAutoLinkCache,
  setManualLink,
  removeManualLink
} = require('./services/autolink');

const {
  computeBatchTransparency,
  collectAutoSelectedKeys,
  saveSelectedLinks,
  warmAndBuildPreview,
  checkSourcesHealth
} = require('./features/links/application/auto-link-batch-service');

const { buildWantedChapterNumbers } = require('./features/enqueue/domain/enqueue-utils');
const { resolveEnqueuePrefs } = require('./features/pipeline/application/resolve-enqueue-prefs');
const { startBackgroundEnqueueWorker } = require('./features/pipeline/infra/background-enqueue-worker');
const { runEnqueueBackgroundTask } = require('./features/pipeline/application/enqueue-background-task');
const { EnqueueService } = require('./services/enqueue');

const loadConfig = () => configStore.loadConfig();
const saveConfig = (cfg) => configStore.saveConfig(cfg);
const enqueueService = new EnqueueService();

// TODO(thin-adapter): keep adapter as a facade only.
// If logic starts growing here, move it to a dedicated service/module and re-export.

function moveJarToManagedFolder(sourcePath, managedDir, keepOriginal) {
  if (!sourcePath || !managedDir) return sourcePath;
  require('fs').mkdirSync(managedDir, { recursive: true });

  if (keepOriginal) {
    const path = require('path');
    const fs = require('fs');
    const targetPath = path.join(managedDir, path.basename(sourcePath));
    if (path.resolve(sourcePath) === path.resolve(targetPath)) return targetPath;
    fs.copyFileSync(sourcePath, targetPath);
    return targetPath;
  }

  return moveJarToManaged(sourcePath, managedDir);
}

function makeApiClient(baseUrl, opts = {}) {
  return suwayomiApi.makeApiClient(baseUrl, opts);
}


async function getSources() {
  const cfg = loadConfig();
  const apiUrl = cfg.apiUrl || 'http://localhost:4567';
  const client = makeApiClient(apiUrl, { timeout: Math.max(5000, Number(cfg.apiTimeoutMs || 30000)) });
  return suwayomiApi.listSources(client);
}

async function enqueueFromList(options = {}) {
  return enqueueService.enqueueFromList(options);
}

async function runSmartEnqueue(item, options = {}) {
  return enqueueService.runSmartEnqueue(item, options);
}

module.exports = {
  // Config and validation
  loadConfig,
  saveConfig,
  applyConfigValues,
  isConfigComplete,
  syncServerConf,
  quotePathForHocon,

  // Utilities
  postGraphQL,
  moveJarToManagedFolder,

  // AniList / Sync
  fetchAniList,
  fetchAniListMediaById,
  fetchUserList,

  // Suwayomi API pass-through
  makeApiClient,
  listSources: suwayomiApi.listSources,
  searchSource: suwayomiApi.searchSource,
  addMangaToLibrary: suwayomiApi.addMangaToLibrary,
  queueChapter: suwayomiApi.queueChapter,
  getMangaChapters: suwayomiApi.getMangaChapters,
  getDownloadsState: suwayomiApi.getDownloadsState,
  waitForDownloadsToFinish: suwayomiApi.waitForDownloadsToFinish,
  startSuwayomiJar,
  waitForSuwayomiReady,

  // Runtime lifecycle
  startServer,
  stopServer,
  startKomga,
  stopKomga,
  stopDownloads,
  waitForKomgaReady,
  waitForDownloadsAndSyncKomga,
  isServerRunning,
  isKomgaRunning,

  // Links/autolink
  listMangaItemsForManualLink,
  searchManualLinkCandidates,
  getManualLinkRuntimeStatus,
  getCachedAutoLinkCandidates,
  getAutoLinkCandidates,
  buildBatchAutoLinkPreview,
  warmAutoLinkCache,
  computeBatchTransparency,
  collectAutoSelectedKeys,
  saveSelectedLinks,
  warmAndBuildPreview,
  checkSourcesHealth,
  setManualLink,
  removeManualLink,

  // Enqueue
  enqueueFromList,
  runSmartEnqueue,
  buildWantedChapterNumbers,
  resolveEnqueuePrefs,

  // Komga management
  organizeDownloadsForKomga,
  ensureKomgaLibraryExists,
  triggerKomgaLibraryScan,
  triggerKomgaMetadataRefresh,
  syncKomgaSeriesMetadataFromLocal,

  // Monitoring/background tasks
  getDownloadsOverview,
  startBackgroundEnqueueWorker,
  runEnqueueBackgroundTask,

  // Cleanup
  deleteReadChaptersByAniList,

  // Backward-compatible aliases
  updateListFromAniList: fetchUserList
};
