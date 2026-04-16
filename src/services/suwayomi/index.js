const api = require('../../features/server/infra/suwayomi-api');
const runner = require('../../features/server/infra/suwayomi-runner');

module.exports = {
  ...api,
  ...runner
};
