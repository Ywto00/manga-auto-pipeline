const { manageExtensionsFlow } = require('../../../services/extensions/extensions-orchestrator');

async function manageExtensionsUI() {
  const prompt = ensurePrompt();

  const result = await manageExtensionsFlow({
    prompt,
    ui
  });

  if (!result.success) {
    ui.NotificationManager.instance.error(`Erro ao gerenciar extensões: ${result.error}`);
  }
}

module.exports = { manageExtensionsUI };
;
