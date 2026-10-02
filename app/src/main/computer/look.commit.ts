/**
 * Which steps in another app stop on the person's card before they happen (record 65 §6h) — one rule for every app.
 *
 * Ordinary steps run without a card: opening a chat, typing into a box, pressing Play. Anything that leaves the Mac or
 * cannot be undone asks first — and so does anything this rule cannot read. It reads only what the app's own
 * accessibility tree says (the control's name and where it sits) and what Bimax itself did in this app (what it typed),
 * never the model's words. Pure: no driver, no Electron.
 */

/** Why a step needs the person's OK, or null for an ordinary step. */
export type CommitReason =
  | { kind: 'word'; word: string }
  | { kind: 'dialog' }
  | { kind: 'after_typing' }
  | { kind: 'unreadable' };

/**
 * Words (and a few phrases) on a control that sends, pays, deletes, confirms or otherwise commits. Matched as whole words
 * after case and accents are folded, so "Send" and "Send Message" ask and "Sender" does not. English first, then the
 * same few verbs in French, Spanish, Portuguese, German, Italian and Dutch. A name in any other script has no Latin
 * letters and asks anyway ({@link commitReasonForPress}).
 */
export const COMMIT_WORDS: readonly string[] = [
  // Sends something to someone, or puts it in public.
  'send', 'post', 'publish', 'share', 'submit', 'reply', 'forward', 'tweet', 'retweet', 'repost', 'comment', 'upload',
  'call', 'facetime', 'dial', 'invite', 'join', 'follow', 'like', 'react', 'vote', 'upvote', 'downvote', 'rsvp',
  'decline', 'end call',
  // Money.
  'pay', 'buy', 'purchase', 'order', 'checkout', 'check out', 'place order', 'subscribe', 'unsubscribe', 'donate',
  'transfer', 'withdraw', 'deposit', 'book', 'reserve', 'bid', 'sell', 'trade', 'complete', 'finish',
  // Agrees, allows or signs.
  'confirm', 'approve', 'accept', 'agree', 'allow', 'authorize', 'authorise', 'grant', 'sign', 'sign out', 'log out',
  'logout', 'install', 'uninstall', 'update', 'upgrade', 'ok', 'okay', 'yes', 'continue', 'proceed', 'apply', 'save',
  // Destroys or cannot be undone.
  'delete', 'remove', 'erase', 'trash', 'discard', 'clear', 'empty', 'reset', 'restore', 'revert', 'overwrite',
  'replace', 'wipe', 'format', 'unsend', 'block', 'report', 'unfriend', 'unfollow', 'leave', 'quit',
  // The same few verbs in French, Spanish, Portuguese, German, Italian and Dutch.
  'envoyer', 'enviar', 'senden', 'invia', 'inviare', 'verzenden', 'versturen',
  'payer', 'pagar', 'bezahlen', 'paga', 'pagare', 'betalen',
  'acheter', 'comprar', 'kaufen', 'acquista', 'kopen',
  'supprimer', 'eliminar', 'borrar', 'loschen', 'elimina', 'eliminare', 'excluir', 'apagar', 'verwijderen',
  'confirmer', 'confirmar', 'bestatigen', 'conferma', 'bevestigen',
  'publier', 'publicar', 'veroffentlichen', 'pubblica', 'publiceren',
  'partager', 'compartir', 'partilhar', 'teilen', 'condividi', 'delen',
];

/** Lower case, accents off, anything that is not a letter or digit as one space. */
export function foldName(name: string): string {
  return name.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/** The first commit word the name holds as a whole word (or phrase), or null. */
export function commitWordIn(name: string): string | null {
  const folded = ` ${foldName(name)} `;
  for (const word of COMMIT_WORDS) if (folded.includes(` ${word} `)) return word;
  return null;
}

/** Roles that hold a dialog's buttons: a press inside one answers a question the app asked, whatever its name. */
export const DIALOG_ROLES: ReadonlySet<string> = new Set(['AXSheet', 'AXDialog', 'AXSystemDialog']);

export interface PressStep {
  /** The control's name as the app's accessibility tree gives it. */
  label: string;
  /** It sits inside a sheet or dialog ({@link DIALOG_ROLES}). */
  inDialog: boolean;
  /** Bimax typed into a box in this app that is not a search box, and nothing has been asked since. */
  typedSinceLastCard: boolean;
}

/**
 * Null for an ordinary press; otherwise why it must be asked. Order matters only for what the card says: every reason
 * is enough on its own.
 */
export function commitReasonForPress(step: PressStep): CommitReason | null {
  if (!/[a-z]/.test(foldName(step.label))) return { kind: 'unreadable' };
  const word = commitWordIn(step.label);
  if (word) return { kind: 'word', word };
  if (step.inDialog) return { kind: 'dialog' };
  if (step.typedSinceLastCard) return { kind: 'after_typing' };
  return null;
}

/**
 * A box whose job is to find things, not to say them to anyone: typing there is never followed by a "send" card. Read
 * from the box's role and its name before anything was typed (the driver names an empty box by its title or
 * description; a filled one, by its value — so this is decided before typing).
 */
export function isSearchBox(role: string, label: string): boolean {
  if (role === 'AXSearchField') return true;
  return /\b(search|find|filter|look up|lookup)\b/.test(foldName(label));
}

/** What the card says about why it asks. */
export function reasonText(reason: CommitReason, label: string): string {
  switch (reason.kind) {
    case 'word': return `“${label}” can send, buy, delete or confirm something, so Bimax asks first.`;
    case 'dialog': return `“${label}” answers a question the app asked, so Bimax asks first.`;
    case 'after_typing': return 'Bimax typed text in this app, and this press may send it, so Bimax asks first.';
    case 'unreadable': return `Bimax cannot tell from the name “${label}” what this does, so it asks first.`;
  }
}
