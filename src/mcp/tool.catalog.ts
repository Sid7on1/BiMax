import { ToolRegistry } from '../tools/tool.registry';
import { BuiltTool } from '../tools/tool.factory';

/** A connection may remove only the exact tool objects it published. */
export class McpToolCatalog {
  private owned = new Map<string, BuiltTool>();
  readonly names: string[] = [];

  constructor(private readonly registry: ToolRegistry) {}

  replace(tools: BuiltTool[]): void {
    const next = new Map(tools.map(tool => [tool.name, tool]));
    if (next.size !== tools.length) throw new Error('MCP catalog contains duplicate tool names.');
    // Build/validate the whole catalog before touching the registry. Roll back only our own
    // attempted writes if a registry adapter rejects publication.
    const previous = new Map<string, BuiltTool | undefined>();
    try {
      for (const [name, tool] of next) {
        const existing = this.registry.getTool(name);
        previous.set(name, existing?.name === name ? existing : undefined);
        this.registry.register(tool);
      }
    } catch (error) {
      for (const [name, old] of previous) {
        if (this.registry.getTool(name) !== next.get(name)) continue;
        if (old) this.registry.register(old);
        else this.registry.unregister(name);
      }
      throw error;
    }
    for (const [name, old] of this.owned) {
      if (!next.has(name) && this.registry.getTool(name) === old) this.registry.unregister(name);
    }
    this.owned = next;
    this.names.splice(0, this.names.length, ...next.keys());
  }

  clear(): void {
    for (const [name, tool] of this.owned) {
      if (this.registry.getTool(name) === tool) this.registry.unregister(name);
    }
    this.owned.clear();
    this.names.splice(0);
  }
}
