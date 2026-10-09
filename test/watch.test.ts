import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { rateLimitedError } from '../src/errors.js';
import { runWatch } from '../src/tui.js';
import type { Snapshot, SnapshotProvider } from '../src/usage-source.js';

const SNAPSHOT: Snapshot = {
  payload: {},
  fetchedAt: new Date(),
  error: null,
  plan: null,
  tokenExpiresAt: null,
  account: null,
  credentialsSource: 'fixture',
  retryAt: null,
};
const OPTIONS = { color: false, richColor: false, intervalMs: 300_000 };

/** A request that stays on the wire until the test lets it land. */
function slowSource(): { source: SnapshotProvider; get: ReturnType<typeof vi.fn>; land: () => void } {
  let land = (): void => undefined;
  const get = vi.fn(
    () =>
      new Promise<Snapshot>((resolve) => {
        land = () => resolve(SNAPSHOT);
      }),
  );
  return { source: { get }, get, land: () => land() };
}

let frames = '';
beforeEach(() => {
  vi.useFakeTimers();
  frames = '';
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
    frames += String(chunk);
    return true;
  });
  Object.defineProperty(process.stdin, 'setRawMode', { value: vi.fn(), configurable: true });
  vi.spyOn(process.stdin, 'resume').mockReturnValue(process.stdin);
  vi.spyOn(process.stdin, 'pause').mockReturnValue(process.stdin);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('runWatch schedule', () => {
  it('wakes when a 429 hold ends instead of on the next cycle, and counts down to it', async () => {
    const held: Snapshot = { ...SNAPSHOT, error: rateLimitedError(null), retryAt: new Date(Date.now() + 10 * 60_000) };
    const get = vi.fn<SnapshotProvider['get']>().mockResolvedValueOnce(held).mockResolvedValue(SNAPSHOT);
    const done = runWatch({ get }, OPTIONS);
    await vi.advanceTimersByTimeAsync(0);
    expect(frames).toContain('próxima em 10min 01s');
    expect(frames).toContain('Próxima consulta liberada às');
    await vi.advanceTimersByTimeAsync(300_000);
    expect(get).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(301_000);
    expect(get).toHaveBeenCalledTimes(2);
    process.stdin.emit('data', 'q');
    expect(await done).toBe(0);
  });
});

describe('runWatch quit', () => {
  it('waits for a request already on the wire before resolving, so its result gets persisted', async () => {
    const { source, get, land } = slowSource();
    let code: number | null = null;
    void runWatch(source, OPTIONS).then((value) => (code = value));
    await vi.advanceTimersByTimeAsync(100);
    process.stdin.emit('data', 'q');
    await vi.advanceTimersByTimeAsync(300);
    expect(code).toBeNull();
    land();
    await vi.advanceTimersByTimeAsync(0);
    expect(code).toBe(0);
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('gives up after the grace period when the request hangs', async () => {
    const { source, get } = slowSource();
    let code: number | null = null;
    void runWatch(source, OPTIONS).then((value) => (code = value));
    await vi.advanceTimersByTimeAsync(100);
    process.stdin.emit('data', 'q');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(code).toBe(0);
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('resolves at once when nothing is in flight, without a new request', async () => {
    const { source, get, land } = slowSource();
    let code: number | null = null;
    void runWatch(source, OPTIONS).then((value) => (code = value));
    land();
    await vi.advanceTimersByTimeAsync(100);
    process.stdin.emit('data', 'q');
    await vi.advanceTimersByTimeAsync(0);
    expect(code).toBe(0);
    expect(get).toHaveBeenCalledTimes(1);
  });
});
