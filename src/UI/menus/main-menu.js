const {
  loadConfig,
  isConfigComplete,
  stopDownloads,
  stopServer
} = require('../../cli-logic');
const { ensurePrompt } = require('../shared/prompt');
const { configureUI, searchSettingsUI } = require('./settings-menu');
const { startPipelineUI, cleanupReadByAniListUI, organizeKomgaLibraryUI, startKomgaUI } = require('./pipeline-menu');
const { manageExtensionsUI } = require('./extensions-menu');
const { manageManualLinksUI } = require('./links-menu');

async function settingsMenu() {
  const prompt = ensurePrompt();

  while (true) {
    const ans = await prompt([
      {
        type: 'list',
        name: 'act',
        message: 'Configuracoes',
        choices: [
          'Configuracoes gerais',
          'Configuracoes de busca',
          'Gerenciar extensoes',
          'Gerenciar vinculos AniList <-> fontes',
          'Voltar'
        ]
      }
    ]);

    if (ans.act === 'Configuracoes gerais') await configureUI();

    if (ans.act === 'Configuracoes de busca') await searchSettingsUI();

    if (ans.act === 'Gerenciar extensoes') {
      try {
        await manageExtensionsUI();
      } catch (e) {
        console.log('Gerenciar extensoes requer Suwayomi ativo. Inicie o Suwayomi e tente novamente.');
      }
    }

    if (ans.act === 'Gerenciar vinculos AniList <-> fontes') {
      await manageManualLinksUI();
    }

    if (ans.act === 'Voltar') return;
  }
}

async function shutdownAll() {
  try {
    await stopDownloads();
  } catch (e) {
    // ignore
  }

  try {
    await stopServer();
  } catch (e) {
    // ignore
  }
}

async function mainMenu() {
  const prompt = ensurePrompt();
  const cfg = loadConfig();
  if (!isConfigComplete(cfg)) {
    console.log('Primeira execucao sem configuracao completa. Abrindo Configuracoes Gerais...');
    await configureUI();
  }

  while (true) {
    const ans = await prompt([
      {
        type: 'list',
        name: 'act',
        message: 'Menu principal',
        choices: [
          'Configuracoes',
          'Iniciar Suwayomi e downloads',
          'Iniciar Komga',
          'Organizar biblioteca Komga (manual)',
          'Limpar capitulos lidos (AniList)',
          'Cancelar downloads do Suwayomi',
          'Sair (Desligar todos os apps)'
        ]
      }
    ]);

    if (ans.act === 'Configuracoes') await settingsMenu();

    if (ans.act === 'Iniciar Suwayomi e downloads') {
      await startPipelineUI();
    }

    if (ans.act === 'Iniciar Komga') {
      await startKomgaUI();
    }

    if (ans.act === 'Organizar biblioteca Komga (manual)') {
      await organizeKomgaLibraryUI();
    }

    if (ans.act === 'Limpar capitulos lidos (AniList)') {
      await cleanupReadByAniListUI();
    }

    if (ans.act === 'Cancelar downloads do Suwayomi') {
      try {
        await stopDownloads();
        console.log('Downloads do Suwayomi parados.');
      } catch (e) {
        console.log('Falha ao parar downloads do Suwayomi:', e.message);
      }
    }

    if (ans.act === 'Sair (Desligar todos os apps)') {
      await shutdownAll();
      process.exit(0);
    }
  }
}

module.exports = {
  mainMenu
};