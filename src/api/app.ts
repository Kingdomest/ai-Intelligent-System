import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';

export interface AppDependencies {
  registerRoutes?: (app: FastifyInstance) => Promise<void> | void;
  webRoot?: string;
}

export async function buildApp(dependencies: AppDependencies = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });

  app.get('/api/health', async () => ({ status: 'ok' }));

  if (dependencies.registerRoutes) {
    await dependencies.registerRoutes(app);
  }

  if (dependencies.webRoot) {
    await app.register(fastifyStatic, { root: dependencies.webRoot, prefix: '/' });
    app.get('/', async (_request, reply) => reply.sendFile('index.html'));
  }

  return app;
}
