import { PUBLIC_DESKTOP_ACTIONS } from '../desktop.runtime';
import { MAC_CONTROL_SCHEMA } from '../server';

describe('mac_control public tool contract', () => {
  it('publishes the runtime action vocabulary from its single existing owner', () => {
    expect(MAC_CONTROL_SCHEMA.properties.action.enum).toEqual([...PUBLIC_DESKTOP_ACTIONS]);
  });

  it('keeps the public surface provider-neutral and Desktop-named', () => {
    expect(MAC_CONTROL_SCHEMA.properties.action.enum).toEqual(expect.arrayContaining([
      'status', 'observe', 'click', 'type', 'focus', 'screenshot',
    ]));
    expect(JSON.stringify(MAC_CONTROL_SCHEMA)).not.toContain('ComputerTool');
  });

  it('publishes Menu mutations but never lets the model widen background delivery', () => {
    expect(MAC_CONTROL_SCHEMA.properties.action.enum).toEqual(expect.arrayContaining([
      'menu_activate', 'menu_search',
    ]));
    expect(MAC_CONTROL_SCHEMA.properties).not.toHaveProperty('deliveryMode');
  });
});
