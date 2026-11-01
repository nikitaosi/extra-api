import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { fastifyConnectPlugin } from '@connectrpc/connect-fastify';
import fastify from 'fastify';
import type { Pool } from 'pg';
import { hasSessionCookie } from './auth.js';
import { createRoutes } from './routes.js';

export async function buildServer(pool: Pool, frontendOrigin: string, production: boolean) {
  const server = fastify({ logger: true, bodyLimit: 32 * 1024 });
  await server.register(cors, {
    origin: frontendOrigin,
    credentials: true,
    methods: ['POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Connect-Protocol-Version', 'Connect-Timeout-Ms'],
    exposedHeaders: ['Grpc-Status', 'Grpc-Message'],
  });
  await server.register(rateLimit, { global: false });
  const checkLoginRate = server.createRateLimit({ max: 5, timeWindow: '1 minute' });
  server.addHook('onRequest', async (request, reply) => {
    if (request.method === 'POST' && hasSessionCookie(request.headers.cookie) && request.headers.origin !== frontendOrigin) {
      return reply.code(403).send({ code: 'permission_denied', message: 'Untrusted origin' });
    }
    if (request.method === 'POST' && request.url.split('?', 1)[0] === '/extra.v1.AuthService/Login') {
      const limit = await checkLoginRate(request);
      if (!limit.isAllowed && limit.isExceeded) {
        return reply.header('Retry-After', String(limit.ttlInSeconds)).code(429).send({ code: 'resource_exhausted', message: 'Too many login attempts' });
      }
    }
  });
  await server.register(fastifyConnectPlugin, { routes: createRoutes(pool, production) });
  server.get('/health', async () => {
    await pool.query('SELECT 1');
    return { status: 'ok' };
  });
  server.addHook('onClose', async () => pool.end());
  return server;
}
