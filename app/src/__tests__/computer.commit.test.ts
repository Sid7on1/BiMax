import { COMMIT_WORDS, commitReasonForPress, commitWordIn, foldName, isSearchBox, reasonText } from '../main/computer/look.commit';

/**
 * Record 65 §6h — which presses in another app stop on the person's card first. One rule for every app, read from the
 * control's own name and place and from what Bimax typed there; never from the model's words.
 */

const press = (label: string, more: { inDialog?: boolean; typedSinceLastCard?: boolean } = {}) =>
  commitReasonForPress({ label, inDialog: more.inDialog ?? false, typedSinceLastCard: more.typedSinceLastCard ?? false });

describe('a control whose name commits asks', () => {
  it.each([
    'Send', 'Send Message', 'send', 'SEND', 'Reply', 'Forward', 'Post', 'Share…', 'Voice call', 'Video Call', 'Join',
    'Pay', 'Buy now', 'Place Order', 'Check out', 'Checkout', 'Subscribe', 'Transfer', 'Donate',
    'Delete', 'Delete Everything', 'Move to Trash', 'Remove', 'Clear History', 'Discard', 'Erase', 'Reset', 'Empty Bin',
    'OK', 'Ok', 'Yes', 'Continue', 'Confirm', 'Allow', 'Accept', 'Agree', 'Sign Out', 'Log Out', 'Install', 'Save', "Don't Save",
    'Unsend', 'Block', 'Report', 'Leave Group', 'Like', 'Envoyer', 'Enviar', 'Senden', 'Löschen', 'Supprimer', 'Bestätigen',
  ])('“%s”', (label) => {
    expect(press(label)).toMatchObject({ kind: 'word' });
  });
});

describe('an ordinary control runs without a card', () => {
  it.each([
    'Play', 'Pause', 'Next', 'Previous', 'Back', 'Home', 'Search', 'Chats', 'Calls', 'Mom', 'Fixture Button', 'Settings',
    'Liked Songs', 'Sender details', 'Booklet', 'Okra', 'Sendai', 'Saved Messages', 'Updates', 'New Chat', 'Archive',
    'Mute notifications', 'Shuffle', 'Repeat', 'Volume', 'Emoji', 'Attach', 'Back to chats',
  ])('“%s”', (label) => {
    expect(press(label)).toBeNull();
  });
});

describe('the other reasons to ask', () => {
  it('any control in a sheet or dialog, whatever its name', () => {
    expect(press('Fixture Button', { inDialog: true })).toEqual({ kind: 'dialog' });
    expect(press('Cancel', { inDialog: true })).toEqual({ kind: 'dialog' });
  });

  it('the first press after Bimax typed into a box that is not for searching', () => {
    expect(press('Fixture Button', { typedSinceLastCard: true })).toEqual({ kind: 'after_typing' });
    expect(press('➤', { typedSinceLastCard: true })).toEqual({ kind: 'unreadable' });
  });

  it.each(['➤', '↑', '😀', '•••', '123', 'भेजें', '发送', 'إرسال', 'Отправить', ''])('a name with no Latin letters: “%s”', (label) => {
    expect(press(label)).toEqual({ kind: 'unreadable' });
  });

  it('a commit word wins over the other reasons, so the card says what the control does', () => {
    expect(press('Send', { inDialog: true, typedSinceLastCard: true })).toEqual({ kind: 'word', word: 'send' });
  });
});

describe('matching', () => {
  it('folds case, accents and punctuation; matches whole words and phrases only', () => {
    expect(foldName('  Löschen…  ')).toBe('loschen');
    expect(foldName("Don't Save")).toBe('don t save');
    expect(commitWordIn('Sender')).toBeNull();
    expect(commitWordIn('Place  Order')).toBe('order');
    expect(commitWordIn('check-out')).toBe('check out');
  });

  it('every word is already folded, so none can silently never match', () => {
    for (const word of COMMIT_WORDS) expect(foldName(word)).toBe(word);
  });

  it('search boxes: by role, or by a name that says it finds things', () => {
    expect(isSearchBox('AXSearchField', 'anything')).toBe(true);
    expect(isSearchBox('AXTextField', 'Search')).toBe(true);
    expect(isSearchBox('AXTextField', 'Search or start a new chat')).toBe(true);
    expect(isSearchBox('AXTextArea', 'Compose message')).toBe(false);
    expect(isSearchBox('AXTextArea', 'Type a message')).toBe(false);
  });

  it('each reason has words for the card', () => {
    expect(reasonText({ kind: 'word', word: 'send' }, 'Send')).toContain('“Send” can send, buy, delete or confirm');
    expect(reasonText({ kind: 'dialog' }, 'OK')).toContain('answers a question');
    expect(reasonText({ kind: 'after_typing' }, 'x')).toContain('may send it');
    expect(reasonText({ kind: 'unreadable' }, '➤')).toContain('cannot tell');
    expect(reasonText({ kind: 'submit' }, 'Compose message')).toContain('Pressing Return in “Compose message” may send what is in it');
  });
});
