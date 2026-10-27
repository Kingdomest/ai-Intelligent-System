import { describe, expect, it } from 'vitest';
import { buildApp } from '../../src/api/app.js';

describe('health route', () => {
  it('returns ok without starting a network listener', async () => {
    const app = await buildApp();
    const response = await app.inject({ method: 'GET', url: '/api/health' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });

    await app.close();
  });
});
