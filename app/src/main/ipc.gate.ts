import type { IpcMainEvent, IpcMainInvokeEvent } from 'electron';

/**
 * The checked IPC registration main/index.ts owns (secureHandle / secureOn): every channel is refused to an untrusted
 * sender and to an auxiliary window that may not use it, and a payload a validator rejects returns the fallback. A
 * module that registers channels receives this instead of reaching for ipcMain, so it cannot skip the gate.
 */
export interface IpcGate {
  handle<T>(channel: string, fallback: T, fn: (event: IpcMainInvokeEvent, ...args: unknown[]) => T | Promise<T>): void;
  on(channel: string, fn: (event: IpcMainEvent, ...args: unknown[]) => void): void;
}
