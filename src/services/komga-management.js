const { organizeDownloadsForKomga } = require('../cli-logic-adapter');
const { triggerKomgaLibraryScan, triggerKomgaMetadataRefresh, syncKomgaSeriesMetadataFromLocal } = require('../cli-logic-adapter');
const { ensureKomgaLibraryExists } = require('../cli-logic-adapter');
const { startKomga, waitForKomgaReady } = require('../cli-logic-adapter');

class KomgaManagementService {
  constructor() {
    this.komga = null;
  }

  async organizeLibrary(options = {}) {
    try {
      const result = await organizeDownloadsForKomga(options);
      return { ok: true, result };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  }

  async triggerKomgaOperations(cfg) {
    try {
      const refresh = await triggerKomgaMetadataRefresh();
      const patched = await syncKomgaSeriesMetadataFromLocal();
      const scan = await triggerKomgaLibraryScan({ scanDeep: true, scanForceModifiedTime: true });

      return {
        ok: true,
        refresh,
        patched,
        scan
      };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  }

  async ensureKomgaReady(cfg) {
    try {
      // Verificar se Komga está rodando
      if (!this.komga || !this.komga.ready) {
        // Iniciar Komga
        const result = await startKomga();
        this.komga = result;

        // Aguardar readiness
        if (result.ready) {
          await waitForKomgaReady(cfg);
        }
      }
      return { ok: true, komga: this.komga };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  }

  async ensureLibraryExists(cfg, libraryName, libraryRoot) {
    try {
      const result = await ensureKomgaLibraryExists(libraryName, libraryRoot);
      return { ok: true, exists: result.exists };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  }

  async startKomga(cfg) {
    try {
      const result = await startKomga();
      this.komga = result;
      return { ok: true, komga: result };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  }

  async waitForKomgaReady(cfg) {
    try {
      await waitForKomgaReady(cfg);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  }
}

module.exports = { KomgaManagementService };