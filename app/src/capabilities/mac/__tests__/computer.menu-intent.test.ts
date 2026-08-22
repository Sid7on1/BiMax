import { decideMenuAdapter, offerableMenuCommands } from '../menu.intent';

describe('menu command-intent adapter', () => {
  it('keeps vision eligible for content missing from AX even when menus exist', () => {
    expect(decideMenuAdapter({ query: 'Yellow by Coldplay', axReady: false, nativeQueryMatched: false }))
      .toMatchObject({ kind: 'content', consultMenus: false, visionEligible: true });
  });

  it('consults menus for commands without making them a content perception rung', () => {
    expect(decideMenuAdapter({ query: 'pause playback', axReady: false, nativeQueryMatched: false }))
      .toMatchObject({ kind: 'command', consultMenus: true, visionEligible: true });
  });

  it('does not pay for menus when AX already answers', () => {
    expect(decideMenuAdapter({ query: 'Search', axReady: true, nativeQueryMatched: true }))
      .toMatchObject({ consultMenus: false, visionEligible: false });
  });

  it('ranks app verbs ahead of universal menu noise without naming an app or menu family', () => {
    const command = (title: string, menu: string, index: number) => ({
      title, rawTitle: title, path: [menu, title], indexPath: [index, 1], menu,
      enabled: true, hasSubmenu: false, destructive: false,
    });
    const offered = offerableMenuCommands([
      command('Help', 'Help', 1),
      command('Export Selection', 'Document', 2),
      command('About Target', 'Target', 3),
    ]).map(entry => entry.title);
    expect(offered[0]).toBe('Export Selection');
    expect(new Set(offered.slice(1))).toEqual(new Set(['About Target', 'Help']));
  });
});
