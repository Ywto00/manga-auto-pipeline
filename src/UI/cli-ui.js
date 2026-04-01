const { mainMenu } = require('./menus/main-menu');
const { configureUI } = require('./menus/settings-menu');
const { manageExtensionsUI } = require('./menus/extensions-menu');

module.exports = {
  mainMenu,
  configureUI,
  manageExtensionsUI
};
