const { loadConfig } = require('../../config/infra/config-store');
const { getDownloadsSnapshot } = require('../../server/infra/suwayomi-api');

async function getDownloadsOverview() {
  try {
    const cfg = loadConfig();
    const apiUrl = cfg.apiUrl || 'http://localhost:4567';
    const snapshot = await getDownloadsSnapshot(apiUrl, 4000);
    const queue = Array.isArray(snapshot && snapshot.queue) ? snapshot.queue : [];

    return {
      ok: true,
      status: (snapshot && snapshot.status) || 'Unknown',
      queueSize: queue.length,
      queue
    };
  } catch (e) {
    return {
      ok: false,
      status: 'Offline',
      queueSize: 0,
      queue: [],
      error: e.message
    };
  }
}

module.exports = { getDownloadsOverview };
