import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PolicyArms } from '../mind/policy.arms';
import { EventLedger } from '../mind/event.ledger';

describe('policy arms (v2 §4.4) — propensity logging + self-normalized IPS', () => {
  let dir: string;
  let ledger: EventLedger;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bgw-arms-'));
    ledger = new EventLedger(dir);
  });
  afterEach(() => {
    ledger.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('an active arm shows outside the holdout and logs {shown, propensity} to the ledger', () => {
    const arms = new PolicyArms(dir, { rng: () => 0.5, holdout: 0.1 }); // 0.5 ≥ 0.1 → show
    const d = arms.decide('habits', ledger);
    expect(d).toEqual({ show: true, propensity: 0.9 });
    const ev = ledger.byType('policy_active');
    expect(ev).toHaveLength(1);
    expect(ev[0].payload).toEqual({ arm: 'habits', shown: true, propensity: 0.9 });
  });

  it('the holdout hides the block but the propensity is what makes it evidence', () => {
    const arms = new PolicyArms(dir, { rng: () => 0.05, holdout: 0.1 }); // 0.05 < 0.1 → hold out
    expect(arms.decide('habits', ledger)).toEqual({ show: false, propensity: 0.9 });
  });

  it('a shadowed arm never shows, keeps logging, and persists its status', () => {
    const arms = new PolicyArms(dir, { rng: () => 0.99, holdout: 0.1 });
    arms.setStatus('drives', 'shadow');
    expect(arms.decide('drives', ledger)).toEqual({ show: false, propensity: 0 });
    expect(new PolicyArms(dir).status('drives')).toBe('shadow'); // survives a restart
    expect(ledger.byType('policy_status')[0]?.payload ?? null).toBeNull(); // status event went to the SINGLETON ledger, decision to ours
    expect(ledger.byType('policy_active')).toHaveLength(1);
  });

  it('foldRewards joins decisions to their episode and scores it by tool success', () => {
    const arms = new PolicyArms(dir, { holdout: 0.1 });
    // Episode 1: habits shown, all tools green → reward 1.
    ledger.append('policy_active', { arm: 'habits', shown: true, propensity: 0.9 });
    ledger.append('tool_outcome', { status: 'ok' });
    ledger.append('tool_outcome', { status: 'ok' });
    ledger.append('boundary', {});
    // Episode 2: habits held out, tools mostly red → reward 0.
    ledger.append('policy_active', { arm: 'habits', shown: false, propensity: 0.9 });
    ledger.append('tool_outcome', { status: 'error' });
    ledger.append('tool_outcome', { status: 'error' });
    ledger.append('tool_outcome', { status: 'ok' });
    ledger.append('boundary', {});
    // Episode 3: one lonely tool call — below the signal floor, skipped entirely.
    ledger.append('policy_active', { arm: 'habits', shown: true, propensity: 0.9 });
    ledger.append('tool_outcome', { status: 'ok' });
    ledger.append('boundary', {});

    const folded = arms.foldRewards(ledger);
    expect(folded['habits']).toEqual([
      { shown: true, propensity: 0.9, reward: 1 },
      { shown: false, propensity: 0.9, reward: 0 },
    ]);
    // rejected/blocked outcomes are preference data and never count against an episode:
    ledger.append('policy_active', { arm: 'drives', shown: true, propensity: 0.9 });
    ledger.append('tool_outcome', { status: 'ok' });
    ledger.append('tool_outcome', { status: 'rejected' });
    ledger.append('tool_outcome', { status: 'ok' });
    ledger.append('boundary', {});
    expect(arms.foldRewards(ledger)['drives'][0].reward).toBe(1);
  });

  it('IPS: weighting by 1/propensity recovers per-policy values and the lift', () => {
    const arms = new PolicyArms(dir);
    const samples = [
      { shown: true, propensity: 0.9, reward: 1 },
      { shown: true, propensity: 0.9, reward: 1 },
      { shown: true, propensity: 0.9, reward: 0 },
      { shown: false, propensity: 0.9, reward: 0 }, // the 10% holdout — hidden episodes went worse
      { shown: false, propensity: 0.9, reward: 0 },
    ];
    const { vShow, vHide, lift } = arms.ipsEstimate(samples);
    expect(vShow).toBeCloseTo(2 / 3);
    expect(vHide).toBeCloseTo(0);
    expect(lift).toBeCloseTo(2 / 3);
  });

  it('IPS stays null-honest until BOTH sides of the counterfactual exist', () => {
    const arms = new PolicyArms(dir);
    expect(arms.ipsEstimate([{ shown: true, propensity: 0.9, reward: 1 }]).lift).toBeNull();
    expect(arms.ipsEstimate([]).vShow).toBeNull();
    // A shadow-only history (propensity 0, never shown) can estimate hide but not show:
    const est = arms.ipsEstimate([{ shown: false, propensity: 0, reward: 1 }]);
    expect(est.vHide).toBe(1);
    expect(est.vShow).toBeNull();
  });

  it('report() aggregates per arm over the ledger', () => {
    const arms = new PolicyArms(dir, { holdout: 0.1 });
    ledger.append('policy_active', { arm: 'exemplars', shown: true, propensity: 0.9 });
    ledger.append('tool_outcome', { status: 'ok' });
    ledger.append('tool_outcome', { status: 'ok' });
    ledger.append('boundary', {});
    const row = arms.report(ledger).find(r => r.arm === 'exemplars')!;
    expect(row.decisions).toBe(1);
    expect(row.shownRate).toBe(1);
    expect(row.vShow).toBe(1);
    expect(row.lift).toBeNull(); // no hidden observations yet — no counterfactual claim
  });

  describe('the holdout defaults to off', () => {
    it('shows every active arm deterministically, at propensity 1, without drawing randomness', () => {
      let draws = 0;
      const arms = new PolicyArms(dir, { rng: () => { draws++; return 0; } }); // rng would hold out at any positive rate
      expect(arms.holdoutRate()).toBe(0);
      expect(arms.decide('habits', ledger)).toEqual({ show: true, propensity: 1 });
      expect(draws).toBe(0); // nothing to draw when showing is deterministic
      expect(ledger.byType('policy_active')[0].payload).toMatchObject({ arm: 'habits', shown: true, propensity: 1 });
    });

    it('still lets a shadow arm withhold its block', () => {
      const arms = new PolicyArms(dir);
      arms.setStatus('drives', 'shadow');
      expect(arms.decide('drives', ledger)).toEqual({ show: false, propensity: 0 });
    });

    it('reports no lift rather than inventing one, since nothing is ever hidden', () => {
      const arms = new PolicyArms(dir);
      const samples = [1, 1, 0].map(reward => ({ shown: true, propensity: 1, reward }));
      const { vShow, vHide, lift } = arms.ipsEstimate(samples);
      expect(vShow).toBeCloseTo(2 / 3);
      expect(vHide).toBeNull();   // never observed — not zero, not assumed
      expect(lift).toBeNull();
      // A deterministic policy is not a randomized experiment, and the CI must say so —
      // first because one side was never observed, and then on the propensity itself.
      expect(arms.holdoutComparison(samples).reason).toMatch(/Both randomized arms require observations/);
      expect(arms.holdoutComparison([...samples, { shown: false, propensity: 1, reward: 1 }]).reason)
        .toMatch(/propensity in \(0,1\)/);
    });

    it('is re-enabled by BIMAX_POLICY_HOLDOUT or an explicit option', () => {
      process.env.BIMAX_POLICY_HOLDOUT = '0.25';
      try {
        expect(new PolicyArms(dir).holdoutRate()).toBe(0.25);
        expect(new PolicyArms(dir, { holdout: 0.4 }).holdoutRate()).toBe(0.4); // the option still wins
      } finally { delete process.env.BIMAX_POLICY_HOLDOUT; }
      expect(new PolicyArms(dir).holdoutRate()).toBe(0);
    });
  });
});
