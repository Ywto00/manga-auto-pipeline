const fs = require('fs');
const os = require('os');
const path = require('path');

function findJarInBin(dataDir, matcher) {
  const binDir = path.join(dataDir || '', 'bin');
  if (!binDir || !fs.existsSync(binDir)) return '';
  try {
    const entries = fs.readdirSync(binDir, { withFileTypes: true });
    const jars = entries
      .filter(e => e.isFile() && /\.jar$/i.test(e.name))
      .map(e => e.name)
      .filter(name => matcher.test(name))
      .sort();
    if (!jars.length) return '';
    return path.join(binDir, jars[0]);
  } catch (e) {
    return '';
  }
}

async function ensureJarReady(params) {
  const cfg = params.cfg;
  const kind = params.kind;
  const chooseJarPath = params.chooseJarPath;
  const moveJarToManagedFolder = params.moveJarToManagedFolder;
  const applyConfigValues = params.applyConfigValues;
  const prompt = params.prompt;

  const downloadsDir = path.join(os.homedir(), 'Downloads');
  const isKomga = kind === 'komga';
  const current = isKomga ? cfg.komgaJarPath : cfg.jarPath;
  const matcher = isKomga ? /komga/i : /suwayomi/i;
  const productName = isKomga ? 'Komga' : 'Suwayomi';

  let jarPath = current || '';
  if (!jarPath || !fs.existsSync(jarPath)) {
    jarPath = findJarInBin(cfg.dataDir, matcher);
  }

  if (!jarPath) {
    jarPath = await chooseJarPath(prompt, productName, matcher, current || '', downloadsDir);
  }

  if (!jarPath) {
    throw new Error(`${productName} JAR not provided. Please configure a valid path.`);
  }

  const managedJarDir = path.join(cfg.dataDir, 'bin');
  const moved = moveJarToManagedFolder(jarPath, managedJarDir, true);
  return isKomga
    ? applyConfigValues({ komgaJarPath: moved })
    : applyConfigValues({ jarPath: moved });
}

module.exports = {
  findJarInBin,
  ensureJarReady
};
