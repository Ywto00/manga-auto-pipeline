const { mainMenu } = require('./UI/cli-ui');

if (require.main === module) {
  mainMenu().catch(e => {
    console.error(e);
    process.exit(1);
  });
}

module.exports = {
  mainMenu
};
