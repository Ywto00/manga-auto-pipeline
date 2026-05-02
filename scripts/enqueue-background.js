const axios = require('axios');
const fs = require('fs');
const path = require('path');

const { loadConfig, fetchUserList, enqueueFromList } = require('../src/cli-logic');
const { resolveEnqueuePrefs } = require('../src/UI/menus/enqueue-prefs');

const WORKER_LOG_PATH = path.resolve(__dirname, 'enqueue-background.log');

function appendWorkerLog(level, message) {
  const line = `[${new Date().toISOString()}] [${level}] ${message}\n`;
  try {
    fs.appendFileSync(WORKER_LOG_PATH, line, 'utf8');
  } catch (e) {
    // ignore log write failures
  }
}

const originalLog = console.log;
const originalErr = console.error;
console.log = (...args) => {
  const msg = args.map(x => String(x)).join(' ');
  appendWorkerLog('INFO', msg);
  originalLog(...args);
};
console.error = (...args) => {
  const msg = args.map(x => String(x)).join(' ');
  appendWorkerLog('ERROR', msg);
  originalErr(...args);
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function describeError(err) {
  if (!err) return 'erro-desconhecido';
  if (err instanceof Error && err.message && String(err.message).trim()) {
    return String(err.message).trim();
  }
  if (typeof err === 'string' && err.trim()) {
    return err.trim();
  }
  if (err && typeof err === 'object') {
    const code = err.code ? String(err.code) : '';
    const msg = err.message ? String(err.message).trim() : '';
    if (msg) return msg;
    if (code) return `codigo=${code}`;
    try {
      return JSON.stringify(err);
    } catch (e) {
      return String(err);
    }
  }
  return String(err);
}

async function waitForSuwayomiApi(apiUrl, timeoutMs = 90000, intervalMs = 1000) {
  const startedAt = Date.now();
  const base = String(apiUrl || 'http://localhost:4567').replace(/\/$/, '');
  const healthUrl = `${base}/api/v1/source`;

  while (Date.now() - startedAt < timeoutMs) {
    try {
      await axios.get(healthUrl, { timeout: 3000, validateStatus: () => true });
      return true;
    } catch (e) {
      await sleep(intervalMs);
    }
  }

  return false;
}

async function run() {
  const cfg = loadConfig();
  const username = String(cfg.usernameAnilist || '').trim();
  if (!username) {
    console.error('[ENQUEUE-BG] Usuario AniList nao configurado.');
    process.exitCode = 1;
    return;
  }

  const apiUrl = cfg.apiUrl || 'http://localhost:4567';
  console.log(`[ENQUEUE-BG] Aguardando Suwayomi ficar pronto em ${apiUrl}...`);
  const ready = await waitForSuwayomiApi(apiUrl, 90000, 1000);
  if (!ready) {
    console.error('[ENQUEUE-BG] Suwayomi nao respondeu a tempo. Tente iniciar novamente em alguns segundos.');
    process.exitCode = 1;
    return;
  }

  console.log(`[LIST] Buscando lista AniList de ${username}...`);
  const { mapped, readingLike } = await fetchUserList('anilist', username);
  console.log(`[LIST] Total=${mapped.length}, em leitura/pausado=${readingLike.length}`);

  const prefs = resolveEnqueuePrefs(cfg);
  console.log('[ENQUEUE] Iniciando enqueue com base no progresso do AniList...');

  const { output, stats, notFound } = await enqueueFromList({
    dry: false,
    priority: prefs.priority,
    allowedLangs: prefs.allowedLangs,
    sourceOrderIds: prefs.sourceOrderIds,
    limit: 200,
    onItem: (row) => {
      if (row.skipped) {
        const why = row.reason || 'already-processed';
        console.log(`[SKIP] ${row.item.title} (${why})`);
        return;
      }

      if (row.ok) {
        const r = row.result;
        console.log(`[RUN] ${row.item.title} => ${r.source.name} / ${r.manga.title} / indexes=${r.queuedChapterIndexes.join(',')}`);
      } else {
        console.log(`[FAIL] ${row.item.title}: ${row.error}`);
      }
    }
  });

  const ok = output.filter((x) => x.ok).length;
  const failed = output.filter((x) => x.ok === false).length;
  console.log(`[ENQUEUE] Summary: success=${ok}, failed=${failed}`);
  if (stats) {
    console.log(`[ENQUEUE] Stats: eligible=${stats.eligibleCount}, alreadyProcessed=${stats.skippedAlreadyProcessed}, processingNow=${stats.processedCount}`);
  }

  if (Array.isArray(notFound) && notFound.length) {
    console.log('[ENQUEUE] Nao encontrados com sugestoes:');
    notFound.slice(0, 20).forEach((nf, i) => {
      console.log(`${i + 1}. ${nf.title}`);
      const suggestions = nf.details && Array.isArray(nf.details.suggestionsBySource)
        ? nf.details.suggestionsBySource
        : [];
      suggestions.forEach((s) => {
        const titles = (s.titles || []).slice(0, 5).join(' | ');
        console.log(`   ${s.sourceName} [${s.lang}] -> ${titles}`);
      });
    });
  }

  console.log('[ENQUEUE-BG] Processo finalizado.');
}

run().catch((e) => {
  console.error('[ENQUEUE-BG] Falha:', describeError(e));
  if (e && e.report) {
    console.error(`[ENQUEUE-BG] Diagnostico: tentativas=${Number(e.report.attemptsTotal || 0)}, trocasFonte=${Number(e.report.sourceSwitches || 0)}`);
    if (Array.isArray(e.report.warnings) && e.report.warnings.length) {
      e.report.warnings.slice(0, 5).forEach((w, i) => {
        console.error(`  [WARN ${i + 1}] ${w}`);
      });
    }
  }
  process.exitCode = 1;
});
