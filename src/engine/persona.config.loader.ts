import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
// Type-only: reading persona names must not pull in base.persona's runtime graph.
// `DynamicPersona` lives in ./personas/dynamic.persona.ts — see the note there.
import type { PersonaConfig } from './personas/base.persona';
import { Logger } from '../utils/logger';

/** Legacy JSON persona configurations; Agent Skills are exclusively SKILL.md via SkillService. */
export class PersonaConfigLoader {
  private static personas: Record<string, PersonaConfig> = {};

  public static loadPersonas(): Record<string, PersonaConfig> {
    this.personas = {}; // Reset

    // Compatibility paths: existing JSON personas keep loading without a data migration.
    const searchPaths = [
      path.join(process.cwd(), '.breakglass', 'skills'),
      path.join(os.homedir(), '.breakglass', 'skills'),
      path.join(__dirname, '../../skills') // Built-in persona configs
    ];

    for (const dir of searchPaths) {
      if (!fs.existsSync(dir)) continue;

      const files = fs.readdirSync(dir);
      for (const file of files) {
        if (file.endsWith('.json')) {
          try {
            const content = fs.readFileSync(path.join(dir, file), 'utf-8');
            const config = JSON.parse(content) as PersonaConfig;
            
            // Basic validation
            if (config.name && config.roleDescription && Array.isArray(config.allowedTools)) {
              const id = path.basename(file, '.json').toLowerCase();
              this.personas[id] = config;
              Logger.info(`[PersonaConfigLoader] Loaded persona: ${config.name} (${id})`);
            } else {
              Logger.warn(`[PersonaConfigLoader] Invalid persona format in ${file}`);
            }
          } catch (e: any) {
            Logger.warn(`[PersonaConfigLoader] Failed to load persona ${file}: ${e.message}`);
          }
        }
      }
    }

    return this.personas;
  }

  public static getPersona(id: string): PersonaConfig | undefined {
    return this.personas[id.toLowerCase()];
  }

  public static getAllPersonas(): Record<string, PersonaConfig> {
    return this.personas;
  }
}
