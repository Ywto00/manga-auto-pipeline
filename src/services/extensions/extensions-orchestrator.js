/**
 * Extensions orchestration service.
 * Handles the UI-driven flows for managing extension repositories and installing packages.
 */
const {
  listRepos,
  addRepo,
  removeRepos,
  fetchRepoIndexes,
  getServerExtensions,
  installPackages
} = require('../extensions-service');

async function manageExtensionsFlow(deps) {
  const {
    prompt,
    ui
  } = deps;

  try {
    let repos = listRepos();
    let extensions = await getServerExtensions();

    const mainChoice = await prompt([
      {
        type: 'list',
        name: 'action',
        message: 'Gerenciar Extensões',
        choices: [
          { name: 'Listar Repositórios', value: 'list_repos' },
          { name: 'Adicionar Repositório', value: 'add_repo' },
          { name: 'Remover Repositórios', value: 'remove_repos' },
          { name: 'Instalar Pacotes de Repositórios', value: 'install_pkgs' },
          { name: 'Sair', value: 'exit' }
        ]
      }
    ]);

    if (mainChoice.action === 'exit') return { success: true, action: 'exit' };

    switch (mainChoice.action) {
      case 'list_repos': {
        ui.separator('📦 Repositórios Configurados');
        if (repos.length === 0) {
          console.log('  Nenhum repositório configurado.');
        } else {
          repos.forEach((r, i) => console.log(`  ${i + 1}. ${r}`));
        }
        break;
      }
      case 'add_repo': {
        const ans = await prompt([{ name: 'url', message: 'URL do novo repositório' }]);
        if (ans.url) {
          const newRepos = addRepo(ans.url);
          ui.NotificationManager.instance.success(`Repositório ${ans.url} adicionado.`);
        } else {
          ui.NotificationManager.instance.warning('URL não informada.');
        }
        break;
      }
      case 'remove_repos': {
        if (repos.length === 0) {
          ui.NotificationManager.instance.warning('Nenhum repositório para remover.');
          break;
        }
        const ans = await prompt([
          {
            type: 'checkbox',
            name: 'urls',
            message: 'Selecione os repositórios para remover',
            choices: repos.map(r => ({ name: r, value: r }))
          }
        ]);
        if (ans.urls && ans.urls.length > 0) {
          removeRepos(ans.urls);
          ui.NotificationManager.instance.success(`${ans.urls.length} repositórios removidos.`);
        }
        break;
      }
      case 'install_pkgs': {
        ui.NotificationManager.instance.info('Buscando índices dos repositórios...');
        const indexes = await fetchRepoIndexes();
        const allPkgs = [];
        const repoMap = {};

        indexes.forEach(idx => {
          if (idx.ok && idx.isArray) {
            idx.data.forEach(pkg => {
              if (pkg && typeof pkg === 'string') {
                allPkgs.push(pkg);
                repoMap[pkg] = idx.repo;
              }
            });
          }
        });

        if (allPkgs.length === 0) {
          ui.NotificationManager.instance.warning('Nenhum pacote disponível nos repositórios.');
          break;
        }

        const ans = await prompt([
          {
            type: 'checkbox',
            name: 'pkgs',
            message: 'Selecione os pacotes para instalar',
            choices: allPkgs.map(p => ({ name: p, value: p }))
          }
        ]);

        if (ans.pkgs && ans.pkgs.length > 0) {
          ui.NotificationManager.instance.info(`Instalando ${ans.pkgs.length} pacotes...`);
          const results = await installPackages(ans.pkgs);

          results.forEach(res => {
            if (res.ok) {
              console.log(`  ${ui.colors.success('✓')} ${res.pkg} (HTTP ${res.status})`);
            } else {
              console.log(`  ${ui.colors.error('✗')} ${res.pkg}: ${res.error}`);
            }
          });
        }
        break;
      }
    }

    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

module.exports = { manageExtensionsFlow };
