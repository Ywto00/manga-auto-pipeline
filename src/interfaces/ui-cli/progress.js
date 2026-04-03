/**
 * Progress helpers: spinner + progress bar wrappers
 * Small, documented API so UI code is easy to read and reuse.
 *
 * Visuals:
 * - spinner: small animated indicator with brief text (good for short ops)
 * - progress bar: percentage + counter, good for long-running loops
 */

const oraImport = require('ora');
// ora can be exported as default in some environments; normalize both cases
const ora = (oraImport && typeof oraImport === 'object' && typeof oraImport.default === 'function') ? oraImport.default : oraImport;
const cliProgress = require('cli-progress');

/**
 * Start a spinner with given text.
 * Returns the spinner instance; call `stopSpinner(spinner, success, text)` to finish.
 */
function startSpinner(text = 'Working...') {
  if (!ora) throw new Error('ora not available; please install it');
  const s = ora(text).start();
  return s;
}

/**
 * Stop spinner and show success or failure message.
 * - spinner: the object returned from `startSpinner()`
 * - success: true -> green success, false -> red fail
 * - text: optional override message
 */
function stopSpinner(spinner, success = true, text) {
  if (!spinner) return;
  try {
    if (success) spinner.succeed(text || spinner.text);
    else spinner.fail(text || spinner.text);
  } catch (e) {
    // ignore errors while stopping the spinner
  }
}

/**
 * Create and start a progress bar.
 * Returns the bar object which you can update with `bar.update(value)`.
 */
function createBar(total, opts = {}) {
  const bar = new cliProgress.SingleBar(Object.assign({
    format: 'Progress |{bar}| {percentage}% | {value}/{total}',
    barCompleteChar: '\u2588',
    barIncompleteChar: '\u2591'
  }, opts), cliProgress.Presets.shades_classic);
  bar.start(total, 0);
  return bar;
}

/**
 * Safe update helper; no-op if bar absent.
 */
function updateBar(bar, value) {
  if (!bar) return;
  bar.update(value);
}

/**
 * Stop a running progress bar safely.
 */
function stopBar(bar) {
  if (!bar) return;
  try { bar.stop(); } catch (e) { }
}

module.exports = {
  startSpinner,
  stopSpinner,
  createBar,
  updateBar,
  stopBar
};
