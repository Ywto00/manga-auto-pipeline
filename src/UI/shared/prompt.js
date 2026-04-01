const inquirer = require('inquirer');

const prompt = (inquirer && inquirer.prompt)
  ? inquirer.prompt.bind(inquirer)
  : (inquirer && inquirer.createPromptModule)
    ? inquirer.createPromptModule()
    : null;

function ensurePrompt() {
  if (!prompt) throw new Error('Inquirer prompt not available; please ensure inquirer is installed');
  return prompt;
}

module.exports = {
  prompt,
  ensurePrompt
};