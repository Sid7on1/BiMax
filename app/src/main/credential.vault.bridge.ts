/**
 * Credential Vault Bridge for Zero-Knowledge Password Autofill.
 *
 * Allows the browser agent to autofill login credentials (username/password)
 * directly into target input elements using CDP Input.insertText, without ever
 * returning or passing raw passwords into the LLM context or conversation transcripts.
 */

import type { WebContents } from 'electron';

export interface CredentialEntry {
  domain: string;
  username: string;
  secretMasked: string; // e.g. "••••••••"
}

export class CredentialVaultBridge {
  private static localVault = new Map<string, { username: string; secret: string }>();

  /** Register or store a local credential securely. */
  static storeCredential(domain: string, username: string, secret: string): void {
    this.localVault.set(domain.toLowerCase(), { username, secret });
  }

  /** Check if credentials exist for a domain without exposing the secret. */
  static hasCredentials(domain: string): { exists: boolean; username?: string } {
    const entry = this.localVault.get(domain.toLowerCase());
    return entry ? { exists: true, username: entry.username } : { exists: false };
  }

  /**
   * Autofill credentials directly into the active WebContents without exposing
   * the plaintext secret in the response.
   */
  static async autofill(
    webContents: WebContents,
    domain: string,
    usernameSelector = 'input[type="email"], input[type="text"], input[name*="user"], input[name*="login"]',
    passwordSelector = 'input[type="password"]',
  ): Promise<{ ok: boolean; summary: string }> {
    const entry = this.localVault.get(domain.toLowerCase());
    if (!entry) {
      return { ok: false, summary: `No credentials stored in vault for ${domain}` };
    }

    try {
      // Direct DOM autofill via script with event dispatching
      const result = await webContents.executeJavaScript(`(() => {
        const uInput = document.querySelector(${JSON.stringify(usernameSelector)}) as HTMLInputElement;
        const pInput = document.querySelector(${JSON.stringify(passwordSelector)}) as HTMLInputElement;
        if (!uInput && !pInput) return { filled: false, reason: 'No login input fields found' };

        if (uInput) {
          uInput.focus();
          uInput.value = ${JSON.stringify(entry.username)};
          uInput.dispatchEvent(new Event('input', { bubbles: true }));
          uInput.dispatchEvent(new Event('change', { bubbles: true }));
        }

        if (pInput) {
          pInput.focus();
          pInput.value = ${JSON.stringify(entry.secret)};
          pInput.dispatchEvent(new Event('input', { bubbles: true }));
          pInput.dispatchEvent(new Event('change', { bubbles: true }));
        }

        return { filled: true, username: ${JSON.stringify(entry.username)} };
      })()`);

      if (result.filled) {
        return {
          ok: true,
          summary: `Autofilled credentials for ${entry.username} on ${domain} (secret remained masked in vault).`,
        };
      } else {
        return { ok: false, summary: result.reason || 'Failed to locate login input elements.' };
      }
    } catch (err: any) {
      return { ok: false, summary: `Autofill error: ${String(err?.message || err)}` };
    }
  }
}
