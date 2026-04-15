/**
 * UI enhancements hub.
 *
 * Centralizes banners, colors, separators, notifications, live dashboard,
 * hotkey bindings, and spinner helpers so all menu files share a single
 * visual contract.
 *
 * Usage:
 *   const ui = require('../feedback/ui-enhancements');
 *   ui.separator('Title');
 *   ui.NotificationManager.instance.success('Done');
 *   const dashboard = new ui.LiveDashboard(); ...
 */

const { startSpinner, stopSpinner } = require('./progress');

// ---------------------------------------------------------------------------
// Color palette
// ---------------------------------------------------------------------------

const isTTY = process.stdout.isTTY;

function code(n) {
  return isTTY ? `\u001b[${n}m` : '';
}
const RESET = code(0);

const colors = {
  primary: (v) => `${code(36)}${v}${RESET}`,        // cyan
  bold: (v) => `${code(1)}${v}${RESET}`,
  success: (v) => `${code(32)}${v}${RESET}`,        // green
  error: (v) => `${code(31)}${v}${RESET}`,          // red
  warning: (v) => `${code(33)}${v}${RESET}`,        // yellow
  muted: (v) => `${code(90)}${v}${RESET}`,          // gray
  info: (v) => `${code(34)}${v}${RESET}`,           // blue
};

// ---------------------------------------------------------------------------
// Helpers: banner, separators
// ---------------------------------------------------------------------------

function showBanner() {
  console.log('');
  console.log(colors.primary('  ╔══════════════════════════════════════════╗'));
  console.log(colors.primary('  ║          Manga Auto Pipeline             ║'));
  console.log(colors.primary('  ║       Gerenciador de Mangas v2.0         ║'));
  console.log(colors.primary('  ╚══════════════════════════════════════════╝'));
  console.log('');
}

function separator(title) {
  const line = '─'.repeat(Math.max(40, process.stdout.columns || 60) - 2);
  if (title) {
    console.log(`\n${colors.muted(line.slice(0, 4))}${colors.primary(` ${title} `)}${colors.muted(line.slice(4 + title.length + 2))}`);
  } else {
    console.log(colors.muted(line));
  }
}

// ---------------------------------------------------------------------------
// Spinner wrapper (uses progress.js internally)
// ---------------------------------------------------------------------------

async function withSpinner(text, fn) {
  const spinner = startSpinner(`${text}...`);
  try {
    const result = await fn();
    stopSpinner(spinner, true, text);
    return result;
  } catch (e) {
    stopSpinner(spinner, false, text);
    throw e;
  }
}

// ---------------------------------------------------------------------------
// NotificationManager (singleton)
// ---------------------------------------------------------------------------

let _notifInstance = null;

class NotificationManager {
  static get instance() {
    if (!_notifInstance) _notifInstance = new NotificationManager();
    return _notifInstance;
  }

  info(msg) {
    console.log(`  ${colors.info('ℹ')} ${msg}`);
  }

  success(msg) {
    console.log(`  ${colors.success('✓')} ${msg}`);
  }

  warning(msg) {
    console.log(`  ${colors.warning('⚠')} ${msg}`);
  }

  error(msg) {
    console.log(`  ${colors.error('✗')} ${msg}`);
  }
}

// ---------------------------------------------------------------------------
// LiveDashboard (compact, in-place update panel)
// ---------------------------------------------------------------------------

class LiveDashboard {
  constructor() {
    this._sections = [];          // [{name, fn}]
    this._interval = null;
    this._running = false;
    this._lineCount = 0;
  }

  section(name, renderFn) {
    this._sections.push({ name, renderFn });
    return this;
  }

  _render() {
    if (!this._sections.length) return;

    const width = Math.min(process.stdout.columns || 70, 80);
    const line = '─'.repeat(width);
    const parts = this._sections.map((s) => {
      const val = s.renderFn();
      return ` ${colors.primary(s.name)}: ${val} `;
    });

    const content = `${colors.muted(line)}\n${parts.join(colors.muted('|'))}\n${colors.muted(line)}\n`;

    // Clear previous dashboard if exists
    if (this._lineCount > 0) {
      process.stdout.write(`\x1b[${this._lineCount}A\x1b[0J`);
    }

    process.stdout.write(content);
    this._lineCount = content.split('\n').length;
  }

  start(intervalMs = 2000) {
    if (this._running) return;
    this._running = true;
    this._lineCount = 0;
    this._render();
    this._interval = setInterval(() => {
      this._render();
    }, intervalMs);
  }

  stop() {
    if (this._interval) clearInterval(this._interval);
    this._interval = null;
    this._running = false;
    // Clear dashboard and move to fresh line
    if (this._lineCount > 0) {
      process.stdout.write(`\x1b[${this._lineCount}A\x1b[0J`);
      this._lineCount = 0;
    }
  }
}

// ---------------------------------------------------------------------------
// HotkeyManager
// ---------------------------------------------------------------------------

class HotkeyManager {
  constructor() {
    this._handlers = new Map();
  }

  bind(keyCombo, fn) {
    // For a simple CLI we store handlers; Ctrl+C is natively available.
    this._handlers.set(keyCombo.toLowerCase(), fn);
  }

  destroy() {
    this._handlers.clear();
  }
}

// Separator for inquirer choices
class Separator {}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  colors,
  showBanner,
  separator,
  withSpinner,
  NotificationManager,
  LiveDashboard,
  HotkeyManager,
  Separator,
};
