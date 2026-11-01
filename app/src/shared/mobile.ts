export interface MobileStatus {
  enabled: boolean;
  busy: boolean;
  halted: boolean;
  relayStatus: string;
  paired: boolean;
  phoneConnected: boolean;
  cloudReady?: boolean;
  cloudStatus?: string;
  phoneId?: string;
  address?: string;
  addresses: Array<{ address: string; name: string }>;
  candidate?: { phoneId: string; code: string; expiresAt: number };
  error?: string;
}
export interface MobileResult {
  ok: boolean;
  error?: string;
}
export interface MobileApi {
  status(): Promise<MobileStatus>;
  enable(address: string): Promise<MobileResult>;
  disable(): Promise<MobileResult>;
  advertisement(): Promise<string | null>;
  confirm(code: string, phoneId: string): Promise<MobileResult>;
  revoke(): Promise<MobileResult>;
  stop(): Promise<MobileResult>;
}
