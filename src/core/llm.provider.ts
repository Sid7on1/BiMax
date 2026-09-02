import { ContentPart } from './multimodal';

export interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool';
  // String for text turns (the overwhelming common case); an OpenAI content-part array only for a
  // user turn that carries image attachments (see core/multimodal.ts). All text-path transforms
  // guard on `typeof content === 'string'`, so the array form is inert outside the vision flow.
  content?: string | ContentPart[];
  tool_call_id?: string;
  name?: string;
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[];
  /**
   * Some native-thinking providers require the complete prior assistant message on the next tool
   * round. Kimi K3 is one: dropping this field after a tool call makes the continuation invalid.
   * It is never rendered as reply content.
   */
  reasoning_content?: string;
}

export interface ChatOptions {
  system?: string;
  tools?: any[]; // We'll pass the JSON Schema tool definitions here
  temperature?: number;
  maxTokens?: number;
  reasoningEffort?: string; // 'low' | 'medium' | 'high' — when set, sent as reasoning_effort
  signal?: AbortSignal;
  lite?: boolean; // route this call to the configured LITE model (cheap aux work), if one is set
  /** Require one specific native function call for this round. Used only while an operation is
   * still unresolved; final answer rounds return to automatic tool selection. */
  toolChoice?: { type: 'function'; function: { name: string } };
}

export type ChatEvent =
  | { type: 'token'; text: string }
  | { type: 'thinking'; text: string; replay?: boolean } // Internal reasoning; replay only when the provider contract requires it
  // Note: args comes in as a string. `truncated` marks a call the model was still writing when it
  // hit the output-token ceiling — its arguments are cut mid-JSON, so a parse failure here is OUR
  // limit being reached, not the model emitting garbage, and the two need different advice.
  | { type: 'tool_call'; id: string; name: string; args: string; truncated?: boolean }
  // Live, still-streaming tool call — args is the partial (possibly invalid) JSON accumulated so
  // far. Emitted only when the model supports partial-JSON tool streaming (caps.partialJsonTools);
  // display-only, the authoritative call still arrives as a final `tool_call`. Consumers that don't
  // render live activity can ignore it.
  | { type: 'tool_call_partial'; id: string; name: string; args: string }
  | { type: 'usage'; prompt: number; completion: number }
  // The stream stopped because the model hit the output-token ceiling (finish_reason: 'length'), not
  // because it finished — the answer is cut off. Only emitted when no tool call was produced.
  | { type: 'truncated' }
  // `kind` tells the agent loop *how* to recover: 'context' → compact and retry;
  // 'transient' → bounded re-ask (new key / re-sampled output). Absent when fatal.
  | { type: 'error'; message: string; recoverable: boolean; kind?: 'context' | 'transient'; retryAfterSecs?: number }
  | { type: 'done' };

export interface LLMProvider {
  chat(messages: Message[], options: ChatOptions): AsyncGenerator<ChatEvent>;
}
