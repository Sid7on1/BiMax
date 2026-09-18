import { availableBytes, profileForMemory, planCapabilities } from '../main/supervisor/resources';

/**
 * The capability ladder is only as good as the number underneath it.
 *
 * `os.freemem()` counts wholly free pages, and macOS keeps almost none — it fills spare RAM with
 * file cache and evicts on demand. Feeding that to profileForMemory pinned this machine to
 * `minimal` permanently: codebaseMemory, autoIndex and drivesBoot all deferred, on a box with ~2 GB
 * actually available. It was invisible because EngineStatusBanner suppresses `degraded` on purpose,
 * believing it to be the adaptive path working correctly on a small Mac.
 *
 * These assert the PROPERTY — that reclaimable memory is counted as available — rather than pinning
 * the thresholds. Pinning the number is how this class of bug gets locked in rather than caught.
 */

/** A real `process.getSystemMemoryInfo()` sample from an 8 GB Mac, in KB. Measured 2026-09-18. */
const MEASURED_8GB_MAC = { total: 8_388_608, free: 188_448, fileBacked: 1_835_328, purgeable: 10_704 };

describe('available memory counts what the OS will hand back', () => {
  test('reclaimable page cache and purgeable pages count as available', () => {
    const free = MEASURED_8GB_MAC.free * 1024;
    expect(availableBytes(MEASURED_8GB_MAC)).toBeGreaterThan(free);
    expect(availableBytes(MEASURED_8GB_MAC))
      .toBe((MEASURED_8GB_MAC.free + MEASURED_8GB_MAC.fileBacked + MEASURED_8GB_MAC.purgeable) * 1024);
  });

  test('a platform that reports neither field degrades to the free reading, never to NaN', () => {
    expect(availableBytes({ total: 8_388_608, free: 500_000 })).toBe(500_000 * 1024);
  });

  test('negative or nonsense input floors at zero rather than going negative', () => {
    expect(availableBytes({ total: 0, free: -1, fileBacked: -1 })).toBe(0);
  });

  test('THE REGRESSION — a machine with ~2 GB reclaimable is not classified as starved', () => {
    const freeOnly = { freeBytes: MEASURED_8GB_MAC.free * 1024, totalBytes: MEASURED_8GB_MAC.total * 1024 };
    const real = { freeBytes: availableBytes(MEASURED_8GB_MAC), totalBytes: MEASURED_8GB_MAC.total * 1024 };

    // What the bug did, kept here so the two readings can be compared rather than described.
    expect(profileForMemory(freeOnly)).toBe('minimal');
    // What the machine can actually support.
    expect(profileForMemory(real)).not.toBe('minimal');
  });

  test('the capabilities that were silently deferred are enabled on the corrected reading', () => {
    const real = { freeBytes: availableBytes(MEASURED_8GB_MAC), totalBytes: MEASURED_8GB_MAC.total * 1024 };
    const enabled = new Map(planCapabilities(real, {}).capabilities.map((c) => [c.id, c.enabled]));
    for (const id of ['codebaseMemory', 'autoIndex', 'drivesBoot']) {
      expect(enabled.get(id as never)).toBe(true);
    }
  });

  test('genuine scarcity still sheds — the ladder must keep working, not just read higher', () => {
    const starved = { freeBytes: 200 * 1024 * 1024, totalBytes: MEASURED_8GB_MAC.total * 1024 };
    expect(profileForMemory(starved)).toBe('minimal');
  });
});
