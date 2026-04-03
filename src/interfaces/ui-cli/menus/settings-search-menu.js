module.exports = function createSettingsSearchMenu(deps) {
  const {
    presenter,
    ensurePrompt
  } = deps;

  function buildChoices(state) {
    return [
      { name: `Max fontes por pesquisa: ${state.maxSourcesToTryForSearch}`, value: 'maxSourcesToTryForSearch' },
      { name: `Max extensoes no auto-link: ${state.maxExtensionsForAutoLink}`, value: 'maxExtensionsForAutoLink' },
      { name: `TTL cache (min): ${state.linkCacheTtlMinutes}`, value: 'linkCacheTtlMinutes' },
      { name: `Timeout API (ms): ${state.apiTimeoutMs}`, value: 'apiTimeoutMs' },
      { name: `Retries no enqueue: ${state.enqueueRetryAttempts}`, value: 'enqueueRetryAttempts' },
      { name: `Persistir troca de fonte: ${state.persistSwitchedSourceLink ? 'sim' : 'nao'}`, value: 'persistSwitchedSourceLink' },
      { name: `Fonte fixa: ${state.fixedSourceId || '(desativada)'}`, value: 'fixedSourceId' },
      { name: `Match rigido: ${state.strictTitleMatch ? 'sim' : 'nao'}`, value: 'strictTitleMatch' },
      { name: `Score minimo: ${state.strictMinScore}`, value: 'strictMinScore' },
      { name: `Idiomas preferidos: ${state.preferredSearchLangs.join(', ') || '(todos)'}`, value: 'preferredSearchLangs' },
      { name: 'Salvar e voltar', value: 'save' },
      { name: 'Voltar sem salvar', value: 'back' }
    ];
  }

  async function settingsSearchMenu() {
    const prompt = ensurePrompt();
    try {
      const cfg = presenter.loadConfig();
      let sources = [];
      try {
        sources = await presenter.getSources();
      } catch (e) {
        console.log('[SEARCH] Nao foi possivel listar fontes no servidor agora. Ajustando configuracoes basicas mesmo assim.');
      }
      const sourceChoices = [{ name: 'Desativar fonte fixa (usar auto)', value: '' }].concat(
        (sources || []).map(s => ({ name: `${s.name} [${s.lang}] (${s.id})`, value: String(s.id) }))
      );
      const langChoices = [...new Set((sources || []).map(s => String(s.lang || '').toLowerCase()).filter(Boolean))]
        .sort()
        .map(l => ({ name: l, value: l }));

      const state = {
        maxSourcesToTryForSearch: Number(cfg.maxSourcesToTryForSearch || 10),
        maxExtensionsForAutoLink: Number(cfg.maxExtensionsForAutoLink || 12),
        linkCacheTtlMinutes: Number(cfg.linkCacheTtlMinutes || 720),
        apiTimeoutMs: Math.max(5000, Number(cfg.apiTimeoutMs || 30000)),
        enqueueRetryAttempts: Math.max(1, Math.min(5, Number(cfg.enqueueRetryAttempts || 3))),
        persistSwitchedSourceLink: cfg.persistSwitchedSourceLink !== false,
        fixedSourceId: String(cfg.fixedSourceId || '').trim(),
        strictTitleMatch: cfg.strictTitleMatch !== false,
        strictMinScore: Number(cfg.strictMinScore || 88),
        preferredSearchLangs: Array.isArray(cfg.preferredSearchLangs)
          ? cfg.preferredSearchLangs.map(x => String(x || '').toLowerCase()).slice(0, 5)
          : []
      };

      while (true) {
        const action = await prompt([
          {
            type: 'list',
            name: 'act',
            message: 'Config de pesquisa (edite o que quiser)',
            pageSize: 15,
            choices: buildChoices(state)
          }
        ]);

        if (action.act === 'back') return;

        if (action.act === 'save') {
          const next = {
            ...cfg,
            maxSourcesToTryForSearch: state.maxSourcesToTryForSearch,
            maxExtensionsForAutoLink: state.maxExtensionsForAutoLink,
            linkCacheTtlMinutes: state.linkCacheTtlMinutes,
            apiTimeoutMs: state.apiTimeoutMs,
            enqueueRetryAttempts: state.enqueueRetryAttempts,
            persistSwitchedSourceLink: state.persistSwitchedSourceLink,
            fixedSourceId: state.fixedSourceId,
            strictTitleMatch: state.strictTitleMatch,
            strictMinScore: state.strictTitleMatch ? state.strictMinScore : Number(cfg.strictMinScore || 88),
            preferredSearchLangs: state.preferredSearchLangs
          };
          presenter.saveConfig(next);
          console.log('[SEARCH] Configuracao salva.');
          console.log(`[SEARCH] Max fontes: ${next.maxSourcesToTryForSearch}`);
          console.log(`[SEARCH] Max extensoes no auto-link: ${next.maxExtensionsForAutoLink}`);
          console.log(`[SEARCH] TTL cache: ${next.linkCacheTtlMinutes} min`);
          console.log(`[SEARCH] Timeout API: ${next.apiTimeoutMs} ms`);
          console.log(`[SEARCH] Retries enqueue: ${next.enqueueRetryAttempts}`);
          console.log(`[SEARCH] Persistir troca de fonte: ${next.persistSwitchedSourceLink ? 'sim' : 'nao'}`);
          console.log(`[SEARCH] Fonte fixa: ${next.fixedSourceId || '(desativada)'}`);
          console.log(`[SEARCH] Match rigido: ${next.strictTitleMatch ? 'sim' : 'nao'} (minScore=${Number(next.strictMinScore || 88)})`);
          console.log(`[SEARCH] Idiomas preferidos: ${(next.preferredSearchLangs || []).join(', ') || '(todos)'}`);
          return;
        }

        if (action.act === 'maxSourcesToTryForSearch') {
          const ans = await prompt([
            {
              name: 'value',
              message: 'Maximo de fontes por pesquisa automatica (1-50)',
              default: state.maxSourcesToTryForSearch,
              validate: (v) => {
                const n = Number(v);
                return Number.isFinite(n) && n >= 1 && n <= 50 ? true : 'Digite um numero entre 1 e 50';
              }
            }
          ]);
          state.maxSourcesToTryForSearch = Number(ans.value) || state.maxSourcesToTryForSearch;
          continue;
        }

        if (action.act === 'maxExtensionsForAutoLink') {
          const ans = await prompt([
            {
              name: 'value',
              message: 'Max de extensoes/fontes no auto-link (1-50)',
              default: state.maxExtensionsForAutoLink,
              validate: (v) => {
                const n = Number(v);
                return Number.isFinite(n) && n >= 1 && n <= 50 ? true : 'Digite um numero entre 1 e 50';
              }
            }
          ]);
          state.maxExtensionsForAutoLink = Number(ans.value) || state.maxExtensionsForAutoLink;
          continue;
        }

        if (action.act === 'linkCacheTtlMinutes') {
          const ans = await prompt([
            {
              name: 'value',
              message: 'TTL do cache de sugestoes (minutos, minimo 10)',
              default: state.linkCacheTtlMinutes,
              validate: (v) => {
                const n = Number(v);
                return Number.isFinite(n) && n >= 10 ? true : 'Digite um numero >= 10';
              }
            }
          ]);
          state.linkCacheTtlMinutes = Number(ans.value) || state.linkCacheTtlMinutes;
          continue;
        }

        if (action.act === 'apiTimeoutMs') {
          const ans = await prompt([
            {
              name: 'value',
              message: 'Timeout das chamadas da API (ms, minimo 5000)',
              default: state.apiTimeoutMs,
              validate: (v) => {
                const n = Number(v);
                return Number.isFinite(n) && n >= 5000 ? true : 'Digite um numero >= 5000';
              }
            }
          ]);
          state.apiTimeoutMs = Math.max(5000, Number(ans.value) || state.apiTimeoutMs);
          continue;
        }

        if (action.act === 'enqueueRetryAttempts') {
          const ans = await prompt([
            {
              name: 'value',
              message: 'Tentativas de retry no enqueue (1-5)',
              default: state.enqueueRetryAttempts,
              validate: (v) => {
                const n = Number(v);
                return Number.isFinite(n) && n >= 1 && n <= 5 ? true : 'Digite um numero entre 1 e 5';
              }
            }
          ]);
          state.enqueueRetryAttempts = Math.max(1, Math.min(5, Number(ans.value) || state.enqueueRetryAttempts));
          continue;
        }

        if (action.act === 'persistSwitchedSourceLink') {
          state.persistSwitchedSourceLink = !state.persistSwitchedSourceLink;
          continue;
        }

        if (action.act === 'fixedSourceId') {
          if (sourceChoices.length > 1) {
            const ans = await prompt([
              {
                type: 'list',
                name: 'value',
                message: 'Fonte fixa para pesquisa (mais rapido)',
                choices: sourceChoices,
                default: state.fixedSourceId || ''
              }
            ]);
            state.fixedSourceId = String(ans.value || '').trim();
          } else {
            const ans = await prompt([
              {
                name: 'value',
                message: 'Fonte fixa (sourceId) - opcional, deixe vazio para auto',
                default: state.fixedSourceId || ''
              }
            ]);
            state.fixedSourceId = String(ans.value || '').trim();
          }
          continue;
        }

        if (action.act === 'strictTitleMatch') {
          state.strictTitleMatch = !state.strictTitleMatch;
          continue;
        }

        if (action.act === 'strictMinScore') {
          const ans = await prompt([
            {
              name: 'value',
              message: 'Score minimo do match de titulo (60-99)',
              default: state.strictMinScore,
              validate: (v) => {
                const n = Number(v);
                return Number.isFinite(n) && n >= 60 && n <= 99 ? true : 'Digite um numero entre 60 e 99';
              }
            }
          ]);
          state.strictMinScore = Number(ans.value) || state.strictMinScore;
          continue;
        }

        if (action.act === 'preferredSearchLangs') {
          if (langChoices.length > 0) {
            const ans = await prompt([
              {
                type: 'checkbox',
                name: 'langs',
                message: 'Idiomas preferidos para pesquisar (max 5; vazio = todos)',
                choices: langChoices,
                default: state.preferredSearchLangs,
                validate: (arr) => {
                  const size = Array.isArray(arr) ? arr.length : 0;
                  return size <= 5 ? true : 'Selecione no maximo 5 idiomas';
                }
              },
              {
                name: 'langsText',
                message: 'Idiomas por texto (ex: pt-br,en). Se preencher, sobrescreve checkbox',
                default: ''
              }
            ]);

            const fromText = String(ans.langsText || '')
              .split(',')
              .map(x => String(x || '').trim().toLowerCase())
              .filter(Boolean)
              .slice(0, 5);

            state.preferredSearchLangs = fromText.length
              ? fromText
              : (Array.isArray(ans.langs) ? ans.langs.map(x => String(x || '').toLowerCase()).slice(0, 5) : []);
          } else {
            const ans = await prompt([
              {
                name: 'langsText',
                message: 'Idiomas por texto (ex: pt-br,en). Vazio = todos',
                default: state.preferredSearchLangs.join(',')
              }
            ]);
            state.preferredSearchLangs = String(ans.langsText || '')
              .split(',')
              .map(x => String(x || '').trim().toLowerCase())
              .filter(Boolean)
              .slice(0, 5);
          }
        }
      }
    } catch (e) {
      console.error('Falha em Search settings:', e.message);
    }
  }

  return { settingsSearchMenu };
};
