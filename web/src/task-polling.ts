export function nextPollDelay(attempt: number): number | null {
  return attempt < 5 ? Math.min(750 * 2 ** attempt, 6_000) : null;
}

export async function pollTaskUntilTerminal<T>(
  load: () => Promise<T>,
  isTerminal: (value: T) => boolean,
  onSnapshot: (value: T) => void,
  onDisconnected: () => void,
  signal: AbortSignal,
  delay: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<'terminal' | 'disconnected' | 'cancelled'> {
  let consecutiveFailures = 0;
  while (!signal.aborted) {
    let snapshot: T;
    try {
      snapshot = await load();
    } catch {
      if (signal.aborted) return 'cancelled';
      const waitMs = nextPollDelay(consecutiveFailures);
      if (waitMs === null) {
        onDisconnected();
        return 'disconnected';
      }
      consecutiveFailures += 1;
      await delay(waitMs);
      continue;
    }
    if (signal.aborted) return 'cancelled';
    consecutiveFailures = 0;
    onSnapshot(snapshot);
    if (isTerminal(snapshot)) return 'terminal';
    await delay(750);
  }
  return 'cancelled';
}
