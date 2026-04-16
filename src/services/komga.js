const { startKomga, waitForKomgaReady, organizeKomgaLibrary } = require('../features/komga/infra/komga-runner');
const { triggerKomgaLibraryScan, triggerKomgaMetadataRefresh } = require('../features/komga/infra/komga-api');
const fs = require('fs');
const path = require('path');

class KomgaService {
  constructor(cfg) {
    this.cfg = cfg;
    this.process = null;
  }

  async start() {
    try {
      // Garantir diretórios
      const dataDir = this.cfg.dataDir;
      fs.mkdirSync(dataDir, { recursive: true });

      // Iniciar Komga
      const result = await startKomga(this.cfg);
      this.process = result.process;

      // Aguardar readiness
      await waitForKomgaReady(this.cfg);

      return { ok: true, pid: this.process.pid, ready: true };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  }

  async ensureLibrary(root, name) {
    try {
      // Verificar se biblioteca existe
      const exists = await this._libraryExists(name);
      if (!exists) {
        // Criar biblioteca
        await this._createLibrary(name, root);
      }
      return { ok: true, exists };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  }

  async triggerScan(options = {}) {
    try {
      await triggerKomgaLibraryScan(options);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  }

  async triggerMetadataRefresh() {
    try {
      await triggerKomgaMetadataRefresh();
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  }

  async organizeLibrary(options = {}) {
    try {
      await organizeKomgaLibrary(options);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  }

  isRunning() {
    return this.process !== null && this.process.pid !== null;
  }

  async _libraryExists(name) {
    // Implementar verificação de biblioteca existente
    return false; // Placeholder
  }

  async _createLibrary(name, root) {
    // Implementar criação de biblioteca
  }
}

module.exports = { KomgaService };