import React from '../../../../app/node_modules/react';
import { createRoot } from '../../../../app/node_modules/react-dom/client';
import { Transcript } from '../../../../app/src/renderer/src/components/Transcript';
import { EngineStore } from '../../../../app/src/renderer/src/engine.store';
import { initialEngineState } from '../../../../app/src/renderer/src/engine.state';
const root = createRoot(document.getElementById('root')!);
const store = new EngineStore(initialEngineState);
const input = JSON.stringify({ operation: 'workflow', pid: 123, window_id: 7, steps: [{ action: 'SET_VALUE', control: 'Message', value: 'fixture' }, { action: 'CLICK', control: 'Save', expect: { role: 'StaticText', value: 'Saved: fixture' } }] });
function render(status: 'running' | 'success' | 'error') {
  root.render(<Transcript store={store} onMenuSelect={() => {}} items={[{ kind: 'tool', call: {
    id: 'cu-fixture', toolName: 'BimaxCuTool', input, output: 'Fixture diagnostics only',
    status, startTime: '2026-10-07T00:00:00Z', ...(status === 'running' ? {} : { endTime: '2026-10-07T00:00:01Z' }),
  } }]} />);
}
(window as any).probe = { render, input };
render('running');
