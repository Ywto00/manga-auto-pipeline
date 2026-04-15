const fs = require('fs');
const path = require('path');
const os = require('os');
const ui = require('../../../interfaces/ui-cli/feedback/ui-enhancements');

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

async function ensureManagedJars(state, prompt, downloadsDir, presenter, chooseJarPath) {
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
    { name: `${ui.colors.primary('📁 ')} Pasta base: ${ui.colors.info(state.dataDir)}`, value: 'dataDir' },
    { name: `${ui.colors.primary('👤 ')} Usuario AniList: ${state.usernameAnilist ? ui.colors.success(state.usernameAnilist) : ui.colors.muted('(vazio)')}`, value: 'usernameAnilist' },
    { name: `${ui.colors.info('🌐 ')} WebUI Suwayomi: ${state.suwayomiWebUIEnabled ? ui.colors.success('ativada') : ui.colors.muted('desativada')}`, value: 'suwayomiWebUIEnabled' },
    { name: `${ui.colors.info('🪟 ')} Abrir WebUI ao iniciar: ${state.suwayomiOpenWebUIOnStart ? ui.colors.success('sim') : ui.colors.muted('não')}`, value: 'suwayomiOpenWebUIOnStart' },
    { name: `${ui.colors.warning('⚡ ')} Modo Download: ${ui.colors.success(state.downloadMode === 'aggressive' ? 'AGGRESSIVE (max performance)' : state.downloadMode === 'auto' ? 'AUTO (recomendado)' : 'MANUAL')}`, value: 'downloadMode' },
    { name: `${ui.colors.info('📈 ')} Caps download manual (range): ${ui.colors.info(state.manualRange)}`, value: 'manualRange' },
    '---',
    { name: `${ui.colors.success('🚀 ')} Salvar e voltar`, value: 'save' },
    { name: `${ui.colors.error('↩️ ')} Voltar`, value: 'back' }
  ];
}

