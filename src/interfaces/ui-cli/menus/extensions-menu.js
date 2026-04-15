const {
  loadConfig,
  startServer
} = require('../../../features/config/infra/config-store');
const {
  listRepos,
  addRepo,
  removeRepos,
  fetchRepoIndexes,
  getServerExtensions,
  installPackages
} = require('../../../features/extensions/application/extensions-api');
const { ensurePrompt } = require('../input/prompt');
const ui = require('../feedback/ui-enhancements');

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

  while (true) {
    ui.separator('📦 Repositórios de Extensões');

    const repos = listRepos();
    console.log(`${ui.colors.muted('  Repositórios configurados:')} ${ui.colors.info(repos.length)}`);
    if (repos.length) {
      repos.forEach((r, i) => {
        console.log(`  ${String(i + 1).padStart(2)}. ${ui.colors.success(r)}`);
      });
    } else {
      console.log(`  ${ui.colors.warning('(nenhum repositório configurado)')}`);
    }
    console.log('');

    const action = await prompt([
      {
        type: 'list',
        name: 'act',
        message: ui.colors.primary('🎯 Gerenciar Repositórios'),
        choices: [
          { name: `${ui.colors.success('➕ ')} Adicionar repositório`, value: 'add' },
          { name: `${ui.colors.error('➖ ')} Remover repositórios`, value: 'remove' },
          { name: `${ui.colors.warning('🔍 ')} Validar índices`, value: 'validate' },
          '---',
          { name: `${ui.colors.muted('◀️ ')} Voltar`, value: 'back' }
        ]
      }
    ]);

    if (action.act === 'back') {
      ui.separator();
      return;
    }

    if (action.act === 'add') {
      ui.separator('Adicionar Repositório');
      const ans = await prompt([{ name: 'url', message: `${ui.colors.primary('📝')} URL do repositório` }]);
      if (!ans.url) {
        ui.NotificationManager.instance.warning('URL não informada');
        ui.separator();
        continue;
      }
      try {
        addRepo(ans.url);
        ui.NotificationManager.instance.success('Repositório adicionado!');
      } catch (e) {
        ui.NotificationManager.instance.error(`Falha: ${e.message}`);
      }
      ui.separator();
      continue;
    }

    if (action.act === 'remove') {
      ui.separator('Remover Repositórios');
      const repos = listRepos();
      if (!repos.length) {
        ui.NotificationManager.instance.warning('Nenhum repositório configurado');
        ui.separator();
        continue;
      }

      const pick = await prompt([
        {
          type: 'checkbox',
          name: 'selected',
          message: `${ui.colors.warning('Selecione os repositórios para remover')}`,
          choices: repos.map(r => ({ name: r, value: r }))
        }
      ]);

      if (!pick.selected || !pick.selected.length) {
        ui.NotificationManager.instance.info('Nenhum selecionado');
        ui.separator();
        continue;
      }

      try {
        removeRepos(pick.selected);
        ui.NotificationManager.instance.success(`${pick.selected.length} repositório(s) removido(s)`);
      } catch (e) {
        ui.NotificationManager.instance.error(`Falha: ${e.message}`);
      }
      ui.separator();
      continue;
    }

    if (action.act === 'validate') {
      ui.separator('🔍 Validação de Índices');
      const rows = await ui.withSpinner('Verificando repositórios', async () => {
        return await fetchRepoIndexes();
      });

      if (!rows.length) {
        ui.NotificationManager.instance.warning('Nenhum repositório configurado');
        ui.separator();
        continue;
      }

      let okCount = 0;
      let failCount = 0;

      rows.forEach(row => {
        if (row.ok) {
          console.log(`  ${ui.colors.success('✓')} ${row.repo} => ${row.isArray ? `entries=${row.size}` : `keys=${row.size}`}`);
          okCount++;
        } else {
          console.log(`  ${ui.colors.error('✗')} ${row.repo} => ${row.error}`);
          failCount++;
        }
      });

      console.log('');
      ui.separator('📊 Resultado');
      console.log(`  Total: ${ui.colors.info(rows.length)}`);
      console.log(`  ${ui.colors.success('OK:')} ${okCount}`);
      console.log(`  ${ui.colors.error('FALHAS:')} ${failCount}`);
      ui.separator();
      continue;
    }
  }
}

