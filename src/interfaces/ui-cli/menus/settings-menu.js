const ui = require('../feedback/ui-enhancements');

module.exports = function createSettingsMenu(deps) {
  const {
    t,
    ensurePrompt,
    settingsGeneralMenu,
    settingsSearchMenu,
    manageExtensionsUI,
    manageManualLinksUI
  } = deps;

  function settingsChoices() {
    return {
      general: t('menu.settings.general'),
      search: t('menu.settings.search'),
      extensions: t('menu.settings.extensions'),
      links: t('menu.settings.links'),
      back: t('menu.settings.back')
    };
  }

  async function openExtensionsSafely() {
    try {
      await manageExtensionsUI();
    } catch (e) {
      console.log(t('extensions.requireSuwayomi'));
    }
  }

  async function settingsMenu() {
    const prompt = ensurePrompt();
    const choices = settingsChoices();

    const handlers = {
      [choices.general]: settingsGeneralMenu,
      [choices.search]: settingsSearchMenu,
      [choices.extensions]: openExtensionsSafely,
      [choices.links]: manageManualLinksUI
    };

    while (true) {
      ui.separator('⚙️ Configurações');

      const ans = await prompt([
        {
          type: 'list',
          name: 'act',
          message: ui.colors.primary('🎯 Menu de Configurações'),
          choices: [
            { name: `${ui.colors.primary('⚙️ ')} ${choices.general}`, value: choices.general },
            { name: `${ui.colors.info('🔍 ')} ${choices.search}`, value: choices.search },
            { name: `${ui.colors.warning('📦 ')} ${choices.extensions}`, value: choices.extensions },
            { name: `${ui.colors.success('🔗 ')} ${choices.links}`, value: choices.links },
            '---',
            { name: `${ui.colors.muted('◀️ ')} ${choices.back}`, value: choices.back }
          ]
        }
      ]);

      if (ans.act === choices.back) return;
      if (handlers[ans.act]) {
        try {
          ui.separator();
          await handlers[ans.act]();
          ui.separator();
        } catch (e) {
          ui.NotificationManager.instance.error(`Erro: ${e.message}`);
        }
      }
    }
  }

  return { settingsMenu };
};
