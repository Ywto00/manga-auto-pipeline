const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

function runPowerShell(script) {
  try {
    return execFileSync('powershell.exe', ['-NoProfile', '-STA', '-Command', script], { encoding: 'utf8' }).trim();
  } catch (e) {
    return '';
  }
}

function pickFileWithExplorer(title = 'Select JAR', filter = 'JAR files (*.jar)|*.jar', initialDirectory = '') {
  if (process.platform !== 'win32') return '';
  const script = [
    'Add-Type -AssemblyName System.Windows.Forms',
    '$d = New-Object System.Windows.Forms.OpenFileDialog',
    `$d.Title = '${title.replace(/'/g, "''")}'`,
    `$d.Filter = '${filter.replace(/'/g, "''")}'`,
    '$d.Multiselect = $false',
    ...(initialDirectory ? [`$d.InitialDirectory = '${initialDirectory.replace(/'/g, "''")}'`] : []),
    'if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $d.FileName }'
  ].join('; ');
  return runPowerShell(script);
}

function pickFolderWithExplorer(title = 'Select folder') {
  if (process.platform !== 'win32') return '';
  const script = [
    'Add-Type -AssemblyName System.Windows.Forms',
    '$d = New-Object System.Windows.Forms.FolderBrowserDialog',
    `$d.Description = '${title.replace(/'/g, "''")}'`,
    '$d.ShowNewFolderButton = $true',
    'if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $d.SelectedPath }'
  ].join('; ');
  return runPowerShell(script);
}

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

async function chooseJarPath(prompt, label, matcher, currentPath, downloadsDir) {
  const candidates = findJarCandidates(downloadsDir, matcher);
  if (candidates.length > 0) {
    const top = candidates[0];
    const useDetected = await prompt([
      {
        type: 'confirm',
        name: 'yes',
        message: `${label}: usar JAR encontrado em Downloads? (${path.basename(top)})`,
        default: true
      }
    ]);
    if (useDetected.yes) return top;
  }

  const picked = pickFileWithExplorer(`Selecione o JAR do ${label}`, 'JAR files (*.jar)|*.jar', downloadsDir);
  if (picked) return picked;

  const fallback = await prompt([
    {
      name: 'manual',
      message: `${label}: caminho manual do JAR (deixe vazio para manter atual)`,
      default: currentPath || ''
    }
  ]);
  return fallback.manual || currentPath || '';
}

module.exports = {
  pickFolderWithExplorer,
  chooseJarPath
};