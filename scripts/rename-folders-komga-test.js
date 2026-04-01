const fs = require('fs');
const path = require('path');
const minimist = require('minimist');

const CONFIG_PATH = path.join(__dirname, '..', 'data', 'config.json');

function loadConfig() {
  try {
    const txt = fs.readFileSync(CONFIG_PATH, 'utf8') || '{}';
    return JSON.parse(txt);
  } catch (e) {
    return {};
  }
}

function toKomgaFolderName(name) {
  return String(name || '')
    .replace(/[<>:"/\\|?*]+/g, ' ')
    .replace(/[._-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.\s]+$/g, '');
}

function uniqueTargetName(root, desired, originalName) {
  if (!desired || desired === originalName) return desired;
  let candidate = desired;
  let idx = 2;
  while (fs.existsSync(path.join(root, candidate))) {
    candidate = `${desired} (${idx})`;
    idx += 1;
  }
  return candidate;
}

function walkFilesRecursively(root) {
  const out = [];
  const stack = [root];
  while (stack.length) {
    const cur = stack.pop();
    const entries = fs.readdirSync(cur, { withFileTypes: true });
    for (const e of entries) {
      const full = path.join(cur, e.name);
      if (e.isDirectory()) {
        stack.push(full);
      } else {
        out.push(full);
      }
    }
  }
  return out;
}

function extractChapterToken(fileNameWithoutExt) {
  const matches = String(fileNameWithoutExt || '').match(/\d+(?:\.\d+)?/g);
  if (!matches || !matches.length) return null;

  const raw = matches[matches.length - 1];
  if (raw.includes('.')) {
    const [left, right] = raw.split('.');
    const padded = left.padStart(3, '0');
    return `${padded}.${right}`;
  }

  return raw.padStart(3, '0');
}

function buildTargetBaseName(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const base = path.basename(filePath, ext);
  const parentFolder = path.basename(path.dirname(filePath));
  const series = toKomgaFolderName(parentFolder);
  const chapter = extractChapterToken(base);
  if (!series || !chapter) return null;
  return `${series} - c${chapter}`;
}

function uniqueFilePath(dir, desiredBase, ext, originalName) {
  let candidate = `${desiredBase}${ext}`;
  if (candidate === originalName) return candidate;

  let idx = 2;
  while (fs.existsSync(path.join(dir, candidate))) {
    candidate = `${desiredBase} (${idx})${ext}`;
    idx += 1;
  }
  return candidate;
}

function main() {
  const argv = minimist(process.argv.slice(2), {
    boolean: ['apply', 'help'],
    string: ['path'],
    alias: { h: 'help' },
    default: { apply: false }
  });

  if (argv.help) {
    console.log('Uso: node scripts/rename-folders-komga-test.js [--apply]');
    console.log('Renomeia .cbz para: "Nome da Pasta - cNNN.cbz".');
    console.log('O capitulo e extraido da ultima sequencia numerica no nome do .cbz.');
    console.log('Este script roda SOMENTE em downloadsPath do data/config.json.');
    console.log('Sem --apply: apenas preview (dry-run).');
    process.exit(0);
  }

  const cfg = loadConfig();
  const targetRoot = path.resolve(String(cfg.downloadsPath || ''));
  const apply = Boolean(argv.apply);

  if (argv.path) {
    console.error('[ERRO] --path desativado. Este script so pode rodar na pasta de downloads configurada.');
    process.exit(1);
  }

  if (!targetRoot || targetRoot === path.resolve('.')) {
    console.error('[ERRO] downloadsPath nao configurado em data/config.json.');
    process.exit(1);
  }

  if (!fs.existsSync(targetRoot)) {
    console.error(`[ERRO] Pasta nao encontrada: ${targetRoot}`);
    process.exit(1);
  }

  const allFiles = walkFilesRecursively(targetRoot);
  const cbzFiles = allFiles.filter(f => path.extname(f).toLowerCase() === '.cbz');

  if (!cbzFiles.length) {
    console.log(`[INFO] Nenhum .cbz para renomear em: ${targetRoot}`);
    process.exit(0);
  }

  const plan = [];
  for (const filePath of cbzFiles) {
    const ext = path.extname(filePath).toLowerCase();
    const dir = path.dirname(filePath);
    const oldName = path.basename(filePath);
    const desiredBase = buildTargetBaseName(filePath);
    if (!desiredBase) continue;

    const newName = uniqueFilePath(dir, desiredBase, ext, oldName);
    if (!newName || newName === oldName) continue;

    plan.push({
      from: filePath,
      to: path.join(dir, newName),
      oldName,
      newName
    });
  }

  console.log(`[DOWNLOADS-RENAME] Pasta alvo: ${targetRoot}`);
  console.log(`[DOWNLOADS-RENAME] Modo: ${apply ? 'APPLY' : 'DRY-RUN'}`);
  console.log(`[DOWNLOADS-RENAME] CBZ encontrados: ${cbzFiles.length}`);
  console.log(`[DOWNLOADS-RENAME] Renomes planejados: ${plan.length}`);

  if (!plan.length) {
    console.log('[DOWNLOADS-RENAME] Nada para alterar.');
    process.exit(0);
  }

  plan.forEach((r, i) => {
    console.log(`${String(i + 1).padStart(2, '0')}. ${r.oldName} -> ${r.newName}`);
  });

  if (!apply) {
    console.log('[DOWNLOADS-RENAME] Dry-run finalizado. Use --apply para executar.');
    process.exit(0);
  }

  let ok = 0;
  let fail = 0;
  for (const r of plan) {
    try {
      fs.renameSync(r.from, r.to);
      ok += 1;
    } catch (e) {
      fail += 1;
      console.log(`[FAIL] ${r.oldName} -> ${r.newName} | ${e.message}`);
    }
  }

  console.log(`[DOWNLOADS-RENAME] Concluido. sucesso=${ok}, falhas=${fail}`);
}

main();
