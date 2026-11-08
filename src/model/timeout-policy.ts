/** Short control calls should fail sooner than long planning or generation calls. */
export function modelTimeoutMs(role: string, defaultMs: number, reviewMs?: number, routeMs?: number): number {
  if (role === 'planner.review') return reviewMs ?? defaultMs;
  if (role === 'planner.route') return routeMs ?? defaultMs;
  return defaultMs;
}
