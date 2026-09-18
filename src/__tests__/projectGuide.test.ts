import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadProjectGuide } from '../engine/projectGuide';

describe('loadProjectGuide', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bgw-guide-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('reads AGENTS.md from the directory', () => {
    fs.writeFileSync(path.join(dir, 'AGENTS.md'), 'Build with: npm run build\nTest with: npm test');
    const g = loadProjectGuide(dir);
    expect(g?.content).toContain('npm run build');
    expect(g?.path).toContain('AGENTS.md');
  });

  it('prefers AGENTS.md over CLAUDE.md', () => {
    fs.writeFileSync(path.join(dir, 'AGENTS.md'), 'from agents');
    fs.writeFileSync(path.join(dir, 'CLAUDE.md'), 'from claude');
    expect(loadProjectGuide(dir)?.content).toBe('from agents');
  });

  it('walks up to a parent directory', () => {
    fs.writeFileSync(path.join(dir, 'AGENTS.md'), 'parent guide');
    const sub = path.join(dir, 'packages', 'core');
    fs.mkdirSync(sub, { recursive: true });
    expect(loadProjectGuide(sub)?.content).toBe('parent guide');
  });

  it('returns null when no guide exists', () => {
    expect(loadProjectGuide(dir)).toBeNull();
  });

  it('caps an oversized guide', () => {
    fs.writeFileSync(path.join(dir, 'CLAUDE.md'), 'x'.repeat(10000));
    const g = loadProjectGuide(dir);
    expect(g!.content.length).toBeLessThan(7000);
    expect(g!.content).toContain('truncated');
  });
});
