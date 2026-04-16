const axios = require('axios');
const { loadConfig, saveConfig, applyConfigValues } = require('../cli-logic-adapter');
const { makeApiClient } = require('../../cli-logic-adapter');

class ExtensionsService {
  constructor() {
  }

  listRepos() {
    try {
      const cfg = loadConfig();
      return cfg.extensionRepos || [];
    } catch (error) {
      return [];
    }
  }

  addRepo(url) {
    try {
      const cfg = loadConfig();
      cfg.extensionRepos = cfg.extensionRepos || [];
      if (url && !cfg.extensionRepos.includes(url)) {
        cfg.extensionRepos.push(url);
        saveConfig(cfg);
        applyConfigValues({ extensionRepos: cfg.extensionRepos });
      }
      return cfg.extensionRepos;
    } catch (error) {
      return [];
    }
  }

  removeRepos(urls) {
    try {
      const cfg = loadConfig();
      cfg.extensionRepos = (cfg.extensionRepos || []).filter(r => !urls.includes(r));
      saveConfig(cfg);
      applyConfigValues({ extensionRepos: cfg.extensionRepos });
      return cfg.extensionRepos;
    } catch (error) {
      return [];
    }
  }

  async fetchRepoIndexes() {
    try {
      const repos = this.listRepos();
      const out = [];
      for (const repo of repos) {
        try {
          const res = await axios.get(repo, { timeout: 10000 });
          out.push({
            repo,
            ok: true,
            isArray: Array.isArray(res.data),
            size: Array.isArray(res.data) ? res.data.length : Object.keys(res.data || {}).length,
            data: res.data
          });
        } catch (e) {
          out.push({ repo, ok: false, error: e.message });
        }
      }
      return out;
    } catch (error) {
      return [];
    }
  }

  async getServerExtensions() {
    try {
      const cfg = loadConfig();
      const apiUrl = cfg.apiUrl || 'http://localhost:4567';
      const client = makeApiClient(apiUrl);
      return await listExtensions(client);
    } catch (error) {
      return [];
    }
  }

  async installPackages(pkgs) {
    try {
      const cfg = loadConfig();
      const apiUrl = cfg.apiUrl || 'http://localhost:4567';
      const client = makeApiClient(apiUrl);
      const results = [];
      const extensions = await this.getServerExtensions();
      const knownPkg = new Set((Array.isArray(extensions) ? extensions : []).map(e => e && e.pkgName).filter(Boolean));

      for (const pkg of pkgs) {
        if (!knownPkg.has(pkg)) {
          results.push({
            pkg,
            ok: false,
            error: 'Package not visible in /extension/list. Restart server after updating extensionRepos.'
          });
          continue;
        }

        try {
          const res = await installExtension(client, pkg);
          const status = Number(res && res.status);
          if (status >= 200 && status < 400) {
            results.push({ pkg, ok: true, status });
          } else {
            results.push({ pkg, ok: false, status: Number.isFinite(status) ? status : null, error: `Install returned HTTP ${Number.isFinite(status) ? status : 'unknown'}` });
          }
        } catch (e) {
          results.push({ pkg, ok: false, error: e.message });
        }
      }

      return results;
    } catch (error) {
      return [];
    }
  }

  async getSources() {
    try {
      const cfg = loadConfig();
      const apiUrl = cfg.apiUrl || 'http://localhost:4567';
      const client = makeApiClient(apiUrl);
      return await listSources(client);
    } catch (error) {
      return [];
    }
  }
}

module.exports = { ExtensionsService };