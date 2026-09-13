import { stateDir } from '../utils/state.dir';
import { Logger } from '../utils/logger';
import * as fs from 'fs/promises';
import * as path from 'path';

export class TelemetryEngine {
  private bootTime: number;
  private readonly STORAGE_DIR = path.join(stateDir('.breakglass'), 'telemetry');
  private readonly METRICS_FILE = path.join(this.STORAGE_DIR, 'metrics.json');

  constructor() {
    this.bootTime = Date.now();
    this.initStorage().catch(console.error);
  }

  private async initStorage() {
    try {
      await fs.mkdir(this.STORAGE_DIR, { recursive: true });
    } catch (e) {
      // ignore
    }
  }

  public getUptimeSeconds(): number {
    return (Date.now() - this.bootTime) / 1000;
  }

  public async flushTelemetry(rssMB: number, keyStates: any[]) {
    const payload = {
      timestamp: new Date().toISOString(),
      metrics: {
        memory_mb: rssMB,
        uptime_s: this.getUptimeSeconds(),
        keys: keyStates.map((k: any, i: number) => ({
          key_index: i + 1,
          total_ok: k.total_ok,
          total_fail: k.total_fail,
          consecutive_429: k.consecutive_429
        }))
      }
    };

    Logger.info(`[TelemetryEngine] Flushing metrics to Disk: Mem ${payload.metrics.memory_mb}MB, Uptime ${payload.metrics.uptime_s.toFixed(1)}s`);
    
    // Physically persist telemetry to a JSON file so external scrapers can read it
    try {
      await fs.writeFile(this.METRICS_FILE, JSON.stringify(payload, null, 2), 'utf-8');
    } catch (err: any) {
      Logger.error(`[TelemetryEngine] Failed to write metrics.json: ${err.message}`);
    }
  }
}
