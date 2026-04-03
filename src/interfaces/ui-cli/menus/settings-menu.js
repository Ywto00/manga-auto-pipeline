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
      const ans = await prompt([
        {
          type: 'list',
          name: 'act',
          message: t('menu.settings.title'),
          choices: [
            choices.general,
            choices.search,
            choices.extensions,
            choices.links,
            choices.back
          ]
        }
      ]);

      if (ans.act === choices.back) return;
      if (handlers[ans.act]) await handlers[ans.act]();
    }
  }

  return { settingsMenu };
};
