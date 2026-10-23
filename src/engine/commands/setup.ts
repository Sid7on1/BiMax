import { globalCommandRegistry } from './registry';
import { getProviders, setProvider, getCurrentProvider, buildKeyPool } from '../provider';
import { saveApiKeyToEnv } from '../env.loader';
import { curatedModelMenuOptions, isReasoningModel, DEFAULT_LITE_MODEL } from '../models';
import { engineEvents } from '../events';

/**
 * /setup — the guided first-run wizard: provider → API key → model, three explicit steps.
 *
 * Design rules (per the CLI onboarding redesign):
 *  - NOTHING is auto-picked. The user chooses the provider, pastes the key, and picks the model
 *    themselves — the wizard never silently lands them on a default they didn't choose.
 *  - Every provider row carries the URL where its key actually lives (rendered as a clickable
 *    OSC-8 link in the TUI), so "go get a key" is one click, not a search.
 *  - The model step defaults to "one model for everything" — the split coding/lite/sub-agent
 *    slots stay one hop away in /model for people who want them.
 *  - Runs automatically on a keyless first launch (headless.entry), and stays re-runnable any
 *    time via /setup.
 */

// Picking a provider without a key drops the user straight onto the page where the key is minted:
// the URL is opened in their default browser AND copied to the clipboard (both best-effort — a
// headless/SSH box just skips them and the OSC-8 link in the prompt title still works).
function openKeyPage(url: string): void {
  const { spawn } = require('child_process') as typeof import('child_process');
  const opener = process.platform === 'darwin' ? ['open', url]
    : process.platform === 'win32' ? ['cmd', '/c', 'start', '', url]
    : ['xdg-open', url];
  try { spawn(opener[0], opener.slice(1), { stdio: 'ignore', detached: true }).unref(); } catch { /* no GUI */ }
  try {
    if (process.platform === 'darwin') {
      const pb = spawn('pbcopy', [], { stdio: ['pipe', 'ignore', 'ignore'] });
      pb.stdin.end(url);
    }
  } catch { /* clipboard optional */ }
}

// Where each provider's API keys are minted. Shown as the wizard's clickable links.
const KEY_PAGES: Record<string, { url: string; note: string }> = {
  nvidia: { url: 'https://build.nvidia.com', note: 'Free tier — generous limits, no card needed' },
  openai: { url: 'https://platform.openai.com/api-keys', note: 'Paid — GPT-4o and friends' },
  anthropic: { url: 'https://console.anthropic.com/settings/keys', note: 'Paid — Claude models' },
  openrouter: { url: 'https://openrouter.ai/keys', note: 'One key, many models (incl. free ones)' },
  deepseek: { url: 'https://platform.deepseek.com/api_keys', note: 'Cheap strong coder models' },
  google: { url: 'https://aistudio.google.com/apikey', note: 'Free tier — Gemini models' },
};

