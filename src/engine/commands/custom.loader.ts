import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { globalCommandRegistry, CommandCategory } from './registry';

// A1 — user-defined slash commands. A `.bimax/commands/<name>.md` file becomes `/<name>`:
// its body is a prompt template that, when invoked, is rendered (with argument substitution)
// and submitted to the agent. Project commands override same-named home commands.
//
// Parsing + substitution are pure (unit-tested); loadCustomCommands does the fs + registry
// side effects at boot.

export interface ParsedCommand {
  description?: string;
  category?: string;
  body: string;
}

/**
 * Parse a command markdown file. Supports an optional YAML-ish front-matter block
 * (`---\nkey: value\n---`) for `description`/`category`; everything after it (or the whole
 * file when absent) is the prompt body.
 */
export function parseCommandFile(content: string): ParsedCommand {
  const normalized = content.replace(/\r\n/g, '\n');
  const fm = normalized.match(/^---\n([\s\S]*?)\n---\n?/);
  if (fm) {
    const meta: Record<string, string> = {};
    for (const line of fm[1].split('\n')) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)\s*$/);
      if (m) meta[m[1].toLowerCase()] = m[2].replace(/^["']|["']$/g, '').trim();
    }
    return { description: meta.description, category: meta.category, body: normalized.slice(fm[0].length).trim() };
  }
  const body = normalized.trim();
  const firstLine = body.split('\n').find(l => l.trim().length > 0) || '';
  return { description: firstLine.slice(0, 80) || undefined, body };
}

/**
 * Substitute arguments into a command body. `$ARGUMENTS` → all args joined; `$1…$9` →
 * positional args (missing → empty string). Pure.
 */
export function substituteArgs(body: string, args: string[]): string {
  return body
    .replace(/\$ARGUMENTS\b/g, args.join(' '))
    .replace(/\$([1-9])\b/g, (_, d) => args[Number(d) - 1] ?? '');
}

const VALID_CATEGORIES = new Set<CommandCategory>([
  'Configuration', 'Code & Intelligence', 'Source Control', 'General', 'Session & Context',
]);

/** Default lookup dirs: project `.bimax/commands` (wins) then `~/.bimax/commands`. */
export function defaultCommandDirs(cwd: string = process.cwd()): string[] {
  return [path.join(cwd, '.bimax', 'commands'), path.join(os.homedir(), '.bimax', 'commands')];
}

/**
 * Load every `*.md` command from the given dirs (first dir wins on name collisions) and
 * register each with the global registry. Returns the list of command names registered.
 * Best-effort: a missing dir or unreadable file is skipped, never thrown.
 */
export function loadCustomCommands(dirs: string[] = defaultCommandDirs()): string[] {
  const loaded = new Set<string>();
  for (const dir of dirs) {
    let files: string[];
    try {
      files = fs.readdirSync(dir).filter(f => f.toLowerCase().endsWith('.md'));
    } catch {
      continue; // dir absent / unreadable
    }
    for (const file of files) {
      const name = '/' + path.basename(file, path.extname(file)).toLowerCase();
      if (loaded.has(name)) continue; // earlier dir already provided this command
      let content: string;
      try {
        content = fs.readFileSync(path.join(dir, file), 'utf8');
      } catch {
        continue;
      }
      const parsed = parseCommandFile(content);
      const category = (parsed.category && VALID_CATEGORIES.has(parsed.category as CommandCategory))
        ? (parsed.category as CommandCategory)
        : 'General';
      globalCommandRegistry.register({
        name,
        description: parsed.description || `Custom command ${name}`,
        category,
        execute: async (args) => ({ type: 'redirect', command: substituteArgs(parsed.body, args) }),
      });
      loaded.add(name);
    }
  }
  return Array.from(loaded);
}
