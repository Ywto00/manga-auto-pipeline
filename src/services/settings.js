const { loadConfig, applyConfigValues } = require('../../cli-logic-adapter');

class SettingsService {
  constructor() {
  }

  async runGeneralSettingsFlow() {
    try {
      const cfg = loadConfig();
      // Implementar fluxo de configurações gerais
      return { ok: true, config: cfg };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  }

  async runSearchSettingsFlow() {
    try {
      const cfg = loadConfig();
      // Implementar fluxo de configurações de busca
      return { ok: true, config: cfg };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  }

  async getConfigValidation() {
    try {
      const cfg = loadConfig();
      // Implementar validação de configuração
      return { ok: true, valid: true };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  }

  async applySettings(values) {
    try {
      const cfg = applyConfigValues(values);
      return { ok: true, config: cfg };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  }
}

module.exports = { SettingsService };