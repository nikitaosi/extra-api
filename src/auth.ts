import { createHash, randomBytes } from 'node:crypto';
import { Code, ConnectError, type HandlerContext } from '@connectrpc/connect';
import argon2 from 'argon2';
import type { Database } from './db.js';

const cookieName = 'extra_session';
const sessionSeconds = 60 * 60 * 24 * 7;

export function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function readSessionToken(headers: Headers): string | undefined {
  const cookie = headers.get('cookie') ?? '';
  const match = cookie.match(/(?:^|;\s*)extra_session=([a-f0-9]{64})(?:;|$)/);
  return match?.[1];
}

export function setSessionCookie(headers: Headers, token: string, secure: boolean): void {
  headers.append('set-cookie', `${cookieName}=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${sessionSeconds}${secure ? '; Secure' : ''}`);
}

export function clearSessionCookie(headers: Headers, secure: boolean): void {
  headers.append('set-cookie', `${cookieName}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`);
}

export async function createSession(db: Database, userId: string): Promise<string> {
  const token = randomBytes(32).toString('hex');
  await db.query('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, now() + interval \'7 days\')', [tokenHash(token), userId]);
  return token;
}

export async function requireUser(db: Database, context: HandlerContext): Promise<{ id: string; email: string }> {
  const token = readSessionToken(context.requestHeader);
  if (!token) throw new ConnectError('Sign in required', Code.Unauthenticated);
  const result = await db.query<{ id: string; email: string }>(
    'SELECT u.id, u.email FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = $1 AND s.expires_at > now()',
    [tokenHash(token)],
  );
  const user = result.rows[0];
  if (!user) throw new ConnectError('Session expired', Code.Unauthenticated);
  return user;
}

export async function login(db: Database, email: string, password: string): Promise<{ id: string; email: string; token: string }> {
  const normalized = email.trim().toLowerCase();
  const result = await db.query<{ id: string; email: string; password_hash: string }>(
    'SELECT id, email, password_hash FROM users WHERE email = $1', [normalized],
  );
  const user = result.rows[0];
  if (!user || !(await argon2.verify(user.password_hash, password))) {
    throw new ConnectError('Invalid email or password', Code.Unauthenticated);
  }
  const token = await createSession(db, user.id);
  return { id: user.id, email: user.email, token };
}

export async function logout(db: Database, context: HandlerContext): Promise<void> {
  const token = readSessionToken(context.requestHeader);
  if (token) await db.query('DELETE FROM sessions WHERE token_hash = $1', [tokenHash(token)]);
}
