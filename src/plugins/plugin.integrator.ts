import { stateDir } from '../utils/state.dir';
import * as fs from 'fs/promises';
import * as path from 'path';
import { PluginRegistry } from './registry';
import { Logger } from '../utils';

export class PluginIntegrator {
  private readonly INSTALLED_DIR = path.join(stateDir('.breakglass'), 'plugins', 'installed');

  constructor(private registry: PluginRegistry) {}

  async integrate(analysis: any, dirPath: string): Promise<void> {
    Logger.info(`[PluginIntegrator] Migrating ${analysis.name} into main workspace...`);
    
    await fs.mkdir(this.INSTALLED_DIR, { recursive: true });
    const targetPath = path.join(this.INSTALLED_DIR, analysis.name.replace(/[^a-zA-Z0-9_-]/g, '_'));
    
    try {
      // Physically copy the plugin
      await fs.cp(dirPath, targetPath, { recursive: true });
      
      // Register
      await this.registry.registerPlugin({
        id: analysis.name,
        capabilities: analysis.providesCapabilities,
        installedAt: Date.now()
      });
      
      Logger.info(`[PluginIntegrator] ✅ Successfully integrated new capabilities! Installed at: ${targetPath}`);
    } catch (e: any) {
      Logger.error(`[PluginIntegrator] Failed to integrate plugin: ${e.message}`);
      throw e;
    }
  }
}
