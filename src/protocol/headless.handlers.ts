import { engineEvents } from '../engine/events';
import type { HeadlessSession } from './headless.session';
import type { HostHandlers } from './host';
import { createConfigWire } from './config.wire';
import { buildCatalog, type CatalogDeps } from './catalog.wire';
import { getProviders, getProvider, getCurrentProvider, setProvider } from '../engine/provider';
import { saveApiKeyToEnv } from '../engine/env.loader';
import { MODEL_CATALOG } from '../engine/models';
import { capabilitiesFor } from '../core/capabilities';
import { completeInput } from './completions';
import { getConfig, saveConfig } from '../engine/config';

/**
 * What the engine does with each message the app sends (split out of startHeadless, flaw list C19): input,
 * interrupts, steering, completions (and the Composer's ingest), menus, resume, controls, settings, the model
 * catalogue and the provider switch.
 */
export function buildHostHandlers(deps: { session: HeadlessSession; graphStore: any; llmAdapter: any }): HostHandlers {
  const { session, graphStore, llmAdapter } = deps;
  // Settings surface (protocol v3): the allowlisted, JSON-safe subset of EngineConfig a graphical
  // front-end may read and write directly — the silent path behind settings pages, replacing
  // transcript menus. The allowlist, the persistence and the live-adapter application all live in
  // protocol/config.wire.ts so the seam is testable without booting a container; see that file for
  // why a read-back of the config FILE is not proof that anything took effect.
  const configWire = createConfigWire({
    getConfig: () => getConfig() as any,
    saveConfig: (updates) => saveConfig(updates as any),
    llmAdapter,
    onChanged: () => engineEvents.emit('config_changed'), // re-snapshot + notify every front-end
  });
  const configSubset = (): Record<string, any> => configWire.read();

  // The provider + model catalogue behind the desktop's model picker. `listServed` is the live
  // `/models` call, so the picker offers ids the provider genuinely accepts instead of a hand-typed
  // list that drifts — and `capabilities` lets the UI grey out a knob a model does not have rather
  // than sending a parameter the backend will reject the whole request over.
  const catalogDeps: CatalogDeps = {
    getProviders: () => getProviders(),
    activeProvider: () => getCurrentProvider(),
    catalog: () =>
      MODEL_CATALOG.map((m) => ({
        label: m.label,
        value: m.value,
        desc: m.desc,
        tier: m.tier,
        avoidAutoSelect: m.avoidAutoSelect,
        recommendedFor: m.recommendedFor,
        tags: m.tags,
        parameters: m.parameters,
        releaseDate: m.releaseDate,
      })),
    listServed: (refresh) => llmAdapter.listProviderModels(refresh),
    capabilities: (provider, id) => capabilitiesFor(provider, id) as any,
    readEnv: (name) => process.env[name],
  };
  const buildVisibleCatalog = (refresh: boolean) => buildCatalog(catalogDeps, 0, refresh);

  // The handlers are the same whatever the transport; only how messages travel differs.
  return {
    onInput: (text) => {
      void session.dispatch(text);
    },
    onInterrupt: () => session.interrupt(),
    onSteer: (text) => session.steer(text),
    onQuery: async (text) => {
      // The completions channel doubles as the Composer's ingest channel.
      //
      // Attaching a file must READ IT THERE AND THEN, the way every assistant people already use
      // does. Deferring to send time is what made the model appear to "go find the file and read
      // it": the path travelled in the prompt, and the reading was visible work inside the turn.
      // Ingesting at attach means that by the time a turn runs, the document is already parsed and
      // only its passages travel.
      //
      // Carried on `query` deliberately: it is already a request/response channel with an id, so
      // this needs no new message type, no protocol version bump, and no regenerated mirror. The
      // reserved prefix cannot collide with a completion — completions are what the user typed.
      const INGEST = '\u0000composer:ingest:';
      if (text.startsWith(INGEST)) {
        const file = text.slice(INGEST.length);
        try {
          const { getComposerCorpus } = require('../memory/corpus') as typeof import('../memory/corpus');
          const corpus = getComposerCorpus();
          if (!corpus) return [{ label: 'unavailable', value: '', kind: 'path' as const, desc: 'no corpus' }];
          const report = await corpus.ingest([file], 'session');
          const entry = report.ingested[0];
          if (entry) {
            return [{
              label: 'read', value: String(entry.chunks), kind: 'path' as const,
              desc: entry.ocr ? 'ocr' : '',
            }];
          }
          // Unchanged means an identical file is already indexed — still "read" from the user's
          // point of view, and reporting it as a failure would be a lie about the corpus.
          if (report.unchanged) return [{ label: 'read', value: '0', kind: 'path' as const, desc: '' }];
          return [{
            label: 'failed', value: '0', kind: 'path' as const,
            desc: report.skipped[0]?.reason || 'no readable text',
          }];
        } catch (error) {
          return [{ label: 'failed', value: '0', kind: 'path' as const, desc: String((error as Error)?.message || error) }];
        }
      }
      return completeInput(text, graphStore, process.cwd());
    },
    onMenuSelect: (id, value) => session.selectMenu(id, value),
    // Typed recovery resume (protocol v3 additive): same code path as the user's /resume, but
    // requested as a structured message so front-ends never fabricate slash-command text.
    onResume: (id) => {
      void session.dispatch(`/resume ${id}`);
    },
    onControls: async ({ mode, tier, autonomy }) => {
      // One wire message, one serialized sequence. In particular, every non-plan autonomy preset
      // exits plan mode first, so the chrome can never claim edits are enabled while PLAN still
      // blocks them in the governor.
      const { getAgentMode } = require('../engine/agentMode') as typeof import('../engine/agentMode');
      const preservedMode = getAgentMode();
      const commands: Record<string, string[]> = {
        ask: ['/plan off', '/governor on', '/diff-approval on'],
        auto: ['/plan off', '/governor on', '/diff-approval off'],
        plan: ['/plan on'],
        full: ['/plan off', '/governor off', '/diff-approval off'],
      };
      for (const command of autonomy ? (commands[autonomy] ?? []) : []) await session.dispatch(command);
      // /plan on|off emits the legacy mode_change event for the TUI. Re-apply the behavioral mode
      // afterwards so Code/Beast/Explore/Sketch never visually collapse to General, and their
      // governor gate remains the final authority for combinations such as Explore + Full auto.
      if (mode || autonomy) await session.dispatch(`/mode ${mode ?? preservedMode}`);
      if (tier) await session.dispatch(`/tier ${tier}`);
    },
    onConfigGet: configSubset,
    onConfigSet: (patch) => configWire.write(patch),
    onCatalogGet: async (refresh) => {
      const { t, id, ...rest } = await buildVisibleCatalog(refresh);
      return rest;
    },
    onProviderSet: async ({ name, baseURL, apiKey }) => {
      const provider = getProvider(name);
      if (!provider) return { providers: [], models: [], error: `Unknown provider "${name}".` };

      // Save the key BEFORE switching, so the catalogue fetch that answers this request is made
      // with the credential the user just supplied — that round-trip is how they find out whether
      // the key works, and asking them to press refresh afterwards to discover a typo is a worse
      // answer than simply using it. saveApiKeyToEnv writes owner-only, refuses to follow a
      // symlink, and updates process.env so the running key pool picks it up without a restart.
      if (apiKey) {
        try {
          saveApiKeyToEnv(provider.apiKeyEnv, apiKey);
        } catch (e: any) {
          return { providers: [], models: [], error: `Could not save the key: ${String(e?.message || e)}` };
        }
      }

      setProvider(name);
      // Persist, so the choice survives a restart — the whole point of the `provider` config key.
      // Without this the switch lives in a module variable and every relaunch silently reverts.
      await saveConfig({ provider: name, ...(baseURL ? { providerBaseURL: baseURL } : {}) } as any);
      // A new provider means a new key pool, a new endpoint and a different served-model list; the
      // session cache belongs to the old one, so force a refresh rather than answering from it.
      const { t, id, ...rest } = await buildVisibleCatalog(true);
      engineEvents.emit('config_changed');
      return rest;
    },
  };
}
