import * as fs from 'fs';
import * as path from 'path';

/**
 * Opening a file must reveal the editor.
 *
 * The editor and the four lanes share one panel, and `showEditor` requires `requestedTab === null`.
 * Opening a file FROM the Files lane leaves a requested lane set, so every other piece of state was
 * updated correctly — openFiles, activeFile, inspectorOpen — and the panel went on rendering the
 * file tree. The click looked completely inert, with no error anywhere.
 *
 * This is asserted on source because the coupling IS the bug: two independent pieces of state in
 * one component decide whether the editor appears, and a unit test of either one alone passes
 * while the pair stays broken.
 */
describe('clicking a file opens the editor', () => {
  const app = fs.readFileSync(
    path.resolve(__dirname, '..', 'renderer', 'src', 'App.tsx'), 'utf8',
  );

  const openFileBody = (): string => {
    const start = app.indexOf('const openFile = useCallback(');
    expect(start).toBeGreaterThan(-1);
    return app.slice(start, app.indexOf('}, [', start));
  };

  test('openFile clears the requested lane, which is what reveals the editor', () => {
    expect(openFileBody()).toContain('setRequestedTab(null)');
  });

  test('openFile still sets the file it was asked to open', () => {
    const body = openFileBody();
    expect(body).toContain('setActiveFile(rel)');
    expect(body).toContain('setInspectorOpen(true)');
  });

  test('showEditor still depends on there being no requested lane', () => {
    // If this coupling is ever removed the test above stops meaning anything, so it is pinned too.
    expect(app).toMatch(/const showEditor =[^;]*requestedTab === null/s);
  });
});
