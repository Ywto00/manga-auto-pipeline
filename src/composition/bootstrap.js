// Backward-compatible alias.
const { bootstrapCli } = require('./bootstrap-cli');

function bootstrap() {
  return bootstrapCli();
}

module.exports = { bootstrap };