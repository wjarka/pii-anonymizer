const ACTIVE_WORK_KEYS = new Set(['pii-file-import', 'pii-anonymize']);
const activeWorkHoldCounts = new Map();

function assertActiveWorkKey(key) {
  if (!ACTIVE_WORK_KEYS.has(key)) {
    throw new Error(`Unknown desktop active work key: ${key}`);
  }
}

function desktopBridge() {
  return globalThis.window?.piiDesktop;
}

export async function setDesktopActiveWork(key, active) {
  assertActiveWorkKey(key);

  const bridge = desktopBridge();
  if (typeof bridge?.setActiveWork !== 'function') return undefined;

  try {
    return await bridge.setActiveWork(key, active);
  } catch (err) {
    console.warn('[desktop-active-work] active work IPC failed:', err);
    return undefined;
  }
}

export async function holdDesktopActiveWork(key) {
  assertActiveWorkKey(key);

  const currentCount = activeWorkHoldCounts.get(key) ?? 0;
  activeWorkHoldCounts.set(key, currentCount + 1);
  if (currentCount === 0) {
    await setDesktopActiveWork(key, true);
  }

  let released = false;
  return async function releaseDesktopActiveWork() {
    if (released) return;
    released = true;

    const nextCount = Math.max((activeWorkHoldCounts.get(key) ?? 1) - 1, 0);
    if (nextCount === 0) {
      activeWorkHoldCounts.delete(key);
      await setDesktopActiveWork(key, false);
    } else {
      activeWorkHoldCounts.set(key, nextCount);
    }
  };
}

export async function withDesktopActiveWork(key, fn) {
  const releaseDesktopActiveWork = await holdDesktopActiveWork(key);
  try {
    return await fn();
  } finally {
    await releaseDesktopActiveWork();
  }
}
