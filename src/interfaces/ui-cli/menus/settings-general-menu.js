const fs = require('fs');
const path = require('path');
const os = require('os');

module.exports = function createSettingsGeneralMenu(deps) {
  const {
    presenter,
    ensurePrompt,
    pickFolderWithExplorer,
    chooseJarPath
  } = deps;

  function findJarInBin(dataDir, matcher) {
    const binDir = path.join(dataDir, 'bin');
    if (!fs.existsSync(binDir)) return '';
    const entries = fs.readdirSync(binDir, { withFileTypes: true });
    const jars = entries
      .filter(e => e.isFile() && /\.jar$/i.test(e.name))
      .map(e => e.name)
      .filter(name => matcher.test(name))
      .sort();
    if (!jars.length) return '';
    return path.join(binDir, jars[0]);
  }

  async function ensureManagedJars(state, prompt, downloadsDir) {
    const managedJarDir = path.join(state.dataDir, 'bin');
    fs.mkdirSync(managedJarDir, { recursive: true });

    let suwayomiJar = state.jarPath;
    if (!suwayomiJar || !fs.existsSync(suwayomiJar)) {
      suwayomiJar = findJarInBin(state.dataDir, /suwayomi/i);
    }
    if (!suwayomiJar) {
      suwayomiJar = await chooseJarPath(prompt, 'Suwayomi', /suwayomi/i, '', downloadsDir);
    }
    if (!suwayomiJar) throw new Error('JAR do Suwayomi nao informado.');
    state.jarPath = presenter.moveJarToManagedFolder(suwayomiJar, managedJarDir, true);

    let komgaJar = state.komgaJarPath;
    if (!komgaJar || !fs.existsSync(komgaJar)) {
      komgaJar = findJarInBin(state.dataDir, /komga/i);
    }
    if (!komgaJar) {
      komgaJar = await chooseJarPath(prompt, 'Komga', /komga/i, '', downloadsDir);
    }
    if (!komgaJar) throw new Error('JAR do Komga nao informado.');
    state.komgaJarPath = presenter.moveJarToManagedFolder(komgaJar, managedJarDir, true);
  }

  function buildChoices(state) {
    return [
      { name: `Pasta base: ${state.dataDir}`, value: 'dataDir' },
      { name: `Usar pasta do Suwayomi para o Komga: ${state.komgaUseDownloadsAsLibrary ? 'sim' : 'nao'}`, value: 'komgaUseDownloadsAsLibrary' },
      { name: `Auto sync Komga: ${state.komgaSyncOnStart ? 'sim' : 'nao'}`, value: 'komgaSyncOnStart' },
      { name: `Usuario AniList: ${state.usernameAnilist || '(vazio)'}`, value: 'usernameAnilist' },
      { name: `Capitulos a frente: ${state.capsAhead}`, value: 'capsAhead' },
      { name: 'Salvar e voltar', value: 'save' },
      { name: 'Voltar sem salvar', value: 'back' }
    ];
  }

  async function settingsGeneralMenu() {
    const prompt = ensurePrompt();
    const cfg = presenter.loadConfig();
    const downloadsDir = path.join(os.homedir(), 'Downloads');
    const state = {
      dataDir: cfg.dataDir || path.join(os.homedir(), 'MangaPipeline'),
      jarPath: cfg.jarPath || '',
      komgaJarPath: cfg.komgaJarPath || '',
      komgaUseDownloadsAsLibrary: cfg.komgaUseDownloadsAsLibrary !== false,
      komgaSyncOnStart: cfg.komgaSyncOnStart !== false,
      usernameAnilist: cfg.usernameAnilist || '',
      capsAhead: Number(cfg.capsAhead) || 5,
      maxSourcesInParallel: Number(cfg.maxSourcesInParallel) || 6,
      maxSourcesToTryForSearch: Number(cfg.maxSourcesToTryForSearch) || 10,
      suwayomiWebUIEnabled: Boolean(cfg.suwayomiWebUIEnabled),
      serverBindIp: String(cfg.serverBindIp || '0.0.0.0').trim() || '0.0.0.0'
    };

    while (true) {
      const answer = await prompt([
        {
          type: 'list',
          name: 'act',
          message: 'Config geral (edite o que quiser)',
          pageSize: 15,
          choices: buildChoices(state)
        }
      ]);

      if (answer.act === 'back') return;

      if (answer.act === 'save') {
        try {
          await ensureManagedJars(state, prompt, downloadsDir);
        } catch (e) {
          console.log(`Configuracao nao salva: ${e.message}`);
          continue;
        }

        const updated = presenter.applyConfigValues({
          ...cfg,
          ...state,
          downloadsPath: path.join(state.dataDir, 'downloads'),
          komgaDataDir: path.join(state.dataDir, 'komga'),
          komgaLibraryPath: path.join(state.dataDir, 'komga-library'),
          komgaUrl: 'http://localhost:25600',
          komgaOrganizeMode: 'hardlink',
          komgaCreateGhostFolders: false,
          komgaCreateSeriesMetadata: true,
          komgaCreateSeriesCover: true,
          komgaAutoLibraryName: 'mangas-Suwayomi',
          defaultSource: 'anilist'
        });

        console.log('Configuracao concluida.');
        console.log('Suwayomi JAR:', updated.jarPath);
        console.log('Komga JAR:', updated.komgaJarPath);
        console.log('Data:', updated.dataDir);
        console.log('Downloads:', updated.downloadsPath);
        console.log('Usar pasta do Suwayomi para o Komga:', updated.komgaUseDownloadsAsLibrary !== false ? 'sim' : 'nao');
        console.log('Auto sync Komga:', updated.komgaSyncOnStart !== false ? 'sim' : 'nao');
        return;
      }

      if (answer.act === 'dataDir') {
        const pickedDataDir = pickFolderWithExplorer('Escolha a pasta base do aplicativo');
        if (pickedDataDir) state.dataDir = pickedDataDir;
        continue;
      }

      if (answer.act === 'komgaUseDownloadsAsLibrary') {
        state.komgaUseDownloadsAsLibrary = !state.komgaUseDownloadsAsLibrary;
        continue;
      }

      if (answer.act === 'komgaSyncOnStart') {
        state.komgaSyncOnStart = !state.komgaSyncOnStart;
        continue;
      }

      if (answer.act === 'usernameAnilist') {
        const a = await prompt([{ name: 'value', message: 'Usuario AniList padrao', default: state.usernameAnilist || '' }]);
        state.usernameAnilist = String(a.value || '').trim();
        continue;
      }

      if (answer.act === 'capsAhead') {
        const a = await prompt([
          {
            name: 'value',
            message: 'Quantos capitulos a frente baixar por manga',
            default: state.capsAhead,
            validate: (v) => {
              const n = Number(v);
              return Number.isFinite(n) && n >= 1 ? true : 'Digite um numero >= 1';
            }
          }
        ]);
        state.capsAhead = Number(a.value) || 5;
        continue;
      }
    }
  }

  return { settingsGeneralMenu };
};
