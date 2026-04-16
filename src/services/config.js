const { loadConfig, saveConfig, applyConfigValues } = require('../cli-logic-adapter');

class ConfigService {
  constructor() {
    this.config = null;
  }

  async load() {
    try {
      this.config = loadConfig();
      return { ok: true, config: this.config };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  }

  async save(cfg) {
    try {
      saveConfig(cfg);
      this.config = cfg;
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  }

  async applyValues(values) {
    try {
      const cfg = applyConfigValues(values);
      this.config = cfg;
      return { ok: true, config: cfg };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  }

  async validate(cfg) {
    // Implementar validação de configuração
    return { ok: true };
  }

  getConfig() {
    return this.config;
  }

  get(key) {
    return this.config ? this.config[key] : undefined;
  }

  set(key, value) {
    if (!this.config) this.config = {};
    this.config[key] = value;
  }
}

module.exports = { ConfigService };