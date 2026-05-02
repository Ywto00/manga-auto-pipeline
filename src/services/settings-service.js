/**
 * Settings management service.
 * Handles configuration updates, validation, and JAR management.
 */
const path = require('path');
const os = require('os');
const fs = require('fs');

async function ensureManagedJars(state, prompt, downloadsDir, presenter, chooseJarPath) {
  const managedJarDir = path.join(state.dataDir, 'bin');
  fs.mkdirSync(managedJarDir, { recursive: true });

  let suwayomiJar = state.jarPath;
  if (!suwayomiJar || !fs.existsSync(suwayomiJar)) {
    const binDir = path.join(state.dataDir, 'bin');
    if (fs.existsSync(binDir)) {
      const entries = fs.readdirSync(binDir, { withFileTypes: true });
      const jars = entries
        .filter(e => e.isFile() && /\.jar$/i.test(e.name))
        .map(e => e.name)
        .filter(name => /suwayomi/i.test(name))
        .sort();
      if (jars.length) suwayomiJar = path.join(binDir, jars[0]);
    }
  }
  if (!suwayomiJar) {
    suwayomiJar = await chooseJarPath(prompt, 'Suwayomi', /suwayomi/i, '', downloadsDir);
  }
  if (!suwayomiJar) throw new Error('JAR do Suwayomi nao informado.');
  state.jarPath = presenter.moveJarToManagedFolder(suwayomiJar, managedJarDir, true);

  let komgaJar = state.komgaJarPath;
  if (!komgaJar || !fs.existsSync(komgaJar)) {
    const binDir = path.join(state.dataDir, 'bin');
    if (fs.existsSync(binDir)) {
      const entries = fs.readdirSync(binDir, { withFileTypes: true });
      const jars = entries
        .filter(e => e.isFile() && /\.jar$/i.test(e.name))
        .map(e => e.name)
        .filter(name => /komga/i.test(name))
        .sort();
      if (jars.length) komgaJar = path.join(binDir, jars[0]);
    }
  }
  if (!komgaJar) {
    komgaJar = await chooseJarPath(prompt, 'Komga', /komga/i, '', downloadsDir);
  }
  if (!komgaJar) throw new Error('JAR do Komga nao informado.');
  state.komgaJarPath = presenter.moveJarToManagedFolder(komgaJar, managedJarDir, true);
}

function validateDataDir(dirPath) {
  if (!dirPath) return { ok: false, error: 'Caminho nao informado.' };
  try {
    const resolved = path.resolve(dirPath);
    if (fs.existsSync(resolved) && fs.lstatSync(resolved).isDirectory()) {
      return { ok: true, path: resolved };
    }
    return { ok: false, error: 'O caminho deve ser um diretorio existente.' };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function getDefaultState(cfg) {
  return {
    dataDir: cfg.dataDir || path.join(os.homedir(), 'MangaPipeline'),
    usernameAnilist: cfg.usernameAnilist || '',
    suwayomiWebUIEnabled: cfg.suwayomiWebUIEnabled !== false,
    suwayomiOpenWebUIOnStart: cfg.suwayomiOpenWebUIOnStart === true,
    downloadMode: cfg.downloadMode || 'auto',
    manualRange: Number(cfg.manualRange) || 15,
    maxSourcesToTryForSearch: Number(cfg.maxSourcesToTryForSearch || 15),
    apiTimeoutMs: Math.max(10000, Number(cfg.apiTimeoutMs || 30000))
  };
}

function computeFinalConfig(cfg, state) {
  return {
    ...cfg,
    ...state,
    downloadsPath: path.join(state.dataDir, 'downloads'),
    komgaDataDir: path.join(state.dataDir, 'komga'),
    komgaLibraryPath: path.join(state.dataDir, 'komga-library'),
    komgaUrl: cfg.komgaUrl || 'http://localhost:25600',
    komgaOrganizeMode: cfg.komgaOrganizeMode || 'hardlink',
    komgaCreateGhostFolders: cfg.komgaCreateGhostFolders ?? false,
    komgaCreateSeriesMetadata: cfg.komgaCreateSeriesMetadata ?? true,
    komgaCreateSeriesCover: cfg.komgaCreateSeriesCover ?? true,
    komgaAutoLibraryName: cfg.komgaAutoLibraryName || 'mangas-Suwayomi',
    defaultSource: cfg.defaultSource || 'anilist'
  };
}

module.exports = {
  ensureManagedJars,
  getDefaultState,
  computeFinalConfig,
  validateDataDir
};
