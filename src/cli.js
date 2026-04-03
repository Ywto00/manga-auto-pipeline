const { bootstrap } = require('./composition/bootstrap');

const ctx = bootstrap();

if (require.main === module) {
  ctx.mainMenu().catch(e => {
    console.error(e);
    process.exit(1);
  });
}

module.exports = {
  mainMenu: ctx.mainMenu
};
