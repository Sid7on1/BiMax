export type {
  OutputFormat,
  OutputRecord,
  OutputVersion,
  OutputDocument,
  PresentationPart,
} from '../../../src/protocol/presentation';
export interface OutputInput {
  key: string;
  title: string;
  format: import('../../../src/protocol/presentation').OutputFormat;
  content: string;
  language?: string;
  outputId?: string;
  baseVersion?: string;
}
export interface PreviewBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface PreviewEvent {
  ownerThreadId: string;
  token: string;
  level: 'log' | 'error' | 'state';
  text: string;
}
export interface McpAppRequest {
  server: string;
  tool: string;
  resourceUri: string;
  input: unknown;
  result: unknown;
}
