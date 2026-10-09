import { afterEach, describe, expect, it, vi } from 'vitest';

const main = vi.fn<() => Promise<number>>();
vi.mock('../src/main.js', () => ({ main }));

function stdoutError(code: string): Error {
  return Object.assign(new Error(`write ${code}`), { code });
}

/** Imports the bin with `main` resolving to `code`; its listener lands on the real stdout. */
async function loadCli(code: number): Promise<void> {
  expect(process.stdout.listenerCount('error')).toBe(0);
  main.mockResolvedValue(code);
  vi.resetModules();
  await import('../src/cli.js');
  await vi.waitFor(() => expect(process.exitCode).toBe(code));
}

afterEach(() => {
  process.stdout.removeAllListeners('error');
  process.exitCode = undefined;
  vi.restoreAllMocks();
  main.mockReset();
});

describe('cli', () => {
  it('keeps the exit code main returned when the reader closes the pipe', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`process.exit(${String(code)})`);
    });
    await loadCli(1);
    expect(() => process.stdout.emit('error', stdoutError('EPIPE'))).not.toThrow();
    expect(exit).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it('rethrows stdout errors other than EPIPE', async () => {
    await loadCli(0);
    expect(() => process.stdout.emit('error', stdoutError('EIO'))).toThrow('write EIO');
  });
});
