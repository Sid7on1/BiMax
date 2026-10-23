/** Additive presentation data. Never conveys tool, filesystem, or approval authority. */
export type OutputFormat =
  | 'markdown'
  | 'document'
  | 'code'
  | 'html'
  | 'react'
  | 'vega-lite'
  | 'mermaid'
  | 'table'
  | 'form';
export interface OutputVersion {
  id: string;
  sha256: string;
  byteLength: number;
  createdAt: string;
}
export interface OutputRecord {
  id: string;
  ownerThreadId: string;
  producerRunId: string;
  title: string;
  format: OutputFormat;
  language?: string;
  createdAt: string;
  updatedAt: string;
  versions: OutputVersion[];
}
export interface OutputDocument {
  record: OutputRecord;
  version: OutputVersion;
  content: string;
  state: 'available' | 'missing' | 'changed';
}
export type PresentationPart =
  | { kind: 'data'; id: string; value: unknown }
  | { kind: 'image'; id: string; mimeType: string; data: string }
  | { kind: 'resource'; id: string; uri: string; title?: string; mimeType?: string; text?: string }
  | { kind: 'output'; id: string; outputId: string; versionId: string; title: string }
  | {
      kind: 'mcp-app';
      id: string;
      server: string;
      tool: string;
      resourceUri: string;
      input: unknown;
      result: unknown;
    };
export interface EngineNotice {
  id: string;
  category: 'pricing' | 'configuration';
  text: string;
}
export interface PresentationResult {
  parts: PresentationPart[];
}

/** Reject oversized/unsupported data at either side of the wire. No remote image requests. */
export function presentationParts(value: unknown): PresentationPart[] {
  if (!Array.isArray(value)) return [];
  const result: PresentationPart[] = [];
  let bytes = 0;
  for (const part of value.slice(0, 16)) {
    if (!part || typeof part !== 'object' || typeof part.id !== 'string' || part.id.length > 200) continue;
    let size: number;
    try {
      size = JSON.stringify(part).length;
    } catch {
      continue;
    }
    if (size > 2_800_000 || (bytes += size) > 4_000_000) break;
    if (
      part.kind === 'image' &&
      /^(image\/png|image\/jpeg|image\/webp|image\/gif)$/.test(part.mimeType) &&
      typeof part.data === 'string' &&
      /^[A-Za-z0-9+/]*={0,2}$/.test(part.data)
    )
      result.push(part);
    else if (part.kind === 'data' && part.value !== undefined) result.push(part);
    else if (part.kind === 'resource' && typeof part.uri === 'string' && part.uri.length < 2000)
      result.push(part);
    else if (
      part.kind === 'output' &&
      [part.outputId, part.versionId, part.title].every((v) => typeof v === 'string' && v.length < 200)
    )
      result.push(part);
    else if (
      part.kind === 'mcp-app' &&
      [part.server, part.tool, part.resourceUri].every((v) => typeof v === 'string' && v.length < 2000) &&
      part.resourceUri.startsWith('ui://')
    )
      result.push(part);
  }
  return result;
}
