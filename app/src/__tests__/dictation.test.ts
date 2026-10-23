import { composeDictation, HoldToTalk, HOLD_TO_TALK_MS, isTalkKey } from '../renderer/src/dictation';

test('dictated words land at the cursor with a space only where words would touch', () => {
  expect(composeDictation('', ' Hello Bimax.', '')).toEqual({ text: 'Hello Bimax.', caret: 12 });
  expect(composeDictation('Move ', 'the old installers', '')).toEqual({ text: 'Move the old installers', caret: 23 });
  expect(composeDictation('Move', 'the old installers', ' to the Bin')).toEqual({ text: 'Move the old installers to the Bin', caret: 23 });
  expect(composeDictation('Summarise', 'the PDFs', 'later')).toEqual({ text: 'Summarise the PDFs later', caret: 18 });
  expect(composeDictation('Tidy (', 'Downloads', '). Thanks')).toEqual({ text: 'Tidy (Downloads). Thanks', caret: 15 });
  expect(composeDictation('keep this', '   ', ' as is')).toEqual({ text: 'keep this as is', caret: 9 });
});

test('right ⌥ alone is the talk key', () => {
  const key = { code: 'AltRight', metaKey: false, ctrlKey: false, shiftKey: false };
  expect(isTalkKey(key)).toBe(true);
  expect(isTalkKey({ ...key, code: 'AltLeft' })).toBe(false);
  expect(isTalkKey({ ...key, metaKey: true })).toBe(false);
});

describe('hold to talk', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  test('holding starts after a moment and releasing stops; a quick tap does nothing', () => {
    const begin = jest.fn(), end = jest.fn();
    const hold = new HoldToTalk(begin, end);
    hold.down();
    jest.advanceTimersByTime(HOLD_TO_TALK_MS - 10);
    hold.up();
    jest.advanceTimersByTime(HOLD_TO_TALK_MS);
    expect(begin).not.toHaveBeenCalled();
    hold.down();
    hold.down();
    jest.advanceTimersByTime(HOLD_TO_TALK_MS);
    expect(begin).toHaveBeenCalledTimes(1);
    hold.up();
    expect(end).toHaveBeenCalledTimes(1);
  });

  test('typing with ⌥ (⌥E, ⌥8) never starts dictation', () => {
    const begin = jest.fn(), end = jest.fn();
    const hold = new HoldToTalk(begin, end);
    hold.down();
    hold.interrupt();
    jest.advanceTimersByTime(HOLD_TO_TALK_MS * 2);
    hold.up();
    expect(begin).not.toHaveBeenCalled();
    expect(end).not.toHaveBeenCalled();
  });
});
