const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { describeError } = require('./error-utils');

function startBackgroundEnqueueWorker() {
  const workerScriptPath = path.resolve(__dirname, '../../../../scripts/enqueue-background.js');
  const appRoot = path.resolve(__dirname, '../../../..');
  if (!fs.existsSync(workerScriptPath)) {
    return { ok: false, reason: `worker-script-not-found: ${workerScriptPath}` };
  }

  try {
    if (process.platform === 'win32') {
      const nodePath = process.execPath.replace(/'/g, "''");
      const scriptPath = workerScriptPath.replace(/'/g, "''");
      const workDir = appRoot.replace(/'/g, "''");
      const workerCmd = `\"${nodePath}\" \"${scriptPath}\"`;
      const psCommand = `Start-Process -FilePath 'cmd.exe' -WorkingDirectory '${workDir}' -WindowStyle Normal -ArgumentList '/k', '${workerCmd}'`;
      const child = spawn('powershell.exe', ['-NoProfile', '-Command', psCommand], {
        cwd: appRoot,
        detached: true,
        stdio: 'ignore',
        windowsHide: false
      });
      child.unref();
      return { ok: true, pid: child.pid };
    }

    const child = spawn(process.execPath, [workerScriptPath], {
      cwd: appRoot,
      detached: true,
      stdio: 'ignore',
      windowsHide: false
    });
    child.unref();
    return { ok: true, pid: child.pid };
  } catch (e) {
    return { ok: false, reason: describeError(e) };
  }
}

module.exports = {
  startBackgroundEnqueueWorker
};
