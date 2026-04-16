const { deleteReadChaptersByAniList } = require('../cli-logic-adapter');

class CleanupService {
  constructor() {
  }

  async deleteReadChaptersByAniList(opts = {}) {
    try {
      const result = await deleteReadChaptersByAniList(opts);
      return { ok: true, result };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  }

  async cleanupUnlinkedItems(keys) {
    try {
      // Implementar limpeza de itens não vinculados
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  }

  async cleanupLibraryDuplicates() {
    try {
      // Implementar limpeza de duplicatas na biblioteca
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  }

  async cleanupOrphanFiles() {
    try {
      // Implementar limpeza de arquivos órfãos
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  }
}

module.exports = { CleanupService };