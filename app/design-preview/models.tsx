import React, { useCallback, useMemo, useState } from 'react';
import { ModelDialog } from '../src/renderer/src/components/ModelDialog';
import type { EngineCatalog, EngineConfig } from '../src/renderer/src/protocol';

/**
 * Model-window harness.
 *
 * The catalogue here is a FIXTURE, but it is shaped from the real engine's own recorded findings so
 * the states that matter are actually representable: the current default, an inventory-listed route
 * whose completion probe failed, an unmeasured candidate, and a model the catalogue bars from
 * auto-selection because a live probe timed out on it. A fixture that only contained healthy rows
 * would let the window look finished while every warning path went unrendered.
 */

const MODELS: EngineCatalog['models'] = [
  {
    id: 'moonshotai/kimi-k3',
    label: 'Kimi K3',
    desc: 'Default Work and Vision route; current NIM model with 1M context and native multimodal tools.',
    tier: 'coding',
    recommendedFor: ['coding', 'vision'],
    served: true,
    curated: true,
    tags: ['coding', 'agentic', 'vision', 'tools', 'reasoning'],
    parameters: '2.8T · 104B active',
    releaseDate: '2026-08-20',
    capabilities: {
      visionInput: true,
      reasoningEffortKnob: true,
      thinking: true,
      structuredOutputs: true,
      parallelToolCalls: false,
      contextWindow: 1048576,
    },
  },
  {
    id: 'nvidia/nemotron-3.5-lightning-30b-a3b',
    label: 'Nemotron 3.5 Lightning',
    desc: 'Current agent route; Bimax task probe pending.',
    tier: 'coding',
    recommendedFor: ['coding'],
    served: true,
    curated: true,
    avoidAutoSelect: true,
    tags: ['coding', 'agentic', 'reasoning'],
    parameters: '30B · 3B active',
    releaseDate: '2026-08-11',
    capabilities: {
      visionInput: false,
      reasoningEffortKnob: true,
      thinking: true,
      structuredOutputs: true,
      parallelToolCalls: true,
      contextWindow: 1048576,
    },
  },
  {
    id: 'deepseek-ai/deepseek-v4-pro-0813',
    label: 'DeepSeek V4 Pro 0813',
    desc: 'Current 1M-context coding route; Bimax latency and tool probe pending.',
    tier: 'coding',
    recommendedFor: ['coding'],
    served: true,
    curated: true,
    avoidAutoSelect: true,
    tags: ['coding', 'reasoning'],
    releaseDate: '2026-08-26',
    capabilities: {
      visionInput: false,
      reasoningEffortKnob: false,
      thinking: true,
      structuredOutputs: false,
      parallelToolCalls: true,
      contextWindow: 1048576,
    },
  },
  {
    id: 'openai/gpt-oss-120b',
    label: 'GPT-OSS 120B',
    desc: 'Timed out on all four 60s probes; opt in only.',
    tier: 'coding',
    recommendedFor: ['coding'],
    served: true,
    curated: true,
    avoidAutoSelect: true,
    tags: ['coding', 'reasoning'],
    parameters: '120B',
    releaseDate: '2025-08-05',
    capabilities: {
      visionInput: false,
      reasoningEffortKnob: true,
      thinking: true,
      structuredOutputs: true,
      parallelToolCalls: true,
      contextWindow: 131072,
    },
  },
  {
    id: 'mistralai/mistral-7b-instruct-v0.3',
    label: 'Mistral 7B Instruct',
    desc: 'Default Quick model; current plain instruct route.',
    tier: 'lite',
    recommendedFor: ['lite'],
    served: true,
    curated: true,
    tags: ['quick', 'instruct', 'plain'],
    parameters: '7B',
    releaseDate: '2024-05-22',
    capabilities: {
      visionInput: false,
      reasoningEffortKnob: false,
      thinking: false,
      structuredOutputs: false,
      parallelToolCalls: false,
      contextWindow: 32768,
    },
  },
  {
    id: 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning',
    label: 'Nemotron 3 Nano Omni',
    desc: 'Faster on paper, but chose a WRONG click on both grounded frames.',
    tier: 'vision',
    recommendedFor: ['vision', 'coding'],
    served: true,
    curated: true,
    avoidAutoSelect: true,
    tags: ['vision', 'agentic', 'reasoning'],
    parameters: '30B · 3B active',
    releaseDate: '2026-04-28',
    capabilities: {
      visionInput: true,
      reasoningEffortKnob: false,
      thinking: false,
      structuredOutputs: true,
      parallelToolCalls: false,
      contextWindow: 131072,
    },
  },
  {
    id: '01-ai/yi-large',
    label: '01-ai/yi-large',
    desc: 'Served by this provider — not curated by Bimax',
    tier: 'other',
    served: true,
    curated: false,
    capabilities: {
      visionInput: true,
      reasoningEffortKnob: true,
      thinking: true,
      structuredOutputs: true,
      parallelToolCalls: false,
      contextWindow: 262144,
    },
  },
];

