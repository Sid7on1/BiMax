import * as fs from 'fs';
import * as path from 'path';
import { inspectorTabs, resolveWorkbenchTab } from '../renderer/src/inspector.model';

/**
 * Opening a file must reveal the file.
 *
 * The original defect: the editor and the four lanes shared one panel, and `showEditor` required
 * `requestedTab === null`. Opening a file FROM the Files lane left a requested lane set, so every
 * other piece of state was updated correctly — openFiles, activeFile, inspectorOpen — and the panel
 * went on rendering the file tree. The click looked completely inert, with no error anywhere.
 *
 * This file used to assert that coupling — `showEditor` contains `requestedTab === null`, and
 * `openFile` nulls it — which pinned the WORKAROUND. The 2026-09-19 merge into one tabbed
 * workbench deleted the mode flag: a lane and a file are one `WorkbenchTab`, and asking for a file
 * IS how the file is shown. So the property is asserted instead, once where it is decided (the
 * resolver) and once where it is requested (App), because a resolver that works cannot help a
 * caller that never asks.
 */
describe('clicking a file opens the file', () => {
  const app = fs.readFileSync(
    path.resolve(__dirname, '..', 'renderer', 'src', 'App.tsx'), 'utf8',
  );

  const openFileBody = (): string => {
    const start = app.indexOf('const openFile = useCallback(');
    expect(start).toBeGreaterThan(-1);
    return app.slice(start, app.indexOf('}, [', start));
  };

  test('a file requested while a lane is selected wins — no flag has to be cleared first', () => {
    const tabs = inspectorTabs({ review: null, gitStatus: null, hasProject: true, isRepo: false });
    const open = ['src/api/client.ts'];
    expect(resolveWorkbenchTab(tabs, { kind: 'lane', id: 'files' }, open)).toEqual({ kind: 'lane', id: 'files' });
    expect(resolveWorkbenchTab(tabs, { kind: 'file', path: 'src/api/client.ts' }, open))
      .toEqual({ kind: 'file', path: 'src/api/client.ts' });
  });

  test('openFile asks for the file it was given', () => {
    expect(openFileBody()).toMatch(/setRequestedTab\(\{\s*kind:\s*'file',\s*path:\s*rel\s*\}\)/);
  });

  test('openFile still records the file and reveals the panel', () => {
    const body = openFileBody();
    expect(body).toContain('setActiveFile(rel)');
    expect(body).toContain('setInspectorOpen(true)');
  });

  test('and the mode flag that caused the dead click is gone for good', () => {
    expect(app).not.toContain('showEditor');
    expect(app).not.toMatch(/requestedTab === null/);
  });
});
