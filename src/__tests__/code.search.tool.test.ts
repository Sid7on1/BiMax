import type { IGovernor } from '../core/interfaces';
import type { CodeIndex } from '../memory/code.index';
import { createCodeSearchTool } from '../tools/implementations/code.search.tool';

const governor = {
  approveTaskExecution: jest.fn().mockResolvedValue(undefined),
} as unknown as IGovernor;

function fakeIndex(path: string): CodeIndex {
  return {
    coverage: () => ({ syncing: false, pending: 0 }),
    search: jest.fn().mockResolvedValue([{
      path,
      startLine: 1,
      endLine: 2,
      symbol: 'sentinel',
      text: 'export const sentinel = true;',
    }]),
    stats: jest.fn().mockReturnValue({ lastMode: { lexical: true, dense: false, reranked: false } }),
  } as unknown as CodeIndex;
}

describe('CodeSearchTool project ownership', () => {
  test('resolves the index from the session cwd after ChangeDirectoryTool updates it', async () => {
    const launchIndex = fakeIndex('launch/a.ts');
    const switchedIndex = fakeIndex('switched/b.ts');
    const resolve = jest.fn(async (cwd: string) => cwd === '/repo/switched' ? switchedIndex : launchIndex);
    const tool = createCodeSearchTool(governor, launchIndex, resolve);

    const output = await tool.execute({ query: 'sentinel' }, { cwd: '/repo/switched' });

    expect(resolve).toHaveBeenCalledWith('/repo/switched');
    expect(switchedIndex.search).toHaveBeenCalledWith('sentinel', 5, undefined);
    expect(output).toContain('switched/b.ts:1-2');
    expect(output).not.toContain('launch/a.ts');
  });
});
