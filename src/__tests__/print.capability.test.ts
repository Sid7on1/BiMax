import { executePrintMode } from '../engine/print';
import { reportCapability, resetCapabilityStatus } from '../core/capability.status';
import { engineEvents } from '../engine/events';

jest.mock('../engine/personas/implementations', () => ({
  BiMaxPersona: class {
    async execute(_prompt: string, token: (text: string) => void) {
      reportCapability({ id: 'fixture', label: 'Fixture capability', state: 'unavailable',
        reason: 'Provider failed.', impact: 'Reduced results.', action: 'Retry.' });
      token('Answer');
    }
  },
}));

test('plain CLI prints proactive notices on stderr without verbose mode and detaches afterward', async () => {
  resetCapabilityStatus();
  reportCapability({ id: 'early', label: 'Early capability', state: 'degraded', reason: 'Failed at boot.', impact: '', action: '' });
  const stderr = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
  const stdout = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
  const listeners = engineEvents.listenerCount('message');
  try {
    await executePrintMode('fixture', { agent: 'bimax', verbose: false } as any);
    const errors = stderr.mock.calls.map(c => c[0]).join('');
    expect(errors).toContain('Early capability: degraded');
    expect(errors).toContain('Fixture capability: unavailable');
    expect(stdout.mock.calls.map(c => c[0]).join('')).toBe('Answer\n');
    expect(engineEvents.listenerCount('message')).toBe(listeners);
  } finally { stderr.mockRestore(); stdout.mockRestore(); resetCapabilityStatus(); }
});
