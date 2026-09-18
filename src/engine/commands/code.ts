import { globalCommandRegistry } from './registry';
import { engineEvents } from '../events';
import { runTypeCheck, runLint, formatErrors } from '../lintFixLoop';

globalCommandRegistry.register({
  name: '/index',
  description: 'Build AST codebase index',
  category: 'Code & Intelligence',
  execute: async (args, context) => {
    // Wipe the current project's map (e.g. a stale/huge one from accidentally indexing a parent dir).
    if (args[0] === 'clear') {
      try {
        context.graphStore?.clear?.();
        await context.graphStore?.saveToDisk?.();
        engineEvents.emit('graph_changed');
        return { type: 'message', level: 'success', content: 'Codebase map cleared. cd into a specific project and run /index to build a focused one.' };
      } catch (err: any) {
        return { type: 'message', level: 'error', content: `Could not clear the map: ${err.message}` };
      }
    }

    if (args[0] !== 'force') {
      return {
        type: 'menu',
        title: 'Codebase Map',
        options: [
          { label: '[ Start Indexing ]', value: '/index force', desc: 'Parse all files under the current directory' },
          { label: '[ Clear current map ]', value: '/index clear', desc: 'Remove the existing map (use if it indexed the wrong/parent folder)' },
          { label: '[ Cancel ]', value: 'cancel', desc: 'Do nothing' }
        ]
      };
    }

    if (!context.codebaseIndexer) {
      return { type: 'message', level: 'error', content: 'Codebase indexer not available' };
    }

    context.addSystemMessage('info', 'Building AST codebase index...');
    try {
      const count = await context.codebaseIndexer.buildAstIndex();
      engineEvents.emit('graph_changed');
      // A graph this big almost always means a parent/home folder was indexed (dependencies, other
      // projects). Point the user at running inside the specific project for a focused, useful map.
      if (count > 20000) {
        return {
          type: 'message', level: 'success',
          content: `AST Indexing complete — ${count.toLocaleString()} nodes. That's very large; you likely indexed a parent or home folder. For a focused map, cd into the specific project (cwd shown in the footer) and run /index there.`,
        };
      }
      return { type: 'message', level: 'success', content: `AST Indexing complete! Extracted ${count.toLocaleString()} nodes.` };
    } catch (err: any) {
      return { type: 'message', level: 'error', content: `Indexing failed: ${err.message}` };
    }
  }
});

globalCommandRegistry.register({
  name: '/index-ai',
  description: 'Run Semantic AI index',
  category: 'Code & Intelligence',
  isEnabled: (ctx) => {
    if (!ctx.graphStore || ctx.graphStore.getGraph().nodes.size === 0) {
      return { enabled: false, reason: 'Requires AST Index — run /index first' };
    }
    return { enabled: true };
  },
  execute: async (args, context) => {
    const store = context.graphStore;
    if (!store || store.getGraph().nodes.size === 0) {
      return { type: 'message', level: 'error', content: 'Dependency graph is empty. Run /index first.' };
    }
    if (args[0] !== 'force') {
      return {
        type: 'menu',
        title: 'Run Semantic AI Index?',
        options: [
          { label: '[ Start AI Indexing ]', value: '/index-ai force', desc: 'Uses tokens to semantically process AST nodes' },
          { label: '[ Cancel ]', value: 'cancel', desc: 'Do nothing' }
        ]
      };
    }

    if (!context.codebaseIndexer) {
      return { type: 'message', level: 'error', content: 'Codebase indexer not available' };
    }

    context.addSystemMessage('info', 'Running Semantic AI index...');
    try {
      await context.codebaseIndexer.buildSemanticIndex();
      engineEvents.emit('graph_changed');
      return { type: 'message', level: 'success', content: 'Semantic AI Indexing complete! The graph now has full semantic intelligence.' };
    } catch (err: any) {
      return { type: 'message', level: 'error', content: `Semantic indexing failed: ${err.message}` };
    }
  }
});

globalCommandRegistry.register({
  name: '/check',
  description: 'Type check (tsc)',
  category: 'Code & Intelligence',
  execute: async (args, context) => {
    if (args[0] !== 'force') {
      return {
        type: 'menu',
        title: 'Run TypeScript Type Check?',
        options: [
          { label: '[ Run Type Check ]', value: '/check force', desc: 'Runs tsc in the current workspace' },
          { label: '[ Cancel ]', value: 'cancel', desc: 'Do nothing' }
        ]
      };
    }

    context.addSystemMessage('info', 'Running type check...');
    try {
      const tc = await runTypeCheck(context.cwd);
      return { type: 'message', level: tc.success ? 'success' : 'error', content: formatErrors(tc) };
    } catch (err: any) {
      return { type: 'message', level: 'error', content: `Type check failed: ${err.message}` };
    }
  }
});

globalCommandRegistry.register({
  name: '/lint',
  description: 'Run ESLint',
  category: 'Code & Intelligence',
  execute: async (args, context) => {
    if (args[0] !== 'force') {
      return {
        type: 'menu',
        title: 'Run ESLint?',
        options: [
          { label: '[ Run Linter ]', value: '/lint force', desc: 'Runs eslint in the current workspace' },
          { label: '[ Cancel ]', value: 'cancel', desc: 'Do nothing' }
        ]
      };
    }

    context.addSystemMessage('info', 'Running linter...');
    try {
      const lint = await runLint(context.cwd);
      return { type: 'message', level: lint.success ? 'success' : 'error', content: formatErrors(lint) };
    } catch (err: any) {
      return { type: 'message', level: 'error', content: `Lint failed: ${err.message}` };
    }
  }
});
