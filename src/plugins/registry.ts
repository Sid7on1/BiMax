import { stateDir } from '../utils/state.dir';
import * as fs from 'fs/promises';
import * as path from 'path';
import { Logger } from '../utils';

export interface PluginManifest {
  id: string;
  capabilities: string[];
  installedAt: number;
}

export class PluginRegistry {
  private plugins: Map<string, PluginManifest> = new Map();
  private readonly REGISTRY_PATH = path.join(stateDir('.breakglass'), 'plugins', 'registry.json');

  constructor() {
    this.loadRegistry().catch(console.error);
  }

  private async loadRegistry() {
    try {
      const data = await fs.readFile(this.REGISTRY_PATH, 'utf-8');
      const items: PluginManifest[] = JSON.parse(data);
      items.forEach(p => this.plugins.set(p.id, p));
      Logger.info(`[Registry] Loaded ${items.length} plugins from persistent storage.`);
    } catch (e) {
      // File probably doesn't exist yet
    }
  }

  private async saveRegistry() {
    try {
      await fs.mkdir(path.dirname(this.REGISTRY_PATH), { recursive: true });
      const items = Array.from(this.plugins.values());
      await fs.writeFile(this.REGISTRY_PATH, JSON.stringify(items, null, 2), 'utf-8');
    } catch (e) {
      Logger.error(`[Registry] Failed to save registry to disk.`);
    }
  }

  async registerPlugin(manifest: PluginManifest) {
    this.plugins.set(manifest.id, manifest);
    await this.saveRegistry();
    Logger.info(`[Registry] New plugin persistently registered: ${manifest.id}`);
  }

  getCapabilities(): string[] {
    const caps = new Set<string>();
    for (const plugin of this.plugins.values()) {
      plugin.capabilities.forEach(cap => caps.add(cap));
    }
    return Array.from(caps);
  }

  getPlugins(): PluginManifest[] {
    return Array.from(this.plugins.values());
  }
}
