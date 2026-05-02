const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

// -----------------------------
// Platform-specific helpers
// -----------------------------

function _runPowerShell(script) {
  try {
    return execFileSync('powershell.exe', ['-NoProfile', '-STA', '-Command', script], { encoding: 'utf8' }).trim();
  } catch (e) {
    return '';
  }
}

function _runCommand(cmd, args, opts = {}) {
  try {
    const res = spawnSync(cmd, args, Object.assign({ encoding: 'utf8' }, opts));
    if (res && res.status === 0 && res.stdout) return String(res.stdout).trim();
    return '';
  } catch (e) {
    return '';
  }
}

function _pickFileWindows(title, filter, initialDirectory) {
  const script = [
    'Add-Type -AssemblyName System.Windows.Forms',
    '$d = New-Object System.Windows.Forms.OpenFileDialog',
    `$d.Title = '${String(title).replace(/'/g, "''")}'`,
    `$d.Filter = '${String(filter).replace(/'/g, "''")}'`,
    '$d.Multiselect = $false',
    ...(initialDirectory ? [`$d.InitialDirectory = '${String(initialDirectory).replace(/'/g, "''")}'`] : []),
    'if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $d.FileName }'
  ].join('; ');
  return _runPowerShell(script);
}

function _pickFolderWindows(title, initialDirectory) {
  const script = [
    'Add-Type -AssemblyName System.Windows.Forms',
    '$d = New-Object System.Windows.Forms.FolderBrowserDialog',
    `$d.Description = '${String(title).replace(/'/g, "''")}'`,
    '$d.ShowNewFolderButton = $true',
    ...(initialDirectory ? [`$d.SelectedPath = '${String(initialDirectory).replace(/'/g, "''")}'`] : []),
    'if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $d.SelectedPath }'
  ].join('; ');
  return _runPowerShell(script);
}

function _pickFileZenity(initialDirectory) {
  const args = ['--file-selection'];
  if (initialDirectory) args.push('--filename=' + initialDirectory + path.sep);
  return _runCommand('zenity', args);
}

function _pickFolderZenity() {
  return _runCommand('zenity', ['--file-selection', '--directory']);
}

function _pickFileKDialog(initialDirectory, title) {
  return _runCommand('kdialog', ['--getopenfilename', initialDirectory || '', '--title', title]);
}

function _pickFolderKDialog(initialDirectory, title) {
  return _runCommand('kdialog', ['--getexistingdirectory', initialDirectory || '', '--title', title]);
}

// -----------------------------
// Public helpers
// -----------------------------

/**
 * Try to open a native file picker. Returns the selected path (string) or empty string.
 * On Linux, prefers `zenity`, falls back to `kdialog` if available.
 */
function pickFileWithExplorer(title = 'Select file', filter = '', initialDirectory = '') {
  if (process.platform === 'win32') return _pickFileWindows(title, filter, initialDirectory) || '';
  if (process.platform === 'linux') {
    const zenity = _runCommand('which', ['zenity']);
    if (zenity) return _pickFileZenity(initialDirectory) || '';
    const kdialog = _runCommand('which', ['kdialog']);
    if (kdialog) return _pickFileKDialog(initialDirectory, title) || '';
  }
  return '';
}

/**
 * Try to open a native folder picker. Returns the selected folder path or empty string.
 */
function pickFolderWithExplorer(title = 'Select folder', initialDirectory = '') {
  if (process.platform === 'win32') return _pickFolderWindows(title, initialDirectory) || '';
  if (process.platform === 'linux') {
    const zenity = _runCommand('which', ['zenity']);
    if (zenity) return _pickFolderZenity() || '';
    const kdialog = _runCommand('which', ['kdialog']);
    if (kdialog) return _pickFolderKDialog(initialDirectory, title) || '';
  }
  return '';
}

/**
 * Find .jar files in a directory that match the provided RegExp `matcher`.
 * Returns absolute paths.
 */
function findJarCandidates(dir, matcher) {
  if (!dir || !fs.existsSync(dir)) return [];
  try {
    return fs.readdirSync(dir)
      .filter(name => name.toLowerCase().endsWith('.jar'))
      .filter(name => matcher.test(name))
      .map(name => path.join(dir, name));
  } catch (e) {
    return [];
  }
}

/**
 * Orchestrates candidate detection, GUI picker and manual fallback.
 * - `prompt` is the inquirer prompt function (already provided by callers)
 * - returns selected path (string)
 */
async function chooseJarPath(prompt, label, matcher, currentPath, downloadsDir) {
  // 1) candidate detection
  const candidates = findJarCandidates(downloadsDir, matcher);
  if (candidates.length > 0) {
    const top = candidates[0];
    const useDetected = await prompt([
      {
        type: 'confirm',
        name: 'yes',
        message: `${label}: use detected JAR in Downloads? (${path.basename(top)})`,
        default: true
      }
    ]);
    if (useDetected.yes) return path.resolve(top);
  }

  // 2) try GUI picker (may return empty string)
  const picked = pickFileWithExplorer(`Select ${label} JAR`, 'JAR files (*.jar)|*.jar', downloadsDir || '');
  if (picked) return path.resolve(picked);

  // 3) fallback to manual input
  const fallback = await prompt([
    {
      name: 'manual',
      message: `${label}: manual path to JAR (leave empty to keep current)`,
      default: currentPath || ''
    }
  ]);
  return fallback.manual ? path.resolve(fallback.manual) : (currentPath ? path.resolve(currentPath) : '');
}

module.exports = {
  pickFolderWithExplorer,
  chooseJarPath,
  pickFileWithExplorer,
  findJarCandidates
};