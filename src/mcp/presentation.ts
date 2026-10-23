import { presentationParts, type PresentationPart } from '../protocol/presentation';

/** Preserve presentation separately; the existing model-facing string stays unchanged. */
export function mcpPresentation(server: string, tool: any, input: unknown, result: any): PresentationPart[] {
  const parts: PresentationPart[] = [];
  if (result?.structuredContent !== undefined)
    parts.push({ kind: 'data', id: 'structured', value: result.structuredContent });
  for (const [i, c] of (Array.isArray(result?.content) ? result.content : []).entries()) {
    if (c?.type === 'image')
      parts.push({ kind: 'image', id: `media-${i}`, mimeType: c.mimeType, data: c.data });
    if (c?.type === 'resource' && c.resource?.uri)
      parts.push({
        kind: 'resource',
        id: `embedded-${i}`,
        uri: c.resource.uri,
        mimeType: c.resource.mimeType,
        ...(typeof c.resource.text === 'string' ? { text: c.resource.text } : {}),
      });
    if (c?.type === 'resource' && c.resource?.blob && c.resource?.mimeType?.startsWith('image/'))
      parts.push({
        kind: 'image',
        id: `embedded-image-${i}`,
        mimeType: c.resource.mimeType,
        data: c.resource.blob,
      });
    if (c?.type === 'resource_link')
      parts.push({
        kind: 'resource',
        id: `resource-${i}`,
        uri: c.uri,
        title: c.title || c.name,
        mimeType: c.mimeType,
      });
  }
  const resourceUri =
    tool?._meta?.ui?.resourceUri || tool?._meta?.['ui/resourceUri'] || tool?._meta?.['openai/outputTemplate'];
  if (typeof resourceUri === 'string' && resourceUri.startsWith('ui://')) {
    parts.push({
      kind: 'mcp-app',
      id: 'app',
      server,
      tool: tool.name,
      resourceUri,
      input,
      result: {
        content: result?.content,
        structuredContent: result?.structuredContent,
        _meta: result?._meta,
        isError: result?.isError,
      },
    });
  }
  return presentationParts(parts);
}
