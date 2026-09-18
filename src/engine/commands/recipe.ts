import { globalCommandRegistry } from './registry';
import { getGlobalRecipeLoader } from '../../recipes/recipe.loader';

// Recipes currently mid-run, by name. Sub-recipes re-dispatch via executeCommand('/recipe run X'),
// so a circular reference (A → B → A) would recurse until the stack overflows. This set breaks the
// cycle: a recipe already running is skipped rather than re-entered.
const _runningRecipes = new Set<string>();

/**
 * /recipe — YAML-based configurable task configurations.
 *
 * /recipe                — list available recipes
 * /recipe run <name>     — inject a recipe's instructions into the agent and execute
 * /recipe show <name>    — preview a recipe without running it
 * /recipe new <name>     — scaffold a new recipe YAML in .bimax/recipes/
 */
globalCommandRegistry.register({
  name: '/recipe',
  aliases: ['/rec'],
  description: 'YAML-defined task configurations — list / run / scaffold recipes',
  category: 'Code & Intelligence',
  execute: async (args, context) => {
    const loader = getGlobalRecipeLoader();
    if (!loader) {
      return { type: 'message', level: 'error', content: 'Recipe loader not initialised. Restart BiMax in a project directory.' };
    }

    const sub = (args[0] || '').toLowerCase();

    // /recipe new <name>
    if (sub === 'new' || sub === 'create') {
      const name = args.slice(1).join(' ').trim() || 'my-recipe';
      const filePath = loader.scaffoldExample(name);
      return { type: 'message', level: 'success', content: `Recipe scaffold created: ${filePath}\nEdit it with your instructions, then run /recipe run ${name}.` };
    }

    // /recipe show <name>
    if (sub === 'show' || sub === 'inspect') {
      const name = args.slice(1).join(' ').trim();
      const recipe = loader.getByName(name);
      if (!recipe) return { type: 'message', level: 'error', content: `Recipe "${name}" not found. Use /recipe to list available recipes.` };
      const lines = [
        `**Recipe: ${recipe.name}**`,
        recipe.description ? `Description: ${recipe.description}` : '',
        `File: ${recipe.filePath}`,
        '',
        '**Instructions:**',
        recipe.instructions,
      ];
      if (recipe.extensions?.length) lines.push('', `Extensions: ${recipe.extensions.join(', ')}`);
      if (recipe.sub_recipes?.length) lines.push(`Sub-recipes: ${recipe.sub_recipes.join(', ')}`);
      if (recipe.success_checks?.length) lines.push(`Success checks: ${recipe.success_checks.join(', ')}`);
      if (recipe.retry) lines.push(`Retry: ${recipe.retry}`);
      return { type: 'message', level: 'info', content: lines.filter(l => l !== undefined).join('\n') };
    }

    // /recipe run <name>
    if (sub === 'run' || sub === 'exec' || sub === 'execute') {
      const name = args.slice(1).join(' ').trim();
      if (!name) return { type: 'message', level: 'error', content: 'Usage: /recipe run <name>' };

      const recipe = loader.getByName(name);
      if (!recipe) return { type: 'message', level: 'error', content: `Recipe "${name}" not found. Use /recipe to list available recipes.` };

      // Cycle guard: refuse to re-enter a recipe already running in this chain (A → B → A).
      if (_runningRecipes.has(recipe.name)) {
        return { type: 'message', level: 'error', content: `Recipe cycle detected: "${recipe.name}" is already running (sub-recipe loop). Skipping to avoid infinite recursion.` };
      }

      _runningRecipes.add(recipe.name);
      try {
        // Run sub-recipes first (executeCommand is only available in interactive TUI context)
        if (recipe.sub_recipes && recipe.sub_recipes.length > 0) {
          if (!context.executeCommand) {
            context.addSystemMessage('info', `Sub-recipes (${recipe.sub_recipes.join(', ')}) skipped — not in interactive context.`);
          } else {
            context.addSystemMessage('info', `Running sub-recipes: ${recipe.sub_recipes.join(', ')}`);
            for (const subName of recipe.sub_recipes) {
              await context.executeCommand(`/recipe run ${subName}`);
            }
          }
        }
      } finally {
        _runningRecipes.delete(recipe.name);
      }

      // Surface the recipe instructions as a formatted message.
      // The user can submit these instructions directly or copy them into the prompt.
      const checks = recipe.success_checks?.length
        ? `\n\nAfter completing the above, verify success by checking:\n${recipe.success_checks.map(c => `  - ${c}`).join('\n')}`
        : '';
      return {
        type: 'message',
        level: 'info',
        content: `**Recipe: ${recipe.name}**\n\nPaste or submit the following instructions to the agent:\n\n---\n${recipe.instructions}${checks}\n---`,
      };
    }

    // /recipe — list all
    const all = loader.list();
    if (all.length === 0) {
      return {
        type: 'message',
        level: 'info',
        content: `No recipes found in ${loader.recipesDir}.\n\nCreate one with: /recipe new <name>`,
      };
    }

    return {
      type: 'menu',
      title: `Recipes (${all.length} found in ${loader.recipesDir})`,
      options: [
        { label: '[+] New recipe…', value: '__new__', desc: 'Scaffold a new recipe YAML' },
        ...all.map(r => ({
          label: r.name,
          value: r.name,
          desc: r.description ?? r.instructions.slice(0, 80),
        })),
      ],
      onSelect: (opt: any) => {
        if (opt.value === '__new__') {
          context.setActivePrompt?.({
            title: 'Recipe name:',
            onResolve: (name: string) => { if (name.trim()) context.executeCommand(`/recipe new ${name.trim()}`); },
          });
        } else {
          context.executeCommand(`/recipe run ${opt.value}`);
        }
      },
    };
  },
});
