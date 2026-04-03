// Composition root - assemble and return application wiring
// Keep minimal: import UI entrypoints and return them for `src/cli.js` to run.

const { mainMenu } = require('../interfaces/ui-cli');
const { loadConfig } = require('../shared/config');
const { setLocale } = require('../interfaces/ui-cli/i18n');

function bootstrap() {
  // Load runtime config and apply UI-level settings (locale) so
  // all UI modules follow the managed `data/config.json` value.
  try {
    const cfg = loadConfig();
    setLocale((cfg && cfg.locale) || process.env.APP_LOCALE || 'pt');
  } catch (e) {
    // non-fatal: fallback to defaults
    setLocale(process.env.APP_LOCALE || 'pt');
  }

  return {
    mainMenu
  };
}

module.exports = { bootstrap };