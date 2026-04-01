const fs = require('fs');
const path = require('path');
const os = require('os');

const {
  loadConfig,
  saveConfig,
  moveJarToManagedFolder,
  applyConfigValues,
  getSources
} = require('../../cli-logic');
const { ensurePrompt } = require('../shared/prompt');
const { pickFolderWithExplorer, chooseJarPath } = require('../shared/explorer-picker');

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
  state.jarPath = moveJarToManagedFolder(suwayomiJar, managedJarDir, true);

  let komgaJar = state.komgaJarPath;
  if (!komgaJar || !fs.existsSync(komgaJar)) {
    komgaJar = findJarInBin(state.dataDir, /komga/i);
  }
  if (!komgaJar) {
    komgaJar = await chooseJarPath(prompt, 'Komga', /komga/i, '', downloadsDir);
  }
  if (!komgaJar) throw new Error('JAR do Komga nao informado.');
  state.komgaJarPath = moveJarToManagedFolder(komgaJar, managedJarDir, true);
}

async function configureUI() {
  const prompt = ensurePrompt();
  const cfg = loadConfig();
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
        choices: [
          { name: `Pasta base: ${state.dataDir}`, value: 'dataDir' },
          { name: `Usar pasta do Suwayomi para o Komga: ${state.komgaUseDownloadsAsLibrary ? 'sim' : 'nao'}`, value: 'komgaUseDownloadsAsLibrary' },
          { name: `Auto sync Komga: ${state.komgaSyncOnStart ? 'sim' : 'nao'}`, value: 'komgaSyncOnStart' },
          { name: `Usuario AniList: ${state.usernameAnilist || '(vazio)'}`, value: 'usernameAnilist' },
          { name: `Capitulos a frente: ${state.capsAhead}`, value: 'capsAhead' },
          { name: 'Salvar e voltar', value: 'save' },
          { name: 'Voltar sem salvar', value: 'back' }
        ]
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

      const updated = applyConfigValues({
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

async function searchSettingsUI() {
  const prompt = ensurePrompt();
  try {
    const cfg = loadConfig();
    let sources = [];
    try {
      sources = await getSources();
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
          choices: [
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
          ]
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
        saveConfig(next);
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

module.exports = {
  configureUI,
  searchSettingsUI
};