const PROVIDERS: EngineCatalog['providers'] = [
  {
    name: 'nvidia',
    label: 'NVIDIA NIM',
    baseURL: 'https://integrate.api.nvidia.com/v1',
    apiKeyEnv: 'NVIDIA_API_KEY',
    hasKey: true,
    keyCount: 3,
    keyHint: '…4f2a',
    active: true,
  },
  {
    name: 'openai',
    label: 'OpenAI',
    baseURL: 'https://api.openai.com/v1',
    apiKeyEnv: 'OPENAI_API_KEY',
    hasKey: true,
    keyCount: 1,
    keyHint: '…9c11',
    active: false,
  },
  {
    name: 'openrouter',
    label: 'OpenRouter',
    baseURL: 'https://openrouter.ai/api/v1',
    apiKeyEnv: 'OPENROUTER_API_KEY',
    hasKey: false,
    keyCount: 0,
    active: false,
  },
  {
    name: 'deepseek',
    label: 'DeepSeek',
    baseURL: 'https://api.deepseek.com/v1',
    apiKeyEnv: 'DEEPSEEK_API_KEY',
    hasKey: false,
    keyCount: 0,
    active: false,
  },
];

/** Mimics the engine seam: the write is echoed from LOADED state, so a rejected slot can be shown. */
export function ModelsPreview(): React.ReactElement {
  const [open, setOpen] = useState(true);
  const [config, setConfig] = useState<EngineConfig>({
    model: 'moonshotai/kimi-k3',
    liteModel: 'mistralai/mistral-7b-instruct-v0.3',
    visionModel: 'moonshotai/kimi-k3',
    subagentModel: '',
    fallbackModel: '',
    reasoningEffort: '',
    maxThinkingTokens: 0,
  } as EngineConfig);
  const [providers, setProviders] = useState(PROVIDERS);

  const configGet = useCallback(async () => config, [config]);
  const configSet = useCallback(
    async (patch: EngineConfig) => {
      const next = { ...config, ...patch };
      setConfig(next);
      return next;
    },
    [config],
  );

  const catalog = useMemo<EngineCatalog>(() => ({ providers, models: MODELS }), [providers]);
  const catalogGet = useCallback(async () => catalog, [catalog]);
  const providerSet = useCallback(
    async ({ name }: { name: string }) => {
      const next = providers.map((p) => ({ ...p, active: p.name === name }));
      setProviders(next);
      return { providers: next, models: MODELS };
    },
    [providers],
  );

  return (
    <div style={{ minHeight: 560 }}>
      {!open && (
        <button
          onClick={() => setOpen(true)}
          style={{
            padding: '8px 14px',
            borderRadius: 8,
            cursor: 'pointer',
            border: '1px solid #8884',
            background: 'transparent',
            color: 'inherit',
            font: '500 12px/1.4 system-ui',
          }}
        >
          Open the model window
        </button>
      )}
      <ModelDialog
        open={open}
        onClose={() => setOpen(false)}
        configGet={configGet}
        configSet={configSet}
        catalogGet={catalogGet}
        providerSet={providerSet}
      />
    </div>
  );
}
