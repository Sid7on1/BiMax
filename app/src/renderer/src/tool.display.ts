/** Product names in activity rows; raw tool identifiers stay in diagnostic data. */
export function toolDisplayName(name: string): string {
  return name === 'BimaxCuTool' ? 'Computer Use' : name.replace(/Tool$/, '');
}

export function computerUseActivity(input: string): string {
  try {
    const args = JSON.parse(input);
    if (args.operation === 'workflow' && Array.isArray(args.steps)) return `${args.steps.length} workflow step${args.steps.length === 1 ? '' : 's'}`;
    const labels: Record<string, string> = {
      status: 'Mac access', apps: 'Find apps', windows: 'Find windows', observe: 'Read window',
      screenshot: 'Read screenshot', commands: 'Read app commands', release: 'Restore window',
      settle: 'Wait for app', wait: 'Wait for app',
    };
    return labels[args.operation] || 'App action';
  } catch { return 'App action'; }
}
