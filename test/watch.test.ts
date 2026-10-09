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

const realSize = new Map<'columns' | 'rows', PropertyDescriptor | undefined>();
/** Sizes process.stdout for one test; afterEach puts the real size back. */
function setStdoutSize(key: 'columns' | 'rows', value: number): void {
  if (!realSize.has(key)) realSize.set(key, Object.getOwnPropertyDescriptor(process.stdout, key));
  Object.defineProperty(process.stdout, key, { value, configurable: true });
}

/** The footer of the last frame drawn. */
function lastFooter(): string | undefined {
  return frames
    .split('\u001b[K\n')
    .filter((line) => line.includes('atualiza'))
    .at(-1);
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
  for (const [key, descriptor] of realSize) {
    if (descriptor) Object.defineProperty(process.stdout, key, descriptor);
    else Reflect.deleteProperty(process.stdout, key);
  }
  realSize.clear();
});

describe('runWatch schedule', () => {
  it('wakes when a 429 hold ends instead of on the next cycle, and counts down to it', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
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

  it('spreads the wake after a hold, so two -w sharing it do not call at the same instant', async () => {
    vi.spyOn(Math, 'random').mockReturnValueOnce(0.1).mockReturnValueOnce(0.6).mockReturnValue(0.5);
    const until = Date.now() + 10 * 60_000;
    const wakes: number[] = [];
    const watcher = (): SnapshotProvider =>
      ({
        get: vi.fn<SnapshotProvider['get']>(async () => {
          if (Date.now() < until) return { ...SNAPSHOT, error: rateLimitedError(null), retryAt: new Date(until) };
          wakes.push(Date.now() - until);
          return SNAPSHOT;
        }),
      });
    const a = runWatch(watcher(), OPTIONS);
    const b = runWatch(watcher(), OPTIONS);
    await vi.advanceTimersByTimeAsync(10 * 60_000 + 31_000);
    process.stdin.emit('data', 'q');
    await Promise.all([a, b]);
    expect(wakes.sort((x, y) => x - y)).toEqual([4_000, 19_000]);
  });

  it('keeps a fixed rate: a slow answer does not push the next call later (and into another -w)', async () => {
    const start = Date.now();
    const calls: number[] = [];
    const get = vi.fn<SnapshotProvider['get']>(async () => {
      calls.push(Date.now() - start);
      await new Promise((resolve) => setTimeout(resolve, 400));
      return SNAPSHOT;
    });
    const done = runWatch({ get }, OPTIONS);
    await vi.advanceTimersByTimeAsync(900_500);
    expect(calls).toEqual([0, 300_000, 600_000, 900_000]);
    process.stdin.emit('data', 'q');
    expect(await done).toBe(0);
  });
});

describe('runWatch screen', () => {
  it.each([40, 43])('keeps the quit hint on a %d-column pane, at the default interval and during a hold', async (columns) => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    setStdoutSize('columns', columns);
    setStdoutSize('rows', 40);
    const held: Snapshot = { ...SNAPSHOT, error: rateLimitedError(null), retryAt: new Date(Date.now() + 29 * 60_000) };
    const get = vi.fn<SnapshotProvider['get']>().mockResolvedValueOnce(SNAPSHOT).mockResolvedValue(held);
    const done = runWatch({ get }, OPTIONS);
    await vi.advanceTimersByTimeAsync(0);
    expect(lastFooter()).toContain('q sai');
    expect(lastFooter()).toContain('próxima em 5');
    process.stdin.emit('data', 'r');
    await vi.advanceTimersByTimeAsync(0);
    expect(lastFooter()).toContain('q sai');
    expect(lastFooter()).toContain('próxima em 29');
    process.stdin.emit('data', 'q');
    expect(await done).toBe(0);
  });

  it('treats 0 rows (a pty with no window size) as unknown, not as a 1-row terminal', async () => {
    setStdoutSize('rows', 0);
    const get = vi.fn<SnapshotProvider['get']>().mockResolvedValue(SNAPSHOT);
    const done = runWatch({ get }, OPTIONS);
    await vi.advanceTimersByTimeAsync(0);
    expect(frames).toContain('CLAUDE · USO DO PLANO');
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