function stepModel(context: any): void {
  // Fetch the fresh provider's live model list (the key was applied moments ago), then present
  // the CURATED picker — explicit choice, never an auto-selected default.
  void (async () => {
    let live: string[] | null = null;
    try {
      const ids = await context.options?.llmAdapter?.listProviderModels?.();
      if (ids && ids.length) live = ids;
    } catch { /* offline / no models endpoint — curated catalog still works */ }

    const applyEverywhere = (model: string) => {
      // Reasoners never fill the lite slot (no API switch turns their thinking off — small talk
      // and aux calls would each hide 20-30s of CoT). Quick replies run on the plain lite default.
      const lite = isReasoningModel(model) ? DEFAULT_LITE_MODEL : model;
      try { context.options?.llmAdapter?.applyConfig?.({ model, liteModel: lite }); } catch { /* optional */ }
      context.options.model = model;
      (context.options as any).liteModel = lite;
      context.saveConfig({ model, liteModel: lite, subagentModel: '', onboardingKeysDone: true });
      engineEvents.emit('config_changed');
      context.addSystemMessage('success', lite === model
        ? `You're set: everything runs on ${model}.`
        : `You're set: ${model} does the work · ${lite} answers quick replies instantly.`);
      context.addSystemMessage('info',
        'Quickstart — just describe an outcome ("explain this codebase", "fix the failing test"). ' +
        'Useful next: /help commands · /model change models · Shift+Tab cycles agent modes · Ctrl+A live sub-agents.');
    };

    context.setActiveMenu?.({
      title: 'Step 3 of 3 — Pick your model',
      subtitle: 'Runs everything · split slots later via /model',
      options: [
        ...curatedModelMenuOptions(live, context.options?.model),
        {
          label: '⌕ Browse all…',
          value: '__browse__',
          desc: live ? `All ${live.length} ids on ${getCurrentProvider().name}` : 'Full provider catalog',
          category: 'More',
        },
        { label: '✎ Custom id…', value: '__custom__', desc: 'Type any model id', category: 'More' },
      ],
      onSelect: (opt: any) => {
        if (opt.value === '__browse__') { context.executeCommand?.('/model browse one'); return; }
        if (opt.value === '__custom__') {
          context.setActivePrompt({
            title: 'Enter a model id (e.g. publisher/model-name)',
            onResolve: (val: string) => {
              const id = (val || '').trim();
              if (id) applyEverywhere(id);
              else context.addSystemMessage('info', 'No model id entered — run /setup or /model when ready.');
            },
          });
          return;
        }
        applyEverywhere(opt.value);
      },
    });
  })();
}

function stepKey(providerName: string, context: any): void {
  const match = getProviders().find(p => p.name === providerName);
  if (!match) return;
  const page = KEY_PAGES[providerName];
  context.setActivePrompt({
    title: `Step 2 of 3 — Paste your ${match.name} API key${page ? ` (get one: ${page.url})` : ''}`,
    isMasked: true,
    onResolve: (keyStr: string) => {
      const key = (keyStr || '').trim();
      if (!key) {
        context.addSystemMessage('info', 'No key entered — run /setup again when you have one.');
        return;
      }
      try {
        saveApiKeyToEnv(match.apiKeyEnv, key);
        process.env[match.apiKeyEnv] = key;
        try { context.options?.llmAdapter?.setKeys?.(buildKeyPool()); } catch { /* adapter optional */ }
        context.addSystemMessage('success', `${match.apiKeyEnv} saved to ~/.breakglass/.env — keys stay on this machine.`);
        stepModel(context);
      } catch (e: any) {
        context.addSystemMessage('error', `Failed to save key: ${e.message}`);
      }
    },
  });
}

globalCommandRegistry.register({
  name: '/setup',
  aliases: ['/onboard', '/start'],
  description: 'Guided setup — pick a provider, add your key, choose your model',
  category: 'Configuration',
  execute: async (_args, context) => {
    const providers = getProviders();
    return {
      type: 'menu',
      title: 'Welcome to Bimax — Step 1 of 3 — Choose your AI provider',
      subtitle: 'Bimax is the harness; you bring the model. Your key is stored locally and sent only to the provider you pick.',
      options: providers.map(p => {
        const page = KEY_PAGES[p.name];
        const hasKey = !!process.env[p.apiKeyEnv];
        return {
          label: hasKey ? `● ${p.name}` : p.name,
          value: p.name,
          desc: `${page?.note || p.baseURL}${hasKey ? ' · key already set' : ''}`,
          category: page && page.note.startsWith('Free') ? 'Free to start' : 'Bring a paid key',
          link: page?.url,
        };
      }),
      onSelect: (opt: any) => {
        const found = setProvider(opt.value);
        if (!found) return;
        try { saveApiKeyToEnv('BGW_PROVIDER', opt.value); } catch { /* persistence optional */ }
        if (process.env[found.apiKeyEnv]) {
          context.addSystemMessage('success', `Provider: ${found.name} (key already configured).`);
          stepModel(context);
        } else {
          const page = KEY_PAGES[opt.value];
          if (page) {
            openKeyPage(page.url);
            context.addSystemMessage('info', `Opening ${page.url} in your browser (link copied) — grab a key, then paste it below.`);
          }
          stepKey(opt.value, context);
        }
      },
    };
  },
});
