const {
  getAutoLinkCandidates,
  warmAutoLinkCache,
  buildBatchAutoLinkPreview,
  setManualLink,
  removeManualLink
} = require('./autolink');
const { scoreTitleMatch, isStrictTitleMatch } = require('./title-match');

class LinksService {
  constructor(cfg) {
    this.cfg = cfg;
  }

  async getAutoLinkCandidates(item, opts = {}) {
    try {
      const candidates = await getAutoLinkCandidates(item, opts);
      return { ok: true, candidates };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  }

  async warmCache(opts = {}) {
    try {
      await warmAutoLinkCache(opts);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  }

  async buildPreview(opts = {}) {
    try {
      const preview = await buildBatchAutoLinkPreview(opts);
      return { ok: true, preview };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  }

  async setManualLink(item, link) {
    try {
      await setManualLink(item, link);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  }

  async removeManualLink(item) {
    try {
      await removeManualLink(item);
      return { ok: true };
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

  scoreTitle(title1, title2) {
    return scoreTitleMatch(title1, title2);
  }

  isStrictMatch(title1, title2) {
    return isStrictTitleMatch(title1, title2);
  }
}

module.exports = { LinksService };