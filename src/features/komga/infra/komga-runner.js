/**
 * Komga server runner.
 *
 * Starts and stops the Komga JAR as a subprocess,
 * waits for the web UI to become available,
 * and provides Java argument defaults optimized for Komga.
 */
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const axios = require('axios');

// ---------------------------------------------------------------------------
// JAR process
// ---------------------------------------------------------------------------

/**
 * Starts the Komga JAR as a detached subprocess.
 *
 * @param {Object} cfg
 * @param {string} cfg.komgaJarPath  - Path to the Komga JAR
 * @param {string} cfg.komgaDataDir  - Directory for Komga's config/data
 * @param {string} cfg.komgaUrl      - Base URL (e.g. http://localhost:25600)
 * @param {string[]} [cfg.komgaJavaArgs] - Custom Java VM arguments
 * @param {string[]} [cfg.komgaAppArgs]  - Application arguments after the JAR
 * @returns {{ proc: import('child_process').ChildProcess, komgaUrl: string, ready: boolean, stop: Function }}
 */
async function startKomga(cfg) {
  const managedJarDir = path.join(cfg.dataDir, 'bin');
  fs.mkdirSync(managedJarDir, { recursive: true });
  const jarPath = moveJarToManaged(cfg.komgaJarPath, managedJarDir);

  const dataDir = cfg.komgaDataDir || path.join(cfg.dataDir, 'komga');
  fs.mkdirSync(dataDir, { recursive: true });

  const env = { ...process.env, KOMGA_CONFIGDIR: dataDir };
  const javaArgs = getEffectiveKomgaJavaArgs(cfg.komgaJavaArgs);

  const proc = spawn('java', [...javaArgs, '-jar', jarPath, ...(cfg.komgaAppArgs || [])], {
    cwd: dataDir,
    stdio: 'ignore',
    detached: true,
    env
  });
  proc.unref && proc.unref();

  const ready = await waitForKomgaReady(cfg.komgaUrl, 30000, 1000);
  return { proc, komgaUrl: cfg.komgaUrl, ready, stop: () => { try { proc.kill(); } catch (e) {} } };
}

/**
 * Moves a JAR into the managed bin directory so the app can find it later.
 */
function moveJarToManaged(sourcePath, managedDir) {
  if (!sourcePath) return sourcePath;
  const targetPath = path.join(managedDir, path.basename(sourcePath));
  if (path.resolve(sourcePath) === path.resolve(targetPath)) return targetPath;
  if (fs.existsSync(targetPath)) fs.unlinkSync(targetPath);
  try { fs.renameSync(sourcePath, targetPath); }
  catch (e) { fs.copyFileSync(sourcePath, targetPath); fs.unlinkSync(sourcePath); }
  return targetPath;
}

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------

/**
 * Polls the Komga URL until it responds 200-499 or times out.
 */
async function waitForKomgaReady(komgaUrl, timeoutMs = 30000, intervalMs = 1000) {
  const startAt = Date.now();
  while (Date.now() - startAt < timeoutMs) {
    try {
      const res = await axios.get(komgaUrl, { timeout: 3000, validateStatus: () => true });
      if (res && res.status >= 200 && res.status < 500) return true;
    } catch (e) { /* ignore and retry */ }
    await new Promise(r => setTimeout(r, intervalMs));
  }
  return false;
}

// ---------------------------------------------------------------------------
// Java arguments
// ---------------------------------------------------------------------------

function normalizeJavaArgArray(raw) {
  if (Array.isArray(raw)) return raw.map(x => String(x || '').trim()).filter(Boolean);
  if (typeof raw === 'string') return raw.split(/\s+/).map(x => String(x || '').trim()).filter(Boolean);
  return [];
}

function getEffectiveKomgaJavaArgs(javaArgs) {
  const userArgs = normalizeJavaArgArray(javaArgs);
  if (!userArgs.length) return getDefaultKomgaJavaArgs();

  const hasMemoryArg = userArgs.some(a => /^-Xmx/i.test(a) || /^-Xms/i.test(a) || /^-XX:MaxRAMPercentage=/i.test(a));
  const hasGcArg = userArgs.some(a => /^-XX:\+Use.*GC$/i.test(a) || /^-XX:\+UseStringDeduplication$/i.test(a));
  const hasEncodingArg = userArgs.some(a => /^-D(file\.encoding|sun\.jnu\.encoding)=/i.test(a));

  const effective = userArgs.slice();
  if (!hasGcArg) effective.push('-XX:+UseG1GC', '-XX:+ParallelRefProcEnabled', '-XX:+UseStringDeduplication');
  if (!hasMemoryArg) effective.push('-XX:InitialRAMPercentage=20.0', '-XX:MaxRAMPercentage=70.0');
  if (!hasEncodingArg) effective.push('-Dfile.encoding=UTF-8', '-Dsun.jnu.encoding=UTF-8');
  return effective;
}

function getDefaultKomgaJavaArgs() {
  return [
    '-XX:+UseG1GC',
    '-XX:+ParallelRefProcEnabled',
    '-XX:+UseStringDeduplication',
    '-XX:InitialRAMPercentage=20.0',
    '-XX:MaxRAMPercentage=70.0',
    '-Dfile.encoding=UTF-8',
    '-Dsun.jnu.encoding=UTF-8'
  ];
}

/**
 * Backward-compatible wrapper: startKomgaJar(jarPath, options)
 * Old signature: (path, { java, javaArgs, appArgs, cwd, stdio, detached, env })
 */
function startKomgaJar(jarPath, options = {}) {
  const { spawn } = require('child_process');
  const javaBin = options.java || 'java';
  const args = (options.javaArgs || []).concat(['-jar', jarPath], options.appArgs || []);
  const proc = spawn(javaBin, args, {
    cwd: options.cwd || process.cwd(),
    stdio: options.stdio || 'ignore',
    detached: !!options.detached,
    env: options.env || process.env
  });
  if (!options.detached) proc.unref && proc.unref();
  return {
    proc,
    stop: () => { try { proc.kill(); } catch (e) {} }
  };
}

module.exports = { startKomga, startKomgaJar, waitForKomgaReady, moveJarToManaged, getEffectiveKomgaJavaArgs, getDefaultKomgaJavaArgs };
