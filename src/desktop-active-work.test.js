import { setDesktopActiveWork, withDesktopActiveWork, holdDesktopActiveWork } from './desktop-active-work.js';

const originalWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');

function setWindow(value) {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    writable: true,
    value,
  });
}

function restoreWindow() {
  if (originalWindowDescriptor) {
    Object.defineProperty(globalThis, 'window', originalWindowDescriptor);
  } else {
    delete globalThis.window;
  }
}

describe('desktop active work adapter', () => {
  afterEach(() => {
    restoreWindow();
    vi.restoreAllMocks();
  });

  it('is a no-op outside Electron', async () => {
    restoreWindow();

    await expect(setDesktopActiveWork('pii-file-import', true)).resolves.toBeUndefined();
  });

  it('forwards key and active state to the Electron bridge', async () => {
    const setActiveWork = vi.fn(async () => ({ powerSaveBlockerActive: true }));
    setWindow({ piiDesktop: { setActiveWork } });

    await expect(setDesktopActiveWork('pii-anonymize', true)).resolves.toEqual({
      powerSaveBlockerActive: true,
    });

    expect(setActiveWork).toHaveBeenCalledWith('pii-anonymize', true);
  });

  it('rejects invalid keys before IPC', async () => {
    const setActiveWork = vi.fn();
    setWindow({ piiDesktop: { setActiveWork } });

    await expect(setDesktopActiveWork('pii-unknown', true)).rejects.toThrow('Unknown desktop active work key: pii-unknown');
    expect(setActiveWork).not.toHaveBeenCalled();
  });

  it('marks work active while an async callback runs', async () => {
    const calls = [];
    setWindow({
      piiDesktop: {
        setActiveWork: vi.fn(async (key, active) => {
          calls.push([key, active]);
        }),
      },
    });

    const result = await withDesktopActiveWork('pii-file-import', async () => {
      calls.push(['callback', true]);
      return 'result';
    });

    expect(result).toBe('result');
    expect(calls).toEqual([
      ['pii-file-import', true],
      ['callback', true],
      ['pii-file-import', false],
    ]);
  });

  it('clears active work in finally and rethrows callback failures', async () => {
    const setActiveWork = vi.fn(async () => {});
    setWindow({ piiDesktop: { setActiveWork } });

    await expect(withDesktopActiveWork('pii-anonymize', async () => {
      throw new Error('boom');
    })).rejects.toThrow('boom');

    expect(setActiveWork).toHaveBeenNthCalledWith(1, 'pii-anonymize', true);
    expect(setActiveWork).toHaveBeenNthCalledWith(2, 'pii-anonymize', false);
  });

  it('logs IPC failures without breaking normal web behavior', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    setWindow({
      piiDesktop: {
        setActiveWork: vi.fn(async () => {
          throw new Error('ipc down');
        }),
      },
    });

    await expect(setDesktopActiveWork('pii-file-import', true)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith('[desktop-active-work] active work IPC failed:', expect.any(Error));
  });
});

describe('holdDesktopActiveWork (reference-counted scopes)', () => {
  afterEach(() => {
    restoreWindow();
    vi.restoreAllMocks();
  });

  it('keeps active work set across overlapping scopes until the last one releases', async () => {
    const calls = [];
    setWindow({
      piiDesktop: {
        setActiveWork: vi.fn(async (key, active) => {
          calls.push([key, active]);
        }),
      },
    });

    // Two file imports start while the first is still running.
    const releaseFirst = await holdDesktopActiveWork('pii-file-import');
    const releaseSecond = await holdDesktopActiveWork('pii-file-import');

    // First acquire flips the bridge active exactly once; the second,
    // overlapping acquire must NOT flip it again.
    expect(calls).toEqual([['pii-file-import', true]]);

    // Releasing the first scope while the second is still held must NOT clear
    // active work — this is the overlapping-import regression.
    await releaseFirst();
    expect(calls).toEqual([['pii-file-import', true]]);

    // Only the release of the last outstanding scope clears active work, once.
    await releaseSecond();
    expect(calls).toEqual([
      ['pii-file-import', true],
      ['pii-file-import', false],
    ]);
  });

  it('counts overlapping acquire calls before the first activation IPC resolves', async () => {
    const calls = [];
    let resolveFirstActivation;
    const firstActivation = new Promise((resolve) => {
      resolveFirstActivation = resolve;
    });
    setWindow({
      piiDesktop: {
        setActiveWork: vi.fn((key, active) => {
          calls.push([key, active]);
          return active ? firstActivation : Promise.resolve();
        }),
      },
    });

    const firstReleasePromise = holdDesktopActiveWork('pii-file-import');
    const secondReleasePromise = holdDesktopActiveWork('pii-file-import');

    let firstResolved = false;
    firstReleasePromise.then(() => {
      firstResolved = true;
    });
    await Promise.resolve();

    expect(firstResolved).toBe(false);
    expect(calls).toEqual([['pii-file-import', true]]);

    const releaseSecond = await secondReleasePromise;
    resolveFirstActivation();
    const releaseFirst = await firstReleasePromise;

    await releaseFirst();
    expect(calls).toEqual([['pii-file-import', true]]);

    await releaseSecond();
    expect(calls).toEqual([
      ['pii-file-import', true],
      ['pii-file-import', false],
    ]);
  });

  it('treats a release handle as one-shot so a double release cannot undercount', async () => {
    const calls = [];
    setWindow({
      piiDesktop: {
        setActiveWork: vi.fn(async (key, active) => {
          calls.push([key, active]);
        }),
      },
    });

    const release = await holdDesktopActiveWork('pii-file-import');

    // Calling the same handle twice must be a no-op the second time — never a
    // second decrement that could clear active work while a sibling scope runs.
    await release();
    await release();

    expect(calls).toEqual([
      ['pii-file-import', true],
      ['pii-file-import', false],
    ]);
  });
});
