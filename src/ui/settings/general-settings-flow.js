const fs = require('fs');
const path = require('path');
const os = require('os');
const ui = require('../../interfaces/ui-cli/feedback/ui-enhancements');
const { ensureManagedJars, getDefaultState, computeFinalConfig, validateDataDir } = require('../../services/settings-service');

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
  const state = getDefaultState(cfg);

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

        const updated = presenter.applyConfigValues(computeFinalConfig(cfg, state));

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
      let pickedDataDir = await ui.withSpinner('TENTANDO explorador de arquivos...', () => pickFolderWithExplorer('Escolha a pasta base do aplicativo'));

      if (!pickedDataDir) {
        const a = await prompt([
          {
            name: 'value',
            message: `${ui.colors.primary('⌨️')} Explorador falhou ou cancelado. Digite o caminho completo da pasta base:`,
            default: state.dataDir,
            validate: (v) => {
              const res = validateDataDir(v);
              return res.ok ? true : `${ui.colors.error('Erro:')} ${res.error}`;
            }
          }
        ]);
        pickedDataDir = a.value;
      }

      if (pickedDataDir) {
        const final = validateDataDir(pickedDataDir);
        if (final.ok) {
          state.dataDir = final.path;
          ui.NotificationManager.instance.success(`Pasta base atualizada: ${state.dataDir}`);
        } else {
          ui.NotificationManager.instance.error(`Pasta inválida: ${final.error}`);
        }
      }
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
