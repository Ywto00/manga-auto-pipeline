const { bootstrapCli } = require('./composition/bootstrap-cli');

const ctx = bootstrapCli();

if (require.main === module) {
  ctx.mainMenu().catch(e => {
    console.error(e);
    process.exit(1);
  });
}

module.exports = {
  mainMenu: ctx.mainMenu
};
