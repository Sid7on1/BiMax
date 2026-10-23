import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { EpistemicLedger } from '../mind/epistemic.ledger';
import { reliabilityTrack, renderCalibration } from '../engine/commands/calibration';

const mk = () => new EpistemicLedger(fs.mkdtempSync(path.join(os.tmpdir(), 'bgw-calcmd-')));

describe('/calibration — reliability diagram (reuses the epistemic ledger)', () => {
  it('reliabilityTrack marks the ideal and fills to observed', () => {
    // Overconfident: observed (20%) well left of ideal (90%) — fill stops before the ┃.
    const over = reliabilityTrack(0.2, 0.9, 20);
    expect(over).toContain('┃');
    expect(over.indexOf('█')).toBeLessThan(over.indexOf('┃'));
    // On-target: observed ≈ ideal — fill reaches the mark.
    const onTarget = reliabilityTrack(0.5, 0.5, 20);
    expect(onTarget).toContain('┃');
  });

  it('empty ledger explains how claims resolve instead of drawing a curve', () => {
    const out = renderCalibration(mk());
    expect(out).toMatch(/not enough evidence/i);
    expect(out).not.toMatch(/ECE/); // no curve without data
  });

  it('renders ECE, a reliability row, and flags overconfidence when claims fail', () => {
    const led = mk();
    // 6 claims stated at 90% that all FAIL → strongly overconfident in the 90–100% decile.
    for (let i = 0; i < 6; i++) led.openClaim('ts', 0.9, `src/f${i}.ts`);
    led.resolve(false, { command: 'npm test', output: Array.from({ length: 6 }, (_, i) => `FAIL src/f${i}.ts`).join('\n') });

    const out = renderCalibration(led);
    expect(out).toMatch(/ECE \d+%/);
    expect(out).toMatch(/reliability/);
    expect(out).toMatch(/90–100%/);        // the populated decile row
    expect(out).toMatch(/overconfident/i); // the fill sits left of the ideal mark
  });
});
