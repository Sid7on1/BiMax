import { globalCommandRegistry } from './registry';
import { getBlueprintEngine } from '../../blueprints/blueprint.engine';
import { getBlueprintCompiler } from '../../blueprints/blueprint.compiler';
import { DOMAIN_CATALOGS, getCatalog } from '../../blueprints/catalogs';

/**
 * /blueprint — inspect and manage the level-by-level Blueprints that Sketch Mode produces.
 *
 * /blueprint                  — list saved Blueprints
 * /blueprint show <slug>      — render a Blueprint (levels, selections, overrides)
 * /blueprint domains          — list the buildable domains and their levels
 * /blueprint build <slug>     — compile a Blueprint into concrete artifacts in .bimax/builds/<slug>/
 * /blueprint delete <slug>    — remove a Blueprint
 *
 * Authoring (create/select/override/import/build) happens conversationally via BlueprintTool while
 * you're in sketch mode (Shift+Tab) — this command is for browsing/managing what's been saved.
 */
globalCommandRegistry.register({
  name: '/blueprint',
  aliases: ['/bp'],
  description: 'Browse, build & manage Sketch-Mode Blueprints — list / show / domains / build / delete',
  category: 'Code & Intelligence',
  execute: async (args, _context) => {
    const eng = getBlueprintEngine();
    if (!eng) return { type: 'message', level: 'error', content: 'Blueprint engine not initialised. Restart BiMax in a project directory.' };
    const sub = (args[0] || '').toLowerCase();

    if (sub === 'domains') {
      const lines = Object.values(DOMAIN_CATALOGS).map(c =>
        `**${c.title}** (${c.domain}) — ${c.description}\n  levels: ${c.levels.map(l => l.title).join(' → ')}`);
      return { type: 'message', level: 'info', content: `Buildable domains:\n\n${lines.join('\n\n')}\n\nStart one in sketch mode (Shift+Tab): describe the idea and BiMax walks you level-by-level.` };
    }

    if (sub === 'show' || sub === 'inspect') {
      const slug = args.slice(1).join(' ').trim();
      const bp = slug ? eng.load(slug) : null;
      if (!bp) return { type: 'message', level: 'error', content: `Blueprint "${slug}" not found. Use /blueprint to list.` };
      return { type: 'message', level: 'info', content: eng.format(bp) };
    }

    if (sub === 'build' || sub === 'compile') {
      const slug = args.slice(1).join(' ').trim();
      const bp = slug ? eng.load(slug) : null;
      if (!bp) return { type: 'message', level: 'error', content: `Blueprint "${slug}" not found. Use /blueprint to list.` };
      const compiler = getBlueprintCompiler();
      if (!compiler) return { type: 'message', level: 'error', content: 'Blueprint compiler not initialised.' };
      const r = compiler.compile(bp);
      const lines = [
        `Compiled "${bp.slug}" (${getCatalog(bp.domain)?.title ?? bp.domain}) → ${r.outDir}/`,
        ...r.files.map(f => `  • ${f.path}`),
        ...r.notes.map(n => `  → ${n}`),
        '',
        'Shift+Tab to beast mode to execute/refine these in place.',
      ];
      return { type: 'message', level: 'success', content: lines.join('\n') };
    }

    if (sub === 'delete' || sub === 'rm') {
      const slug = args.slice(1).join(' ').trim();
      return eng.delete(slug)
        ? { type: 'message', level: 'success', content: `Blueprint "${slug}" deleted.` }
        : { type: 'message', level: 'error', content: `Blueprint "${slug}" not found.` };
    }

    // default: list
    const all = eng.list();
    if (!all.length) {
      return { type: 'message', level: 'info', content: 'No Blueprints yet. Shift+Tab into sketch mode and describe an idea — BiMax will build one with you. /blueprint domains shows what you can build.' };
    }
    const lines = all.map(b => `• \`${b.slug}\`  [${getCatalog(b.domain)?.title ?? b.domain}]  ${b.goal}`);
    return { type: 'message', level: 'info', content: `Saved Blueprints (${all.length}):\n${lines.join('\n')}\n\n/blueprint show <slug> to view · Shift+Tab to beast mode to build.` };
  },
});