async function runGeneralSettingsFlow(deps) {
  const {
    presenter,
    ensurePrompt,
    pickFolderWithExplorer,
    chooseJarPath
  } = deps;

  const prompt = ensurePrompt();
  const cfg = presenter.loadConfig();
  const downloadsDir = path.join(os.homedir(), 'Downloads');
  const state = {
    dataDir: cfg.dataDir || path.join(os.homedir(), 'MangaPipeline'),
    usernameAnilist: cfg.usernameAnilist || '',
    suwayomiWebUIEnabled: cfg.suwayomiWebUIEnabled !== false,
    suwayomiOpenWebUIOnStart: cfg.suwayomiOpenWebUIOnStart === true,
    downloadMode: cfg.downloadMode || 'auto', // 'auto' | 'aggressive' | 'manual'
    manualRange: Number(cfg.manualRange) || 15 // range de caps para download manual (5-30)
  };

  while (true) {
    ui.separator('⚙️ Configurações Gerais');

    const answer = await prompt([
      {
        type: 'list',
        name: 'act',
        message: ui.colors.primary('🎯 Config Geral'),
        pageSize: 15,
        choices: buildChoices(state)
      }
    ]);

    if (answer.act === 'back') {
      ui.separator();
      return;
    }

    if (answer.act === 'save') {
      ui.separator();
      try {
        await ui.withSpinner('Verificando JARs', async () => {
          await ensureManagedJars(state, prompt, downloadsDir, presenter, chooseJarPath);
        });

        const updated = presenter.applyConfigValues({
          ...cfg,
          ...state,
          suwayomiWebUIEnabled: state.suwayomiWebUIEnabled,
          suwayomiOpenWebUIOnStart: state.suwayomiOpenWebUIOnStart,
          downloadMode: state.downloadMode,
          manualRange: state.manualRange,
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

        ui.NotificationManager.instance.success('Configuração salva!');
        console.log('');
        console.log(`${ui.colors.primary('📋')} Resumo:`);
        console.log(`  ${ui.colors.muted('Pasta base:')} ${ui.colors.info(updated.dataDir)}`);
        console.log(`  ${ui.colors.muted('AniList:')} ${ui.colors.success(state.usernameAnilist || '(não configurado)')}`);
        console.log(`  ${ui.colors.muted('WebUI Suwayomi:')} ${state.suwayomiWebUIEnabled ? ui.colors.success('ativada') : ui.colors.error('desativada')}`);
        console.log(`  ${ui.colors.muted('Abrir WebUI no start:')} ${state.suwayomiOpenWebUIOnStart ? ui.colors.success('sim') : ui.colors.muted('não')}`);
        console.log(`  ${ui.colors.muted('Modo download:')} ${state.downloadMode === 'aggressive' ? ui.colors.success('AGGRESSIVE (max performance)') : state.downloadMode === 'auto' ? ui.colors.info('AUTO (recomendado)') : ui.colors.warning('MANUAL')}`);
        if (state.downloadMode === 'manual') {
          console.log(`  ${ui.colors.muted('Range manual:')} ${ui.colors.info(state.manualRange)} caps`);
        }
        return;
      } catch (e) {
        ui.NotificationManager.instance.error(`Falha: ${e.message}`);
        continue;
      }
    }

    if (answer.act === 'dataDir') {
      const pickedDataDir = await ui.withSpinner('Selecionando pasta', () => pickFolderWithExplorer('Escolha a pasta base do aplicativo'));
      if (pickedDataDir) state.dataDir = pickedDataDir;
      continue;
    }

    if (answer.act === 'usernameAnilist') {
      const a = await prompt([{ name: 'value', message: `${ui.colors.primary('👤')} Usuario AniList`, default: state.usernameAnilist || '' }]);
      state.usernameAnilist = String(a.value || '').trim();
      ui.NotificationManager.instance.success(state.usernameAnilist ? `Usuario: ${state.usernameAnilist}` : 'Usuario removido');
      continue;
    }

    if (answer.act === 'suwayomiWebUIEnabled') {
      const a = await prompt([
        {
          type: 'confirm',
          name: 'value',
          message: `${ui.colors.info('🌐')} Ativar WebUI do Suwayomi?`,
          default: state.suwayomiWebUIEnabled
        }
      ]);
      state.suwayomiWebUIEnabled = Boolean(a.value);
      ui.NotificationManager.instance.success(`WebUI ${state.suwayomiWebUIEnabled ? 'ativada' : 'desativada'}`);
      continue;
    }

    if (answer.act === 'suwayomiOpenWebUIOnStart') {
      const a = await prompt([
        {
          type: 'confirm',
          name: 'value',
          message: `${ui.colors.info('🪟')} Abrir WebUI automaticamente ao iniciar pipeline?`,
          default: state.suwayomiOpenWebUIOnStart
        }
      ]);
      state.suwayomiOpenWebUIOnStart = Boolean(a.value);
      ui.NotificationManager.instance.success(`Abrir WebUI no start: ${state.suwayomiOpenWebUIOnStart ? 'sim' : 'não'}`);
      continue;
    }

    if (answer.act === 'downloadMode') {
      const modeAns = await prompt([
        {
          type: 'list',
          name: 'mode',
          message: `${ui.colors.warning('⚡')} Selecione o modo de download`,
          choices: [
            { name: `${ui.colors.info('🤖 ')} AUTO - Sistema decide automaticamente (recomendado)`, value: 'auto' },
            { name: `${ui.colors.success('🚀 ')} AGGRESSIVE - Máximo desempenho (usa 100% PC/internet)`, value: 'aggressive' },
            { name: `${ui.colors.warning('🎯 ')} MANUAL - Escolher range por manga`, value: 'manual' }
          ]
        }
      ]);
      state.downloadMode = modeAns.mode;
      ui.NotificationManager.instance.success(state.downloadMode === 'auto' ? 'Modo: AUTO' : state.downloadMode === 'aggressive' ? 'Modo: AGGRESSIVE (máximo!)' : 'Modo: MANUAL');
      continue;
    }

    if (answer.act === 'manualRange') {
      const a = await prompt([
        {
          name: 'value',
          message: `${ui.colors.warning('📈')} Range de caps para download manual (5-30)`,
          default: state.manualRange,
          validate: (v) => {
            const n = Number(v);
            return Number.isFinite(n) && n >= 5 && n <= 30 ? true : `${ui.colors.error('Erro:')} Digite um numero entre 5 e 30`;
          }
        }
      ]);
      state.manualRange = Math.max(5, Math.min(30, Number(a.value) || state.manualRange));
      ui.NotificationManager.instance.success(`Range manual: ${state.manualRange} caps`);
      continue;
    }
  }
}

module.exports = {
  runGeneralSettingsFlow
};
