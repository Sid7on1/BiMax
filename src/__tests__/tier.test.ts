import '../engine/commands/tier';
import { globalCommandRegistry } from '../engine/commands/registry';
import { engineEvents } from '../engine/events';

function getCmd(name: string): any {
  return (globalCommandRegistry as any).commands.get(name);
}

describe('/tier — manual model-tier control', () => {
  it('registers with /model-tier + /route aliases', () => {
    expect(getCmd('/tier')).toBeDefined();
    expect(getCmd('/model-tier')).toBe(getCmd('/tier'));
    expect(getCmd('/route')).toBe(getCmd('/tier'));
  });

  it.each(['auto', 'lite', 'heavy'])('emits set_tier "%s" without a transcript message', async (sub) => {
    const seen: string[] = [];
    const onSet = (t: string) => seen.push(t);
    engineEvents.on('set_tier', onSet);
    try {
      const res = await getCmd('/tier').execute([sub], {} as any);
      // Returns 'none' (no transcript line) — feedback rides on the set_tier → status/model_tier
      // events so rapid Ctrl+T cycling doesn't stack redundant "Routing pinned →" lines.
      expect(res.type).toBe('none');
    } finally {
      engineEvents.off('set_tier', onSet);
    }
    expect(seen).toEqual([sub]);
  });

  it('returns a picker menu for a bare /tier', async () => {
    const res = await getCmd('/tier').execute([], {} as any);
    expect(res.type).toBe('menu');
    expect(res.options.map((o: any) => o.value)).toEqual(['/tier auto', '/tier lite', '/tier heavy']);
  });

  it('ignores an invalid tier and shows the menu instead', async () => {
    let emitted = false;
    const onSet = () => { emitted = true; };
    engineEvents.on('set_tier', onSet);
    try {
      const res = await getCmd('/tier').execute(['turbo'], {} as any);
      expect(res.type).toBe('menu');
    } finally {
      engineEvents.off('set_tier', onSet);
    }
    expect(emitted).toBe(false);
  });
});
