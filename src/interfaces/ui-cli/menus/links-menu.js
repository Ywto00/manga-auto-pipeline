const cliLogic = require('../../../cli-logic-adapter');
const { ensurePrompt } = require('../input/prompt');
const ui = require('../feedback/ui-enhancements');
const {
  viewLinksFlow,
  updateAniListSnapshotFlow,
  runSourceHealthCheckFlow,
  runBatchAutoMatchFlow,
  runManualLinkFlow
} = require('../../../services/links-orchestrator');

// Functions from cli-logic-adapter
const {
  loadConfig,
  listMangaItemsForManualLink
} = cliLogic;

function printLinksConfigSummary(cfg) {
  const langs = Array.isArray(cfg.preferredSearchLangs) && cfg.preferredSearchLangs.length
    ? cfg.preferredSearchLangs.join(',')
    : 'all';
  const sourceLimit = Number(cfg.maxExtensionsForAutoLink || 12);
  const sourceConcurrency = Number(cfg.autoLinkSourceConcurrency || cfg.maxSourcesInParallel || 8);
  const cacheTtl = Number(cfg.linkCacheTtlMinutes || 720);
  const cleanup = cfg.cleanupLibraryDuplicates === true ? 'on' : 'off';
  console.log(`\n[CFG] langs=${langs} | maxSources=${sourceLimit} | parallel=${sourceConcurrency} | cacheTtl=${cacheTtl}m | dedupeLibrary=${cleanup}`);
}

