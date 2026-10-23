import type { QuickContext, QuickThread } from '../../shared/threads';

type QuickBootstrapApi = Pick<Window['bimax']['threads'], 'context' | 'quickCurrent' | 'onContext' | 'onQuickThread'>;
interface QuickBootstrapHandlers {
  context(value: QuickContext, initial: boolean): void;
  thread(value: QuickThread | null): void;
  error(reason: string): void;
}

/** The floating bar's initial read and authoritative selection/context broadcasts. */
export function subscribeQuickBootstrap(api: QuickBootstrapApi, handlers: QuickBootstrapHandlers): () => void {
  let live = true;
  let contextChanged = false;
  let threadChanged = false;
  const offContext = api.onContext(value => { contextChanged = true; handlers.context(value, false); });
  const offThread = api.onQuickThread(value => { threadChanged = true; handlers.thread(value); });
  // These replies were captured before a later broadcast. They cannot select the old chat again
  // or erase newly selected folder/attachment context, even when the newer selection is New/null.
  void api.context().then(value => {
    if (live && !contextChanged) handlers.context(value, true);
  }).catch(error => {
    if (live && !contextChanged) handlers.error(`Could not read folder context: ${String(error instanceof Error ? error.message : error)}`);
  });
  void api.quickCurrent().then(value => {
    if (live && !threadChanged) handlers.thread(value);
  }).catch(error => {
    if (live && !threadChanged) handlers.error(`Could not read the current chat: ${String(error instanceof Error ? error.message : error)}`);
  });
  return () => { live = false; offContext(); offThread(); };
}
