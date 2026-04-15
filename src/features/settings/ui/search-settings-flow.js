const ui = require('../../../interfaces/ui-cli/feedback/ui-enhancements');

async function runSearchSettingsFlow(deps) {
  const {
    presenter,
    ensurePrompt
  } = deps;

  function buildChoices(state) {
    return [
      { name: `${ui.colors.warning('🔢 ')} Max fontes por pesquisa: ${ui.colors.info(state.maxSourcesToTryForSearch)}`, value: 'maxSourcesToTryForSearch' },
      { name: `${ui.colors.info('⏱️ ')} Timeout API (segundos): ${ui.colors.info(Math.round(state.apiTimeoutMs / 1000))}`, value: 'apiTimeoutMs' },
      '---',
      { name: `${ui.colors.success('💾 ')} Salvar e voltar`, value: 'save' },
      { name: `${ui.colors.error('↩️ ')} Voltar`, value: 'back' }
    ];
  }

  const prompt = ensurePrompt();
  try {
    const cfg = presenter.loadConfig();

    const state = {
      maxSourcesToTryForSearch: Number(cfg.maxSourcesToTryForSearch || 15),
      apiTimeoutMs: Math.max(10000, Number(cfg.apiTimeoutMs || 30000))
    };

    while (true) {
      ui.separator('🔍 Busca');

      const action = await prompt([
        {
          type: 'list',
          name: 'act',
          message: ui.colors.primary('🎯 Config de Busca'),
          pageSize: 15,
          choices: buildChoices(state)
        }
      ]);

      if (action.act === 'back') {
        ui.separator();
        return;
      }

      if (action.act === 'save') {
        ui.separator();
        const next = {
          ...cfg,
          maxSourcesToTryForSearch: state.maxSourcesToTryForSearch,
          apiTimeoutMs: state.apiTimeoutMs
        };
        presenter.saveConfig(next);
        ui.NotificationManager.instance.success('Configuração salva!');
        console.log('');
        console.log(`${ui.colors.primary('📋')} Resumo:`);
        console.log(`  ${ui.colors.muted('Max fontes:')} ${ui.colors.success(next.maxSourcesToTryForSearch)}`);
        console.log(`  ${ui.colors.muted('Timeout API:')} ${ui.colors.info(Math.round(next.apiTimeoutMs / 1000))} segundos`);
        return;
      }

      if (action.act === 'maxSourcesToTryForSearch') {
        const ans = await prompt([
          {
            name: 'value',
            message: `${ui.colors.warning('🔢')} Max fontes por pesquisa (recomendado: 10-20)`,
            default: state.maxSourcesToTryForSearch,
            validate: (v) => {
              const n = Number(v);
              return Number.isFinite(n) && n >= 1 && n <= 50 ? true : `${ui.colors.error('Erro:')} Digite entre 1 e 50`;
            }
          }
        ]);
        state.maxSourcesToTryForSearch = Math.max(1, Math.min(50, Number(ans.value) || state.maxSourcesToTryForSearch));
        ui.NotificationManager.instance.success(`Max fontes: ${state.maxSourcesToTryForSearch}`);
        continue;
      }

      if (action.act === 'apiTimeoutMs') {
        const ans = await prompt([
          {
            name: 'value',
            message: `${ui.colors.info('🌐')} Timeout API (segundos, minimo 10s)`,
            default: Math.round(state.apiTimeoutMs / 1000),
            validate: (v) => {
              const n = Number(v);
              return Number.isFinite(n) && n >= 10 ? true : `${ui.colors.error('Erro:')} Digite um numero >= 10`;
            }
          }
        ]);
        state.apiTimeoutMs = Math.max(10000, Number(ans.value) * 1000 || state.apiTimeoutMs);
        ui.NotificationManager.instance.success(`Timeout: ${Math.round(state.apiTimeoutMs / 1000)} segundos`);
        continue;
      }
    }
  } catch (e) {
    ui.NotificationManager.instance.error(`Falha em Search settings: ${e.message}`);
  }
}

module.exports = {
  runSearchSettingsFlow
};
