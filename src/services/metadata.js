const { normalize } = require('../../shared/utils/normalize');
const { getDataPaths } = require('../infra/config/config-store');
const fs = require('fs');
const path = require('path');

class MetadataService {
  constructor() {
    // Cache for indexes
    this.listIndexCache = null;
    this.listByIdCache = null;
    this.seriesIndexCache = null;
    this.downloadsRegistryCache = null;
    this.linkCacheCache = null;
  }

  // ---------------------------------------------------------------------------
  // Normalize helpers
  // ---------------------------------------------------------------------------

  normalizeKey(s) {
    return String(s || '')
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/\([^)]*\)|\[[^\]]*\]/g, ' ')
      .replace(/[^a-z0-9]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
  }

  // ---------------------------------------------------------------------------
  // List index
  // ---------------------------------------------------------------------------

  async buildListMetadataIndex() {
    try {
      // Check cache
      if (this.listIndexCache) return this.listIndexCache;

      const map = new Map();
      const byId = new Map();

      const rawList = this.readListRaw();
      for (const item of rawList) {
        const id = Number(item && item.id);
        if (Number.isFinite(id) && !byId.has(id)) byId.set(id, item);

        const aliases = [];
        aliases.push(this.normalizeKey(item.title || ''));
        aliases.push(this.normalizeKey(item.searchKey || ''));
        if (Array.isArray(item.altTitles)) {
          for (const alt of item.altTitles) aliases.push(this.normalizeKey(alt));
        }
        for (const key of aliases.filter(Boolean)) {
          if (!map.has(key)) map.set(key, item);
        }
      }

      // Extend with aliases from the downloads registry
      const downloads = this.readDownloadsRegistry();
      for (const [itemKey, entry] of Object.entries(downloads.items || {})) {
        const parts = String(itemKey || '').split(':');
        const idFromKey = Number(parts[1]);
        const id = Number.isFinite(Number(entry && entry.id)) ? Number(entry.id) : (Number.isFinite(idFromKey) ? idFromKey : null);
        const item = Number.isFinite(id) ? byId.get(id) : null;
        if (!item) continue;
        const add = (v) => { const k = this.normalizeKey(v); if (k && !map.has(k)) map.set(k, item); };
        add(entry.title || ''); add(entry.searchKey || ''); add(entry.matchedMangaTitle || '');
      }

      // Extend with aliases from the link cache
      const cache = this.readLinkCache();
      for (const [itemKey, entry] of Object.entries(cache.items || {})) {
        const parts = String(itemKey || '').split(':');
        const idFromKey = Number(parts[1]);
        const item = Number.isFinite(idFromKey) ? byId.get(idFromKey) : null;
        if (!item) continue;
        const best = entry && entry.best ? entry.best : null;
        const add = (v) => { const k = this.normalizeKey(v); if (k && !map.has(k)) map.set(k, item); };
        add(best && best.mangaTitle ? best.mangaTitle : '');
        add(best && best.matchedAgainst ? best.matchedAgainst : '');
        for (const s of (Array.isArray(entry && entry.sources) ? entry.sources : [])) {
          for (const m of (Array.isArray(s && s.mangas) ? s.mangas.slice(0, 5) : [])) {
            add(m && m.title ? m.title : ''); add(m && m.matchedAgainst ? m.matchedAgainst : '');
          }
        }
      }

      this.listIndexCache = map;
      return map;
    } catch (error) {
      throw new Error(`Failed to build metadata index: ${error.message}`);
    }
  }

  async buildListMetadataById() {
    try {
      // Check cache
      if (this.listByIdCache) return this.listByIdCache;

      const map = new Map();
      const rawList = this.readListRaw();
      for (const item of rawList) {
        const id = Number(item && item.id);
        if (Number.isFinite(id) && !map.has(id)) map.set(id, item);
      }

      this.listByIdCache = map;
      return map;
    } catch (error) {
      throw new Error(`Failed to build metadata by ID: ${error.message}`);
    }
  }

  // ---------------------------------------------------------------------------
  // Series.json scanner
  // ---------------------------------------------------------------------------

  walkFilesRecursively(root, out = []) {
    if (!root || !fs.existsSync(root)) return out;
    let stack = [root];
    while (stack.length) {
      const cur = stack.pop();
      try {
        for (const e of fs.readdirSync(cur, { withFileTypes: true })) {
          const full = path.join(cur, e.name);
          if (e.isDirectory()) stack.push(full); else out.push(full);
        }
      } catch (e) { /* skip unreadable dirs */ }
    }
    return out;
  }

  toItemMeta(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const status = raw.anilistStatus || raw.status || '';
    return {
      id: Number.isFinite(Number(raw.anilistId)) ? Number(raw.anilistId) : null,
      title: raw.title || raw.name || '',
      description: raw.description || raw.description_text || raw.description_formatted || '',
      altTitles: Array.isArray(raw.altTitles) ? raw.altTitles : (Array.isArray(raw.alternate_names) ? raw.alternate_names : []),
      siteUrl: raw.siteUrl || '',
      countryOfOrigin: raw.countryOfOrigin || '',
      totalChapters: Number.isFinite(Number(raw.totalChapters)) ? Number(raw.totalChapters) : null,
      mediaStatus: status,
      status,
      startYear: Number.isFinite(Number(raw.startYear)) ? Number(raw.startYear) : null
    };
  }

  async buildSeriesJsonMetadataIndex(rootDirs = []) {
    try {
      const map = new Map();
      const seen = new Set();
      for (const root of rootDirs) {
        if (!root || !fs.existsSync(root)) continue;
        const files = this.walkFilesRecursively(root).filter(f => path.basename(f).toLowerCase() === 'series.json');
        for (const file of files) {
          const abs = path.resolve(file);
          if (seen.has(abs)) continue;
          seen.add(abs);
          try {
            const raw = JSON.parse(fs.readFileSync(file, 'utf8') || '{}');
            const item = this.toItemMeta(raw);
            if (!item) continue;
            const add = (v) => { const k = this.normalizeKey(v); if (k && !map.has(k)) map.set(k, item); };
            add(raw.name || ''); add(raw.title || '');
            for (const alt of (Array.isArray(item.altTitles) ? item.altTitles : [])) add(alt);
          } catch (e) { /* skip malformed */ }
        }
      }
      return map;
    } catch (error) {
      throw new Error(`Failed to build series.json metadata index: ${error.message}`);
    }
  }

  async readSeriesJson(seriesDir) {
    try {
      if (!seriesDir) return null;
      const file = path.join(seriesDir, 'series.json');
      if (!fs.existsSync(file)) return null;
      return this.toItemMeta(JSON.parse(fs.readFileSync(file, 'utf8') || '{}'));
    } catch (error) {
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Metadata merging & lookup
  // ---------------------------------------------------------------------------

  mergeItemMetadata(...items) {
    try {
      const valid = items.filter(Boolean);
      if (!valid.length) return null;

      const best = { ...valid[0], altTitles: [], genres: [] };
      const altSet = new Set();
      const genreSet = new Set();

      const takeStr = (key, value) => {
        const v = String(value || '').trim();
        const cur = String(best[key] || '').trim();
        if (!v) return;
        if (!cur || v.length > cur.length) best[key] = v;
      };
      const takeNum = (key, value) => { const n = Number(value); if (Number.isFinite(n)) best[key] = n; };

      for (const item of valid) {
        takeNum('id', item.id); takeStr('title', item.title); takeStr('description', item.description);
        takeStr('siteUrl', item.siteUrl); takeStr('countryOfOrigin', item.countryOfOrigin);
        takeStr('mediaStatus', item.mediaStatus || item.status); takeStr('status', item.status || item.mediaStatus);
        takeStr('publisher', item.publisher); takeNum('totalChapters', item.totalChapters); takeNum('startYear', item.startYear);

        for (const t of (Array.isArray(item.altTitles) ? item.altTitles : [])) {
          const k = String(t || '').trim().toLowerCase();
          if (k && !altSet.has(k)) { altSet.add(k); best.altTitles.push(String(t).trim()); }
        }
        for (const g of (Array.isArray(item.genres) ? item.genres : [])) {
          const k = String(g || '').trim().toLowerCase();
          if (k && !genreSet.has(k)) { genreSet.add(k); best.genres.push(String(g).trim()); }
        }
      }

      best.altTitles = best.altTitles.slice(0, 20);
      best.genres = best.genres.slice(0, 20);
      return best;
    } catch (error) {
      throw new Error(`Failed to merge item metadata: ${error.message}`);
    }
  }

  async findSeriesMetadata(seriesName, metadataIndex) {
    try {
      if (!metadataIndex || !seriesName) return null;
      const key = this.normalizeKey(seriesName);
      if (!key) return null;

      const direct = metadataIndex.get(key);
      if (direct) return direct;

      // Partial match for longer keys
      if (key.length >= 6) {
        for (const [k, item] of metadataIndex.entries()) {
          if (!k || k.length < 6) continue;
          if (k.includes(key) || key.includes(k)) return item;
        }
      }
      return null;
    } catch (error) {
      throw new Error(`Failed to find series metadata: ${error.message}`);
    }
  }

  // ---------------------------------------------------------------------------
  // Registry helpers (for cross-module consumers)
  // ---------------------------------------------------------------------------

  readDownloadsRegistry() {
    try {
      // Check cache
      if (this.downloadsRegistryCache) return this.downloadsRegistryCache;

      const txt = fs.readFileSync(getDataPaths().downloads, 'utf8') || '{}';
      const result = JSON.parse(txt);
      this.downloadsRegistryCache = result;
      return result;
    } catch (e) {
      return { version: 1, items: {} };
    }
  }

  readLinkCache() {
    try {
      // Check cache
      if (this.linkCacheCache) return this.linkCacheCache;

      const txt = fs.readFileSync(getDataPaths().linkCache, 'utf8') || '{}';
      const result = JSON.parse(txt);
      this.linkCacheCache = result;
      return result;
    } catch (e) {
      return { version: 1, items: {} };
    }
  }

  // Cache invalidation methods
  clearCache() {
    this.listIndexCache = null;
    this.listByIdCache = null;
    this.seriesIndexCache = null;
    this.downloadsRegistryCache = null;
    this.linkCacheCache = null;
  }
}

module.exports = { MetadataService };