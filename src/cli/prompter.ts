import { cliEvents } from './events';

/** The spinner a permission prompt interrupts, so answering it resumes the turn instead of ending it. */
let spinnerBeforePrompt: { state: string; message: string } = { state: 'idle', message: 'Ready' };
cliEvents.on('spinner_state', (state: string, message?: string) => {
  if (state !== 'vetoing') spinnerBeforePrompt = { state: String(state), message: String(message ?? '') };
});

export class GlobalPrompter {
  private static isPrompting = false;

  public static register() {
    // No longer needs readline interface, React manages UI.
  }

  public static async ask(question: string, options: string[] = ['Yes', 'No', 'Always'], extra?: { body?: string }): Promise<string> {
    if (this.isPrompting) {
      throw new Error('[GlobalPrompter] Cannot prompt while another prompt is active.');
    }

    this.isPrompting = true;
    // The turn does not end when the user answers, so put back what the prompt interrupted ("thinking",
    // "executing") rather than reporting idle. Idle mid-turn hid the activity row after every approved
    // command, and the thread manager took it for the end of the turn.
    const resume = spinnerBeforePrompt;

    try {
      cliEvents.emit('spinner_state', 'vetoing', 'Governor is evaluating safety constraints...');
    } catch {
      this.isPrompting = false;
      throw new Error('[GlobalPrompter] Failed to emit spinner state.');
    }

    return new Promise((resolve) => {
      try {
        cliEvents.emit('veto_prompt', question, options, (answer: string) => {
          this.isPrompting = false;
          cliEvents.emit('spinner_state', resume.state, resume.message);
          resolve(answer.trim());
        }, false, false, extra?.body);
      } catch (e) {
        this.isPrompting = false;
        cliEvents.emit('spinner_state', resume.state, resume.message);
        throw e;
      }
    });
  }

  public static isBusy(): boolean {
    return this.isPrompting;
  }
}
