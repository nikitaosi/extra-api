import { makePool } from './db.js';
import { buildServer } from './server.js';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');
const frontendOrigin = process.env.FRONTEND_ORIGIN;
if (!frontendOrigin) throw new Error('FRONTEND_ORIGIN is required');
const port = Number(process.env.PORT ?? 3101);
if (!Number.isInteger(port) || port <= 0) throw new Error('Invalid PORT');
const pool = makePool(databaseUrl);
const server = await buildServer(pool, frontendOrigin, process.env.NODE_ENV === 'production');
await server.listen({ host: process.env.HOST ?? (process.env.NODE_ENV === 'production' ? '0.0.0.0' : '127.0.0.1'), port });
