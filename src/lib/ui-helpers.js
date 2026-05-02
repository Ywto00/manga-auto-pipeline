function truncateText(value, max) {
  const limit = Number.isFinite(Number(max)) ? Number(max) : 68;
  const text = String(value || '').trim();
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 1))}...`;
}

function scoreLabel(score, ui) {
  const n = Number(score || 0);
  if (!ui || !ui.colors) return String(n);
  if (n >= 90) return ui.colors.success(String(n));
  if (n >= 70) return ui.colors.warning(String(n));
  return ui.colors.error(String(n));
}

function matchPercentLabel(score, ui) {
  const n = Math.max(0, Math.min(100, Number(score || 0)));
  if (!ui || !ui.colors) return `${n}%`;
  if (n >= 90) return ui.colors.success(`${n}%`);
  if (n >= 70) return ui.colors.warning(`${n}%`);
  return ui.colors.error(`${n}%`);
}

function chapterLabel(hasChapters, ui) {
  if (!ui || !ui.colors) {
    if (hasChapters === true) return 'chapters:ok';
    if (hasChapters === false) return 'chapters:none';
    return 'chapters:unknown';
  }

  if (hasChapters === true) return ui.colors.success('chapters:ok');
  if (hasChapters === false) return ui.colors.error('chapters:none');
  return ui.colors.muted('chapters:unknown');
}

function linkedStateLabel(linked, ui) {
  if (!ui || !ui.colors) return linked ? 'vinculado' : 'sem-vinculo';
  return linked ? ui.colors.success('vinculado') : ui.colors.error('sem-vinculo');
}

function colorizeFoundTitle(title, ui) {
  if (!ui || !ui.colors) return String(title || '');
  return ui.colors.info(String(title || ''));
}

function openInBrowser(url, execFn) {
  const target = String(url || '').trim();
  if (!target) return;

  const run = typeof execFn === 'function' ? execFn : null;
  if (!run) return;

  if (process.platform === 'win32') {
    run(`start "" "${target}"`);
    return;
  }
  if (process.platform === 'darwin') {
    run(`open "${target}"`);
    return;
  }
  run(`xdg-open "${target}"`);
}

module.exports = {
  truncateText,
  scoreLabel,
  matchPercentLabel,
  chapterLabel,
  linkedStateLabel,
  colorizeFoundTitle,
  openInBrowser
};