async function manageExtensionsServerUI() {
  const prompt = ensurePrompt();

  while (true) {
    ui.separator('📦 Extensões do Servidor');

    const action = await prompt([
      {
        type: 'list',
        name: 'act',
        message: ui.colors.primary('🎯 Gerenciar Extensões'),
        choices: [
          { name: `${ui.colors.info('📋 ')} Listar extensões instaladas`, value: 'list' },
          { name: `${ui.colors.success('⬇️ ')} Instalar extensões`, value: 'install' },
          '---',
          { name: `${ui.colors.muted('◀️ ')} Voltar`, value: 'back' }
        ]
      }
    ]);

    if (action.act === 'back') {
      ui.separator();
      return;
    }

    if (action.act === 'list') {
      ui.separator('📋 Extensões Instaladas');
      try {
        const exts = await ui.withSpinner('Carregando extensões', async () => {
          return await getServerExtensions();
        });

        if (!Array.isArray(exts) || !exts.length) {
          ui.NotificationManager.instance.info('Nenhuma extensão retornada pelo servidor');
        } else {
          const installed = exts.filter(e => e && e.installed);
          console.log(`Total: ${ui.colors.info(exts.length)} | Instaladas: ${ui.colors.success(installed.length)}`);
          console.log('');
          installed.slice(0, 50).forEach((e, i) => {
            console.log(`  ${i + 1}. ${ui.colors.primary(e.name)} [${ui.colors.info(e.lang)}] (${ui.colors.muted(e.pkgName)})`);
          });
          if (installed.length > 50) {
            console.log(`  ... e mais ${installed.length - 50} extensões`);
          }
        }
      } catch (e) {
        ui.NotificationManager.instance.error(`Falha ao listar: ${e.message}`);
      }
      ui.separator();
      continue;
    }

    if (action.act === 'install') {
      ui.separator('⬇️ Instalar Extensões');
      try {
        const exts = await ui.withSpinner('Buscando extensões disponíveis', async () => {
          return await getServerExtensions();
        });

        const allEntries = (Array.isArray(exts) ? exts : [])
          .filter(e => e && e.pkgName && !e.installed)
          .map(e => ({ pkg: e.pkgName, name: e.name, lang: e.lang || 'all' }));

        if (!allEntries.length) {
          ui.NotificationManager.instance.info('Todas as extensões já estão instaladas');
          ui.separator();
          continue;
        }

        console.log(`${ui.colors.muted('Disponíveis:')} ${ui.colors.info(allEntries.length)} extensões`);
        const queryAns = await prompt([{ name: 'q', message: `${ui.colors.primary('🔍')} Filtro (opcional)`, default: '' }]);
        const q = String(queryAns.q || '').toLowerCase().trim();
        const filtered = q ? allEntries.filter(e => `${e.name} ${e.pkg}`.toLowerCase().includes(q)) : allEntries;
        const shown = filtered.slice(0, 120);

        if (!shown.length) {
          ui.NotificationManager.instance.warning('Nenhuma extensão encontrada com esse filtro');
          ui.separator();
          continue;
        }

        const pick = await prompt([
          {
            type: 'checkbox',
            name: 'pkgs',
            message: `${ui.colors.warning('Selecione até 20 extensões')}`,
            choices: shown.map(e => ({ name: `${e.name} [${ui.colors.info(e.lang)}] (${ui.colors.muted(e.pkg)})`, value: e.pkg }))
          }
        ]);

        const selected = (pick.pkgs || []).slice(0, 20);
        if (!selected.length) {
          ui.NotificationManager.instance.info('Nenhuma extensão selecionada');
          ui.separator();
          continue;
        }

        const result = await ui.withSpinner(`Instalando ${selected.length} extensões`, async () => {
          return await installPackages(selected);
        });

        let ok = 0;
        let fail = 0;
        result.forEach(r => {
          if (r.ok) {
            ok += 1;
            console.log(`  ${ui.colors.success('✓')} ${r.pkg} (HTTP ${r.status || 200})`);
          } else {
            fail += 1;
            console.log(`  ${ui.colors.error('✗')} ${r.pkg}: ${r.error || 'erro'}`);
          }
        });
        ui.NotificationManager.instance.success(`Instalação: ${ui.colors.success(ok)} sucessos, ${fail > 0 ? ui.colors.error(fail) : '0'} falhas`);
      } catch (e) {
        ui.NotificationManager.instance.error(`Falha: ${e.message}`);
      }
      ui.separator();
      continue;
    }
  }
}

async function manageExtensionsUI() {
  const prompt = ensurePrompt();

  while (true) {
    ui.separator('📦 Gerenciamento de Extensões');

    const action = await prompt([
      {
        type: 'list',
        name: 'act',
        message: ui.colors.primary('🎯 Menu de Extensões'),
        choices: [
          { name: `${ui.colors.warning('📦 ')} Repositórios`, value: 'repos' },
          { name: `${ui.colors.success('⬇️ ')} Extensões do Servidor`, value: 'server' },
          '---',
          { name: `${ui.colors.muted('◀️ ')} Voltar`, value: 'back' }
        ]
      }
    ]);

    if (action.act === 'back') {
      ui.separator();
      return;
    }

    if (action.act === 'repos') {
      await manageRepositoriesUI();
      continue;
    }

    if (action.act === 'server') {
      try {
        await ensureSuwayomiForExtensions();
        await manageExtensionsServerUI();
      } catch (e) {
        ui.NotificationManager.instance.error(e.message);
      }
      continue;
    }
  }
}

module.exports = {
  manageExtensionsUI
};
