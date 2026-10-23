import fs from 'node:fs';
import path from 'node:path';

/**
 * The workbench's enlarge control fills the window between the sidebar and the right edge (owner, 2026-09-30: "it just
 * moves the panel a little wider … it must touch the left panel"). It used to call setLayout within the panel limits
 * (task ≥ 34%, panel ≤ 65%). Measured in headless Chrome with the real library at 1200px: sidebar 216 → 216, task
 * 575 → 0, panel 407 → 983; given back, 216/575/407 and the library layout 18/48/34 exactly; no sidebar, 1200.
 * These pin the parts that make that true.
 */

const read = (rel: string) => fs.readFileSync(path.join(__dirname, '..', 'renderer', 'src', rel), 'utf8');
const app = read('App.tsx');
const css = read('styles.css');
const toggle = app.slice(app.indexOf('const toggleWide'), app.indexOf('/** Start a fresh task.'));

test('enlarging never goes through the library layout, whose limits made it a small widen', () => {
  expect(toggle).not.toMatch(/setLayout/);
  expect(toggle).toMatch(/100 - sidebar/);
});

test('the conversation leaves the flow, its separator goes, and the panel takes the sidebar-free share', () => {
  expect(css).toMatch(/\[data-inspector-wide\] :is\(\[data-panel\]\[id="task"\][^{]*\{ flex: 0 0 0px !important;[^}]*visibility: hidden;/);
  expect(css).toMatch(/\[data-inspector-wide\] :is\(\[data-panel\]\[id="task"\][^{]*\) \+ \[data-separator\] \{ display: none; \}/);
  expect(css).toMatch(/\[data-inspector-wide\] :is\(\[data-panel\]\[id="inspector"\][^{]*\{ flex-grow: var\(--inspector-wide-grow\) !important; \}/);
  expect(app).toMatch(/data-inspector-wide=\{wide \? '' : undefined\}/);
  expect(app).toMatch(/'--inspector-wide-grow': String\(wideGrow\)/);
});

test('with no sidebar holding the corner, the panel clears the traffic lights and can drag the window', () => {
  expect(app).toMatch(/data-edge-free=\{wide && !\(hasProject && sidebarMounted && sidebarPinned\)/);
  expect(css).toMatch(/\[data-edge-free\] \.workbench-strip \{ padding-left: 80px; -webkit-app-region: drag; \}/);
  expect(css).toMatch(/\[data-edge-free\] \.workbench-strip :is\(button, \[role="button"\], input\) \{ -webkit-app-region: no-drag; \}/);
});

test('hiding the panel, or a new project or task, gives the conversation back', () => {
  expect(app).toMatch(/useLayoutEffect\(\(\) => \{ if \(!inspectorOpen\) setWideGrow\(null\); \}, \[inspectorOpen\]\)/);
  const reset = app.slice(app.indexOf('// New project → the open files'), app.indexOf('}, [state.project, state.threadId]);', app.indexOf('// New project → the open files')));
  expect(reset).toMatch(/setWideGrow\(null\)/);
});
