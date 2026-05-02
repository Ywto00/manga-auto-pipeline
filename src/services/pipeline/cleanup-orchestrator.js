/**
 * Cleanup orchestration service.
 * Handles the process of deleting read chapters based on AniList status.
 */
const {
  deleteReadChaptersByAniList
} = require('../cleanup-service');

async function cleanupReadChaptersFlow(deps) {
  const {
    prompt,
    ui
  } = deps;

  try {
    const ans = await prompt([
      {
        type: 'confirm',
        name: 'dry',
        message: 'Executar em dry-run (apenas mostrar, sem apagar)?',
        default: true
      },
      {
        name: 'limit',
        message: 'Quantidade máxima de mangás para processar',
        default: 200,
        validate: (v) => {
          const n = Number(v);
          return Number.isFinite(n) && n >= 1 ? true : 'Digite um número >= 1';
        }
      }
    ]);

    const dry = Boolean(ans.dry);
    const limit = Number(ans.limit) || 200;

    ui.NotificationManager.instance.info(`Varredura de capítulos lidos (dry=${dry}, limit=${limit})...`);

    const startTime = Date.now();
    const result = await deleteReadChaptersByAniList({
      dry,
      limit
    });

    const elapsed = (Date.now() - startTime) / 1000;

    return {
      success: true,
      elapsed,
      processed: result.processed,
      deletedTotal: result.deletedTotal,
      failedTotal: result.failedTotal,
      skipped: result.skipped
    };
  } catch (e) {
    return {
      success: false,
      error: e.message
    };
  }
}

module.exports = { cleanupReadChaptersFlow };
