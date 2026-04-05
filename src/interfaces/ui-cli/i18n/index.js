const fs = require('fs');
const path = require('path');

const i18nDir = path.join(__dirname);
let locale = 'pt';
let bundles = {};

function loadBundle(loc) {
  const p = path.join(i18nDir, `${loc}.json`);
  try {
    const raw = fs.readFileSync(p, 'utf8');
    bundles[loc] = JSON.parse(raw);
  } catch (e) {
    bundles[loc] = {};
  }
}

function ensureLocale(loc) {
  if (!bundles[loc]) loadBundle(loc);
}

function lookup(obj, key) {
  if (!obj || !key) return undefined;
  return key.split('.').reduce((acc, k) => (acc && acc[k] !== undefined ? acc[k] : undefined), obj);
}

function interpolate(str, vars) {
  if (!str || !vars) return str;
  return str.replace(/{{\s*([^}]+)\s*}}/g, (_, name) => (vars[name] !== undefined ? String(vars[name]) : `{{${name}}}`));
}

function t(key, vars) {
  ensureLocale(locale);
  let val = lookup(bundles[locale], key);
  if (val === undefined) {
    // fallback to en
    ensureLocale('en');
    val = lookup(bundles['en'], key);
  }
  if (val === undefined) return key;
  return interpolate(val, vars);
}

function setLocale(loc) {
  locale = loc;
  ensureLocale(loc);
}

function createScopedT(baseKey, translate = t) {
  return function scopedT(key, vars) {
    const fullKey = key ? `${baseKey}.${key}` : baseKey;
    return translate(fullKey, vars);
  };
}

module.exports = {
  t,
  setLocale,
  createScopedT
};
