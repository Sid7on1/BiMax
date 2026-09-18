import { globalCommandRegistry } from './registry';
import { routeToModel, explainRoute, decideSlot } from '../task.router';

/**
 * `/route` — show which model a prompt would be served by, and why.
 *
 * PS 26117 asks for a demonstration of "model auto selection across at least two different task
 * types". A demonstration needs an artefact: watching two prompts get two answers proves nothing
 * about which model produced them. This prints the slot, the signal that fired, and the model
 * chosen, without spending a turn or a token — so the claim can be checked rather than believed.
 */
globalCommandRegistry.register({
  name: '/route',
  aliases: ['/slot'],
  category: 'Configuration',
  description: 'Explain which model a prompt routes to, and on what signal',
  execute: async (args, _context) => {
    const prompt = args.join(' ').trim();
    if (!prompt) {
      return {
        type: 'message',
        level: 'error',
        content: 'Usage: /route <prompt>\n\n'
          + 'Examples that take different routes:\n'
          + '  /route refactor the tokenizer to stream\n'
          + '  /route read the scanned inspection report and list the findings\n'
          + '  /route draft an approval note as a Word document\n'
          + '  /route what is the difference between let and const',
      };
    }
    // `attachments` deliberately stays empty here: the command classifies the TEXT so an evaluator
    // can retype a prompt and reproduce the decision. A real turn passes its actual attachments,
    // which outrank any textual signal.
    const choice = routeToModel(prompt);
    return { type: 'message', level: 'info', content: explainRoute(prompt, choice) };
  },
});

/** Exported for the headless surface, which renders decisions rather than command output. */
export { decideSlot };
