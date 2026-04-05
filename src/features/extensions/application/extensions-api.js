/**
 * Extensions management API.
 *
 * Application-level functions for managing extension repositories,
 * fetching indexes, installing packages, and listing installed sources.
 */
const axios = require('axios');
const { loadConfig, saveConfig, syncServerConf } = require('../../../features/config/infra/config-store');
const { makeApiClient, listExtensions, installExtension, listSources } = require('../../../features/server/infra/suwayomi-api');

function listRepos() {
  const cfg = loadConfig();
  return cfg.extensionRepos || [];
}

function addRepo(url) {
  const cfg = loadConfig();
  cfg.extensionRepos = cfg.extensionRepos || [];
  if (url && !cfg.extensionRepos.includes(url)) {
    cfg.extensionRepos.push(url);
    saveConfig(cfg);
    syncServerConf(cfg);
  }
  return cfg.extensionRepos;
}

function removeRepos(urls) {
  const cfg = loadConfig();
  cfg.extensionRepos = (cfg.extensionRepos || []).filter(r => !urls.includes(r));
  saveConfig(cfg);
  syncServerConf(cfg);
  return cfg.extensionRepos;
}

async function fetchRepoIndexes() {
  const repos = listRepos();
  const out = [];
  for (const repo of repos) {
    try {
      const res = await axios.get(repo, { timeout: 10000 });
      out.push({ repo, ok: true, isArray: Array.isArray(res.data), size: Array.isArray(res.data) ? res.data.length : Object.keys(res.data || {}).length, data: res.data });
    } catch (e) {
      out.push({ repo, ok: false, error: e.message });
    }
  }
  return out;
}

async function getServerExtensions() {
  const cfg = loadConfig();
  const apiUrl = cfg.apiUrl || 'http://localhost:4567';
  const client = makeApiClient(apiUrl);
  return listExtensions(client);
}

async function installPackages(pkgs) {
  const cfg = loadConfig();
  const apiUrl = cfg.apiUrl || 'http://localhost:4567';
  const client = makeApiClient(apiUrl);
  const results = [];
  const extensions = await listExtensions(client);
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
}

async function getSources() {
  const cfg = loadConfig();
  const apiUrl = cfg.apiUrl || 'http://localhost:4567';
  const client = makeApiClient(apiUrl);
  return listSources(client);
}

module.exports = {
  listRepos,
  addRepo,
  removeRepos,
  fetchRepoIndexes,
  getServerExtensions,
  installPackages,
  getSources
};
