const { startSuwayomiJar, waitForSuwayomiReady } = require('../features/server/infra/suwayomi-runner');
const { makeApiClient } = require('../features/server/infra/suwayomi-api');
const fs = require('fs');
const path = require('path');

class SuwayomiService {
  constructor(cfg) {
    this.cfg = cfg;
    this.process = null;
    this.apiUrl = null;
  }

  async start() {
    try {
      // Garantir diretórios
      const dataDir = this.cfg.dataDir;
      fs.mkdirSync(dataDir, { recursive: true });

      // Iniciar Suwayomi
      const result = await startSuwayomiJar(this.cfg);
      this.process = result.process;
      this.apiUrl = result.apiUrl;

      // Aguardar readiness
      await waitForSuwayomiReady(this.apiUrl);

      return { ok: true, pid: this.process.pid, apiUrl: this.apiUrl, ready: true };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  }

  async stop() {
    try {
      if (this.process && this.process.pid) {
        // Implementar lógica para parar processo
        // Por enquanto apenas matar processo
        process.kill(this.process.pid);
        this.process = null;
        return { stopped: true };
      }
      return { stopped: false };
    } catch (error) {
      return { stopped: false, error: error.message };
    }
  }

  isRunning() {
    return this.process !== null && this.process.pid !== null;
  }

  async waitReady(apiUrl, timeout = 30000, interval = 1000) {
    return waitForSuwayomiReady(apiUrl, timeout, interval);
  }

  makeClient(apiUrl, opts = {}) {
    return makeApiClient(apiUrl, opts);
  }
}

module.exports = { SuwayomiService };