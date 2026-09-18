import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
// Type-only: reading skill names must not pull in base.persona's runtime graph.
// `DynamicPersona` lives in ./personas/dynamic.persona.ts — see the note there.
import type { PersonaConfig } from './personas/base.persona';
import { Logger } from '../utils/logger';

export class SkillLoader {
  private static skills: Record<string, PersonaConfig> = {};

  public static loadSkills(): Record<string, PersonaConfig> {
    this.skills = {}; // Reset

    // Search paths
    const searchPaths = [
      path.join(process.cwd(), '.breakglass', 'skills'),
      path.join(os.homedir(), '.breakglass', 'skills'),
      path.join(__dirname, '../../skills') // Built-in skills
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
              this.skills[id] = config;
              Logger.info(`[SkillLoader] Loaded skill: ${config.name} (${id})`);
            } else {
              Logger.warn(`[SkillLoader] Invalid skill format in ${file}`);
            }
          } catch (e: any) {
            Logger.warn(`[SkillLoader] Failed to load skill ${file}: ${e.message}`);
          }
        }
      }
    }

    return this.skills;
  }

  public static getSkill(id: string): PersonaConfig | undefined {
    return this.skills[id.toLowerCase()];
  }

  public static getAllSkills(): Record<string, PersonaConfig> {
    return this.skills;
  }
}
