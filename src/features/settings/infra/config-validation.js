/**
 * Config validation and persistence.
 *
 * applyConfigValues() applies defaults, validates inputs, and persists
 * both config.json and Suwayomi server.conf in one call.
 */
const path = require('path');
const fs = require('fs');
const { loadConfig, saveConfig, isConfigComplete, syncServerConf } = require('../../config/infra/config-store');
const { moveJarToManaged: _moveJarToManaged } = require('../../komga/infra/komga-runner');

/**
 * Merges new values into the current config, applies defaults,
 * and persists to disk (both config.json and server.conf).
 *
 * @param {Object} values - Partial config values to merge/override
 * @returns {Object} The full merged and validated config
 */
function applyConfigValues(values) {
  const current = loadConfig();
  const cfg = { ...current, ...values };

  // Defaults
  cfg.apiUrl = cfg.apiUrl || 'http://localhost:4567';
  cfg.serverBindIp = String(cfg.serverBindIp || '0.0.0.0').trim() || '0.0.0.0';
  cfg.komgaUrl = cfg.komgaUrl || 'http://localhost:25600';
  cfg.extensionRepos = cfg.extensionRepos || [];

  if (cfg.dataDir) {
    cfg.downloadsPath = cfg.downloadsPath || path.join(cfg.dataDir, 'downloads');
    cfg.komgaDataDir = cfg.komgaDataDir || path.join(cfg.dataDir, 'komga');
    cfg.komgaLibraryPath = cfg.komgaLibraryPath || path.join(cfg.dataDir, 'komga-library');
  }

  cfg.usernameAnilist = cfg.usernameAnilist || '';
  cfg.usernameMal = cfg.usernameMal || '';
  cfg.capsAhead = Number(cfg.capsAhead) || 5;
  cfg.maxSourcesInParallel = Number(cfg.maxSourcesInParallel) || 6;
  cfg.suwayomiWebUIEnabled = Boolean(cfg.suwayomiWebUIEnabled);
  cfg.suwayomiOpenWebUIOnStart = cfg.suwayomiOpenWebUIOnStart === true;

  // Title matching
  cfg.strictTitleMatch = cfg.strictTitleMatch !== false;
  cfg.strictMinScore = Math.max(60, Math.min(99, Number(cfg.strictMinScore || 88)));

  // Link cache
  cfg.linkCacheTtlMinutes = Math.max(10, Number(cfg.linkCacheTtlMinutes || 720));
  cfg.maxExtensionsForAutoLink = Math.max(1, Math.min(50, Number(cfg.maxExtensionsForAutoLink || 12)));
  cfg.cleanupLibraryDuplicates = cfg.cleanupLibraryDuplicates === true;
  cfg.persistSwitchedSourceLink = cfg.persistSwitchedSourceLink !== false;

  // Komga
  cfg.komgaUseDownloadsAsLibrary = cfg.komgaUseDownloadsAsLibrary !== false;
  cfg.komgaSyncOnStart = cfg.komgaSyncOnStart !== false;
  cfg.komgaAutoLibraryName = String(cfg.komgaAutoLibraryName || 'mangas-Suwayomi').trim() || 'mangas-Suwayomi';
  cfg.komgaOrganizeMode = cfg.komgaOrganizeMode === 'copy' ? 'copy' : 'hardlink';
  cfg.komgaCreateGhostFolders = cfg.komgaCreateGhostFolders === true;
  cfg.komgaCreateSeriesMetadata = cfg.komgaCreateSeriesMetadata !== false;
  cfg.komgaCreateSeriesCover = cfg.komgaCreateSeriesCover !== false;

  // Network / retry
  cfg.apiTimeoutMs = Math.max(5000, Number(cfg.apiTimeoutMs || 30000));
  cfg.enqueueRetryAttempts = Math.max(1, Math.min(5, Number(cfg.enqueueRetryAttempts || 2)));

  // Search
  cfg.preferredSearchLangs = Array.isArray(cfg.preferredSearchLangs)
    ? cfg.preferredSearchLangs.map(x => String(x || '').toLowerCase()).filter(Boolean).slice(0, 5)
    : [];

  saveConfig(cfg);
  syncServerConf(cfg);
  return cfg;
}

module.exports = { applyConfigValues, isConfigComplete };
