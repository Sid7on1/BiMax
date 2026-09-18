import * as fs from 'fs';
import * as path from 'path';
import { globalCommandRegistry } from './registry';
import { globalSkillService } from '../../skills/skill.service';

const SKILL_TEMPLATE = (name: string) => `---
name: ${name}
description: One sentence on what this skill does and WHEN to use it (the model reads this to decide).
# allowed-tools: BashTool, ReadFileTool   # optional, advisory
---

# ${name}

Write the step-by-step instructions the agent should follow when this skill is loaded.

1. ...
2. ...

Put any helper scripts or templates next to this SKILL.md; the agent can read or run them.
`;

// Agent Skills — model-invoked capability packs (SKILL.md). Distinct from JSON agent personas,
// which are listed under /agents.
globalCommandRegistry.register({
  name: '/skills',
  category: 'Configuration',
  description: 'List / create Agent Skills (SKILL.md capability packs)',
  execute: async (args, context) => {
    const sub = (args[0] || '').toLowerCase();

    if (sub === 'new') {
      const name = (args[1] || '').toLowerCase().replace(/[^a-z0-9-]/g, '-');
      if (!name) return { type: 'message', level: 'error', content: 'Usage: /skills new <name>' };
      const dir = path.join(context.cwd, '.bimax', 'skills', name);
      const file = path.join(dir, 'SKILL.md');
      if (fs.existsSync(file)) return { type: 'message', level: 'info', content: `Skill '${name}' already exists at ${file}.` };
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file, SKILL_TEMPLATE(name), 'utf8');
      globalSkillService.load(context.cwd);
      return { type: 'message', level: 'success', content: `Created ${file} — edit it, then /skills reload.` };
    }

    // Default + `/skills reload`: (re)scan and list.
    globalSkillService.load(context.cwd);
    const skills = globalSkillService.list();
    if (skills.length === 0) {
      return {
        type: 'message',
        level: 'info',
        content: 'No Agent Skills installed. Create one with /skills new <name> (writes .bimax/skills/<name>/SKILL.md). JSON agent personas are under /agents.',
      };
    }
    return {
      type: 'menu',
      title: 'Agent Skills (model-invoked via SkillTool)',
      options: skills.map(s => ({
        label: s.name,
        value: `skill:${s.name}`,
        desc: `${s.description.slice(0, 70)}${s.description.length > 70 ? '…' : ''} · ${s.source}`,
      })),
      onSelect: (opt: any) => {
        const name = String(opt.value).replace(/^skill:/, '');
        const s = globalSkillService.get(name);
        if (s) context.addSystemMessage('info', `${s.name} — ${s.description}\nSource: ${s.dir}`);
      },
    };
  },
});
