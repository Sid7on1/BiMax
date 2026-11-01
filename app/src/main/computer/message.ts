/** Bounded semantic messaging checks. App-provided text is evidence, never authority. */
export interface ExactField { control: string; value: string; role?: string; exists?: boolean }
export interface MessageProof { recipient: ExactField; draft: ExactField; outgoing: ExactField & { role: string } }
export const selectControl = (view: any, target: any): any[] => (view?.elements || []).filter((e: any) =>
  (target.control !== undefined ? e.name === target.control : (target.role && target.value !== undefined && String(e.value ?? '') === target.value))
  && (!target.role || e.role === target.role));
export function exactMatch(view: any, expected: any): boolean {
  const found = selectControl(view, expected);
  if (expected.exists === false) return found.length === 0;
  return found.length === 1 && (expected.value === undefined || String(found[0].value ?? '') === expected.value);
}
export const outgoingCount = (view: any, message: MessageProof): number => selectControl(view, message.outgoing)
  .filter(e => String(e.value ?? '') === message.outgoing.value).length;
export function validateMessage(message: MessageProof): void {
  for (const field of [message.recipient, message.draft, message.outgoing]) {
    if (!field.control.trim() || !field.value.trim() || field.exists === false) throw new Error('Message evidence requires exact nonempty recipient, draft and outgoing text.');
  }
  if (message.draft.value !== message.outgoing.value || message.draft.control === message.outgoing.control
    || message.recipient.control === message.draft.control || message.recipient.control === message.outgoing.control) {
    throw new Error('Message evidence must distinguish recipient, draft and outgoing rows with the exact same message text.');
  }
}
export function checkRecipient(view: any, message: MessageProof): void {
  if (!exactMatch(view, message.recipient)) throw new Error('Intended recipient is missing, ambiguous or changed; no message input is allowed.');
}
export function checkMessageBefore(view: any, message: MessageProof, count: number): void {
  checkRecipient(view, message);
  if (!exactMatch(view, message.draft)) throw new Error('The exact message draft changed; Send stopped.');
  if (!selectControl(view, message.outgoing).length) throw new Error('The outgoing row name/role has not been observed. Send stopped; take over manually.');
  if (outgoingCount(view, message) !== count) throw new Error('Outgoing messages changed during approval; Send stopped.');
}
export function messageAfter(view: any, message: MessageProof, count: number): boolean {
  return exactMatch(view, message.recipient)
    && exactMatch(view, { ...message.draft, value: '' })
    && outgoingCount(view, message) === count + 1;
}
// This is a conservative convenience guard, not an arbitrary-app/script sandbox.
export const isSendLabel = (label: string) => /\b(send|envoyer|enviar|senden|invia|inviare|verzenden|versturen)\b/i.test(label.normalize('NFKD'));
export const isMessagingApp = (bundle: string) => /whatsapp|mobilesms|telegram|signal|slack|discord/i.test(bundle);
