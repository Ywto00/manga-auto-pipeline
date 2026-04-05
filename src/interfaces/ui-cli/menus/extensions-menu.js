const {
  loadConfig,
  startServer,
  listRepos,
  addRepo,
  removeRepos,
  fetchRepoIndexes,
  getServerExtensions,
  installPackages
} = require('../../../cli-logic');
const { ensurePrompt } = require('../input/prompt');

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function ensureSuwayomiForExtensions() {
  try {
    await getServerExtensions();
    return;
  } catch (e) {
    // Try auto-start below.
  }

  const cfg = loadConfig();
  if (!cfg.jarPath || !cfg.dataDir) {
    throw new Error('Configure o Suwayomi (JAR e pasta base) em Configuracoes gerais antes de gerenciar extensoes.');
  }

  console.log('[EXT] Suwayomi nao detectado. Iniciando automaticamente...');
  const started = await startServer();
  if (started.ready) {
    console.log('[EXT] Suwayomi pronto para gerenciar extensoes.');
    return;
  }

  // Give server a small extra window before failing the extension flow.
  for (let i = 0; i < 6; i += 1) {
    await sleep(600);
    try {
      await getServerExtensions();
      console.log('[EXT] Suwayomi iniciado e conectado.');
      return;
    } catch (e) {
      // keep retrying
    }
  }

  throw new Error('Suwayomi iniciou em background, mas a API ainda nao respondeu. Tente novamente em alguns segundos.');
}

async function manageRepositoriesUI() {
  const prompt = ensurePrompt();
  const action = await prompt([
    {
      type: 'list',
      name: 'act',
      message: 'Repositorios de extensoes',
      choices: ['Listar repositorios', 'Adicionar repositorio', 'Remover repositorios', 'Validar indexes dos repositorios', 'Voltar']
    }
  ]);

  if (action.act === 'Listar repositorios') {
    const repos = listRepos();
    if (!repos.length) console.log('Nenhum repositorio configurado.');
    repos.forEach((r, i) => console.log(`${i + 1}. ${r}`));
    return;
  }

  if (action.act === 'Adicionar repositorio') {
    const ans = await prompt([{ name: 'url', message: 'URL do repositorio' }]);
    if (!ans.url) return;
    addRepo(ans.url);
    console.log('Repositorio adicionado.');
    return;
  }

  if (action.act === 'Remover repositorios') {
    const repos = listRepos();
    if (!repos.length) {
      console.log('Nenhum repositorio configurado.');
      return;
    }
    const pick = await prompt([
      {
        type: 'checkbox',
        name: 'selected',
        message: 'Selecione repositorios para remover',
        choices: repos
      }
    ]);
    removeRepos(pick.selected || []);
    console.log('Repositorios removidos.');
    return;
  }

  if (action.act === 'Validar indexes dos repositorios') {
    const rows = await fetchRepoIndexes();
    if (!rows.length) {
      console.log('Nenhum repositorio configurado.');
      return;
    }
    rows.forEach(row => {
      if (row.ok) {
        console.log(`OK ${row.repo} => ${row.isArray ? `entries=${row.size}` : `keys=${row.size}`}`);
      } else {
        console.log(`FAIL ${row.repo} => ${row.error}`);
      }
    });
  }
}

async function manageExtensionsServerUI() {
  const prompt = ensurePrompt();
  const action = await prompt([
    {
      type: 'list',
      name: 'act',
      message: 'Extensoes do servidor',
      choices: ['Listar extensoes do servidor', 'Instalar extensoes da lista do servidor', 'Voltar']
    }
  ]);

  if (action.act === 'Listar extensoes do servidor') {
    try {
      const exts = await getServerExtensions();
      if (!Array.isArray(exts) || !exts.length) {
        console.log('Nenhuma extensao retornada pelo servidor.');
        return;
      }

      const installed = exts.filter(e => e && e.installed);
      console.log(`Total=${exts.length}, Installed=${installed.length}`);
      installed.slice(0, 50).forEach((e, i) => {
        console.log(`${i + 1}. ${e.name} [${e.lang}] (${e.pkgName})`);
      });
    } catch (e) {
      console.error('Falha ao listar extensoes:', e.message);
    }
    return;
  }

  if (action.act === 'Instalar extensoes da lista do servidor') {
    try {
      const exts = await getServerExtensions();
      const allEntries = (Array.isArray(exts) ? exts : [])
        .filter(e => e && e.pkgName && !e.installed)
        .map(e => ({ pkg: e.pkgName, name: e.name, lang: e.lang || 'all' }));

      if (!allEntries.length) {
        console.log('Sem extensoes disponiveis para instalar.');
        return;
      }

      const queryAns = await prompt([{ name: 'q', message: 'Filtro por nome/pkg (opcional)', default: '' }]);
      const q = String(queryAns.q || '').toLowerCase().trim();
      const filtered = q ? allEntries.filter(e => `${e.name} ${e.pkg}`.toLowerCase().includes(q)) : allEntries;
      const shown = filtered.slice(0, 120);

      const pick = await prompt([
        {
          type: 'checkbox',
          name: 'pkgs',
          message: 'Escolha extensoes (max 20)',
          choices: shown.map(e => ({ name: `${e.name} [${e.lang}] (${e.pkg})`, value: e.pkg }))
        }
      ]);

      const selected = (pick.pkgs || []).slice(0, 20);
      if (!selected.length) {
        console.log('Nada selecionado.');
        return;
      }

      const result = await installPackages(selected);
      let ok = 0;
      result.forEach(r => {
        if (r.ok) {
          ok += 1;
          console.log(`Installed: ${r.pkg} (HTTP ${r.status || 200})`);
        } else {
          console.log(`Failed: ${r.pkg} ${r.error || ''}`);
        }
      });
      console.log(`Install complete: ${ok}/${selected.length}`);
    } catch (e) {
      console.error('Falha ao instalar extensoes:', e.message);
    }
  }
}

async function manageExtensionsUI() {
  const prompt = ensurePrompt();
  await ensureSuwayomiForExtensions();
  console.log('Gerenciar extensoes: primeiro configure repositorios, depois instale extensoes.');
  while (true) {
    const action = await prompt([
      {
        type: 'list',
        name: 'act',
        message: 'Gerenciamento de extensoes',
        choices: ['Repositorios', 'Extensoes', 'Voltar']
      }
    ]);

    if (action.act === 'Repositorios') await manageRepositoriesUI();
    if (action.act === 'Extensoes') await manageExtensionsServerUI();
    if (action.act === 'Voltar') return;
  }
}

module.exports = {
  manageExtensionsUI
};