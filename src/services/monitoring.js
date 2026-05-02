const { getDownloadsOverview } = require('../cli-logic-adapter');
const { checkSourcesHealth } = require('../services/auto-link-batch-service');
const { startBackgroundEnqueueWorker } = require('../infra/pipeline/background-enqueue-worker');
const { runEnqueueBackgroundTask } = require('../services/pipeline/enqueue-background-task');

class MonitoringService {

  constructor() {
    this.worker = null;
  }

  async getDownloadsOverview() {
    try {
      const status = getDownloadsOverview();
      return { ok: true, status };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  }

  async runHealthCheck(opts = {}) {
    try {
      const result = await checkSourcesHealth(opts);
      return { ok: true, result };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  }

  async checkSourcesHealth(opts = {}) {


  async startBackgroundWorker(cfg) {
    try {
      const result = await startBackgroundEnqueueWorker();
      this.worker = result;
      return { ok: true, pid: result.pid };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  }

  async runBackgroundTask(cfg) {
    try {
      await runEnqueueBackgroundTask(cfg, {
        fetchUserList: require('../cli-logic-adapter').fetchUserList,
        enqueueFromList: require('../cli-logic-adapter').enqueueFromList,
        resolveEnqueuePrefs: require('../services/pipeline/resolve-enqueue-prefs').resolveEnqueuePrefs,
        logger: console
      });
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  }

  async stopBackgroundWorker() {
    try {
      if (this.worker && this.worker.pid) {
        // Implementar parada do worker
        this.worker = null;
        return { ok: true };
      }
      return { ok: false, error: 'Worker not running' };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  }

  isWorkerRunning() {
    return this.worker !== null && this.worker.pid !== null;
  }
}

module.exports = { MonitoringService };