async function manageManualLinksUI(deps) {
  const { prompt, syncService, monitoringService, linksService } = deps;
  const ui = require('../feedback/ui-enhancements');

  try {
    let rows = await listMangaItemsForManualLink(2000);

    while (true) {
      const cfg = loadConfig();
      printLinksConfigSummary(cfg);

      // Create quick stats
      const linked = rows.filter(r => r.linked).length;
      const unlinked = rows.filter(r => !r.linked).length;
      const total = rows.length;

      console.log(ui.colors.muted(`  Stats: ${ui.colors.success(linked + ' vinculados')} | ${ui.colors.error(unlinked + ' sem vínculo')} | Total: ${total}`));
      console.log('');

      const action = await prompt([
        {
          type: 'list',
          name: 'act',
          message: ui.colors.primary('🔗 Gerenciar Vínculos'),
          choices: [
            { name: `${ui.colors.info('📱 ')} Atualizar lista AniList`, value: 'refresh' },
            { name: `${ui.colors.primary('📋 ')} Ver lista completa (${total} itens)`, value: 'view' },
            { name: `${ui.colors.success('⚡ ')} Varredura automática`, value: 'batch' },
            { name: `${ui.colors.warning('🩺 ')} Testar saúde das fontes`, value: 'health' },
            { name: `${ui.colors.warning('🔧 ')} Gerenciar vínculo manual`, value: 'manual' },
            '---',
            { name: `${ui.colors.muted('🔙 ')} Voltar`, value: 'back' }
          ]
        }
      ]);

      if (action.act === 'back') return;

      if (action.act === 'refresh') {
        ui.separator('Atualizar Lista AniList');
        const ok = await ui.withSpinner('Buscando dados da AniList', async () => {
          return await updateAniListSnapshotFlow({ prompt, syncService });
        });
        if (ok.ok) {
          rows = await listMangaItemsForManualLink(2000);
          ui.NotificationManager.instance.success('Lista AniList atualizada!');
        } else {
          ui.NotificationManager.instance.error(`Falha ao atualizar lista: ${ok.error}`);
        }
        ui.separator();
        continue;
      }

      if (action.act === 'view') {
        ui.separator('📋 Lista Completa');
        const result = await viewLinksFlow({ prompt });
        if (!result.ok) {
          ui.NotificationManager.instance.warning(result.error);
        } else {
          const { selected, previewsByKey, viewMode, total, limit } = result.data;
          const width = Math.min(process.stdout.columns || 80, 100);
          const divider = '─'.repeat(width);

          console.log(`${ui.colors.muted('Total:')} ${ui.colors.info(selected.length)} | ${ui.colors.success(selected.filter(r => r.linked).length + ' vinculados')} | ${ui.colors.error(selected.filter(r => !r.linked).length + ' sem vínculo')}`);
          console.log('');
          console.log(ui.colors.muted(divider));

          selected.forEach((r, i) => {
            const preview = previewsByKey.get(String(r.key));
            const linkedScore = r.linked && Number.isFinite(Number(r.linked.score)) ? Number(r.linked.score) : null;
            const matchPct = r.linked
              ? (linkedScore != null ? (linkedScore / 100).toFixed(2) : '--')
              : (preview && preview.best ? (preview.best.score / 100).toFixed(2) : '--');

            const isLinked = Boolean(r.linked);
            const statusIcon = isLinked ? `${ui.colors.success('✓')}` : `${ui.colors.error('✗')}`;

            if (viewMode === 'compact') {
              console.log(`${ui.colors.muted(String(i + 1).padStart(3, ' '))}. ${statusIcon} ${ui.colors.primary(r.item.title.substring(0, width - 15))}`);
              if (isLinked) {
                console.log(`   ${ui.colors.muted('└─')} ${ui.colors.info(r.linked.sourceName || r.linked.sourceId)} / ${ui.colors.success(r.linked.mangaTitle.substring(0, 40))} ${matchPct !== '--' ? ui.colors.muted(`(${matchPct})`) : ''}`);
              } else if (preview && preview.best) {
                console.log(`   ${ui.colors.muted('└─')} ${ui.colors.warning(preview.best.sourceName)} / ${ui.colors.primary(preview.best.mangaTitle.substring(0, 40))} (score=${preview.best.score})${preview.cached ? ' [cache]' : ''}`);
              } else {
                console.log(`   ${ui.colors.muted('└─')} ${ui.colors.error('Nenhuma sugestão disponível')}`);
              }
            } else {
              console.log(`${statusIcon} ${ui.colors.bold(r.item.title.substring(0, width - 10))} [${isLinked ? ui.colors.success('VINCULADO') : ui.colors.error('SEM VÍNCULO')}]`);
              if (Array.isArray(r.item.altTitles) && r.item.altTitles.length) {
                console.log(`   ${ui.colors.muted('Alt:')} ${r.item.altTitles.slice(0, 3).join(' | ')}`);
              }
              if (isLinked) {
                console.log(`   ${ui.colors.muted('Vínculo:')} ${ui.colors.success(r.linked.sourceName || r.linked.sourceId)} / ${ui.colors.primary(r.linked.mangaTitle)} ${matchPct !== '--' ? ui.colors.muted(`[match:${matchPct}]`) : ''}`);
              } else if (preview && preview.best) {
                console.log(`   ${ui.colors.muted('Sugestão:')} ${ui.colors.warning(preview.best.sourceName)} / ${ui.colors.primary(preview.best.mangaTitle)} (score=${preview.best.score})${preview.cached ? ' [cache]' : ''}`);
              } else {
                console.log(`   ${ui.colors.muted('Sugestão:')} ${ui.colors.error('Nenhuma sugestão disponível')}`);
              }
            }
            if (i < selected.length - 1) console.log('');
          });
          console.log('');
          console.log(ui.colors.muted(divider));
          if (rows.length > limit) {
            console.log(`${ui.colors.warning('⚠️')} Mostrando ${limit} de ${rows.length} itens. Use um limite maior para ver mais.`);
          }
        }
        ui.separator();
        continue;
      }

      if (action.act === 'batch') {
        ui.separator('⚡ Varredura Automática');
        rows = await listMangaItemsForManualLink(2000);
        if (!rows.length) {
          ui.NotificationManager.instance.warning('Nenhum item elegível encontrado');
        } else {
          const result = await runBatchAutoMatchFlow({ prompt, linksService });
          if (result.ok) {
            ui.NotificationManager.instance.success(`Lote concluído: ${result.matchedCount} vínculos adicionados`);
          } else {
            ui.NotificationManager.instance.error(`Erro na varredura: ${result.error}`);
          }
        }
        ui.separator();
        continue;
      }

      if (action.act === 'health') {
        ui.separator('🩺 Saúde das Fontes');
        const result = await runSourceHealthCheckFlow({ prompt, monitoringService });
        if (result.ok) {
          ui.NotificationManager.instance.success('Teste de saúde concluído');
        } else {
          ui.NotificationManager.instance.error(`Erro no check de saúde: ${result.error}`);
        }
        ui.separator();
        continue;
      }

      if (action.act === 'manual') {
        ui.separator('🔧 Gerenciamento Manual');
        rows = await listMangaItemsForManualLink(2000);
        if (!rows.length) {
          ui.NotificationManager.instance.warning('Nenhum item elegível encontrado');
        } else {
          const result = await runManualLinkFlow({ prompt });
          if (result.ok) {
            if (result.action === 'removed') {
              ui.NotificationManager.instance.success(`Removido: ${result.item.title}`);
            } else if (result.action === 'linked') {
              ui.NotificationManager.instance.success(`Vinculado: ${result.item.title}`);
            } else if (result.action === 'back') {
              // do nothing
            } else {
              ui.NotificationManager.instance.success('Vínculo atualizado');
            }
          } else {
            ui.NotificationManager.instance.error(`Erro manual: ${result.error}`);
          }
        }
        ui.separator();
        continue;
      }
    }
  } catch (e) {
    ui.NotificationManager.instance.error('Falha no gerenciamento: ' + e.message);
  }
}

module.exports = {
  manageManualLinksUI
};