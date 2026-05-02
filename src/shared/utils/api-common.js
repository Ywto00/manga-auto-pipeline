const axios = require('axios');

//Shared
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// HTTP GET with simple retry/backoff for network errors
async function getJson(url, opts = {}) {
  const maxRetries = opts.retries || 3;
  const timeout = opts.timeout || 10000;
  const headers = Object.assign({ 'User-Agent': 'manga-auto-pipeline/1.0' }, opts.headers || {});
  let attempt = 0;
  while (true) {
    try {
      const res = await axios.get(url, Object.assign({}, opts, { timeout, headers }));
      return res.data;
    } catch (err) {
      attempt++;
      const isNetworkErr = !err.response || ['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN'].includes(err.code);
      if (attempt >= maxRetries || !isNetworkErr) throw err;
      await sleep(500 * Math.pow(2, attempt));
    }
  }
}

async function postJson(url, data, opts = {}) {
  const res = await axios.post(url, data, opts);
  return res.data;
}

async function paginateAsync(fetchPage) {
  const out = [];
  let page = 1;
  while (true) {
    const { items, hasNext } = await fetchPage(page);
    if (!items || items.length === 0) break;
    out.push(...items);
    if (!hasNext) break;
    page++;
  }
  return out;
}

// ANILIST
async function postGraphQL(query, variables = {}, url = 'https://graphql.anilist.co') {
  const res = await axios.post(url, { query, variables });
  if (res.data && res.data.errors) {
    const err = (res.data.errors || []).map(e => e.message).join('; ');
    throw new Error(err);
  }
  return res.data && res.data.data ? res.data.data : null;
}

module.exports = {
  // MAL
  getJson,
  // Shared
  postJson,
  paginateAsync,
  sleep,
  // AniList
  postGraphQL
};
