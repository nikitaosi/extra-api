import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import argon2 from 'argon2';
import type { Pool } from 'pg';
import { tokenHash } from '../src/auth.js';
import { buildServer } from '../src/server.js';

const frontendOrigin = 'https://extra-tracker.netlify.app';
const password = 'correct horse battery staple';
const categoryId = 'cbcd0ac9-8d90-4ac9-a811-f868110f2fb1';
const validInput = {
  amountMinor: '1234',
  currency: 'CURRENCY_THB',
  occurredAt: '2026-01-01T12:00:00Z',
  description: 'Lunch',
  categoryId,
};

type CallOptions = {
  cookie?: string;
  origin?: string | null;
};

async function createFixture() {
  const database = new PGlite();
  const migrations = new URL('../migrations/', import.meta.url);
  const migrationFiles = (await readdir(migrations)).filter((name) => name.endsWith('.sql')).sort();
  for (const name of migrationFiles) await database.exec(await readFile(new URL(name, migrations), 'utf8'));

  const hash = await argon2.hash(password);
  await database.query('INSERT INTO users (id, email, password_hash) VALUES ($1, $2, $3), ($4, $5, $6)', [
    randomUUID(), 'first@example.com', hash, randomUUID(), 'second@example.com', hash,
  ]);
  const pool = {
    query: database.query.bind(database),
    end: database.close.bind(database),
  } as unknown as Pool;
  const app = await buildServer(pool, frontendOrigin, true);
  await app.ready();

  const call = (method: string, payload: object, { cookie, origin = frontendOrigin }: CallOptions = {}) => app.inject({
    method: 'POST',
    url: '/extra.v1.' + method,
    headers: {
      'content-type': 'application/json',
      ...(origin === null ? {} : { origin }),
      ...(cookie ? { cookie } : {}),
    },
    payload,
  });
  const signIn = async (email = 'first@example.com') => {
    const response = await call('AuthService/Login', { email, password });
    assert.equal(response.statusCode, 200, response.body);
    const cookie = response.headers['set-cookie']?.toString().split(';')[0];
    assert.ok(cookie);
    assert.ok(cookie.startsWith('extra_session='));
    assert.match(response.headers['set-cookie']?.toString() ?? '', /HttpOnly; Path=\/; SameSite=Lax; Max-Age=\d+; Secure/);
    return cookie;
  };
  return { app, call, database, signIn };
}

test('authenticated expense CRUD and owner isolation', async () => {
  const { app, call, signIn } = await createFixture();
  try {
    assert.equal((await call('ExpenseService/ListExpenses', {})).statusCode, 401);

    const cookie = await signIn();
    const categories = await call('ExpenseService/ListCategories', {}, { cookie });
    assert.equal(categories.statusCode, 200);
    assert.equal(categories.json().categories.length, 4);

    const create = await call('ExpenseService/CreateExpense', { input: validInput }, { cookie });
    assert.equal(create.statusCode, 200, create.body);
    const id = create.json().expense.id as string;
    assert.equal(create.json().expense.amountMinor, '1234');
    assert.equal(create.json().expense.currency, 'CURRENCY_THB');

    const list = await call('ExpenseService/ListExpenses', { query: 'lun' }, { cookie });
    assert.equal(list.statusCode, 200, list.body);
    assert.equal(list.json().total, 1);
    assert.equal(list.json().expenses[0].id, id);

    const literalWildcard = await call('ExpenseService/ListExpenses', { query: '%' }, { cookie });
    assert.equal(literalWildcard.statusCode, 200);
    assert.equal(literalWildcard.json().total ?? 0, 0);

    const update = await call('ExpenseService/UpdateExpense', { id, input: {
      ...validInput, amountMinor: '5678', currency: 'CURRENCY_USD', description: 'Dinner',
    } }, { cookie });
    assert.equal(update.statusCode, 200, update.body);
    assert.equal(update.json().expense.amountMinor, '5678');

    const otherCookie = await signIn('second@example.com');
    assert.equal((await call('ExpenseService/ListExpenses', {}, { cookie: otherCookie })).json().total ?? 0, 0);
    assert.equal((await call('ExpenseService/GetExpense', { id }, { cookie: otherCookie })).statusCode, 404);
    assert.equal((await call('ExpenseService/UpdateExpense', { id, input: validInput }, { cookie: otherCookie })).statusCode, 404);
    assert.equal((await call('ExpenseService/DeleteExpense', { id }, { cookie: otherCookie })).statusCode, 404);

    const ownerRecord = await call('ExpenseService/GetExpense', { id }, { cookie });
    assert.equal(ownerRecord.statusCode, 200);
    assert.equal(ownerRecord.json().expense.amountMinor, '5678');
    assert.equal((await call('ExpenseService/DeleteExpense', { id }, { cookie })).statusCode, 200);
    assert.equal((await call('ExpenseService/GetExpense', { id }, { cookie })).statusCode, 404);
  } finally {
    await app.close();
  }
});

test('missing, expired, and logged-out sessions cannot be reused', async () => {
  const { app, call, database, signIn } = await createFixture();
  try {
    assert.equal((await call('AuthService/Me', {})).statusCode, 401);
    assert.equal((await call('ExpenseService/ListExpenses', {})).statusCode, 401);
    assert.equal((await call('AuthService/Me', {}, { cookie: 'extra_session=invalid' })).statusCode, 401);

    const expiredCookie = await signIn();
    const token = expiredCookie.slice('extra_session='.length);
    await database.query("UPDATE sessions SET expires_at = now() - interval '1 second' WHERE token_hash = $1", [tokenHash(token)]);
    assert.equal((await call('AuthService/Me', {}, { cookie: expiredCookie })).statusCode, 401);
    assert.equal((await call('ExpenseService/ListExpenses', {}, { cookie: expiredCookie })).statusCode, 401);

    const cookie = await signIn();
    assert.equal((await call('AuthService/Me', {}, { cookie })).statusCode, 200);
    const logout = await call('AuthService/Logout', {}, { cookie });
    assert.equal(logout.statusCode, 200);
    assert.match(logout.headers['set-cookie']?.toString() ?? '', /Max-Age=0/);
    assert.equal((await call('AuthService/Me', {}, { cookie })).statusCode, 401);
    assert.equal((await call('ExpenseService/ListExpenses', {}, { cookie })).statusCode, 401);
  } finally {
    await app.close();
  }
});

test('cookie-authenticated requests accept the Netlify origin and reject untrusted origins', async () => {
  const { app, call, signIn } = await createFixture();
  try {
    const cookie = await signIn();
    const proxiedRequest = await app.inject({
      method: 'POST',
      url: '/extra.v1.AuthService/Me',
      headers: {
        'content-type': 'application/json',
        host: 'extra-api-6zch.onrender.com',
        origin: frontendOrigin,
        cookie,
      },
      payload: {},
    });
    assert.equal(proxiedRequest.statusCode, 200);

    for (const origin of ['https://attacker.example', frontendOrigin + '.attacker.example', 'null', null]) {
      const response = await call('AuthService/Me', {}, { cookie, origin });
      assert.equal(response.statusCode, 403, String(origin) + ': ' + response.body);
      assert.equal(response.json().code, 'permission_denied');
    }
    const blockedCreate = await call('ExpenseService/CreateExpense', { input: validInput }, {
      cookie, origin: 'https://attacker.example',
    });
    assert.equal(blockedCreate.statusCode, 403);
    assert.equal((await call('AuthService/Logout', {}, {
      cookie, origin: 'https://attacker.example',
    })).statusCode, 403);
    assert.equal((await call('ExpenseService/ListExpenses', {}, { cookie })).json().total ?? 0, 0);
    assert.equal((await call('AuthService/Me', {}, { cookie })).statusCode, 200);
    assert.equal((await app.inject({ method: 'GET', url: '/health', headers: { cookie } })).statusCode, 200);
  } finally {
    await app.close();
  }
});

test('invalid pagination, filters, and expense input are rejected', async () => {
  const { app, call, signIn } = await createFixture();
  try {
    const cookie = await signIn();
    const cases: [string, string, object][] = [
      ['page above limit', 'ExpenseService/ListExpenses', { page: 10_001 }],
      ['negative page', 'ExpenseService/ListExpenses', { page: -1 }],
      ['page size above limit', 'ExpenseService/ListExpenses', { pageSize: 101 }],
      ['long query', 'ExpenseService/ListExpenses', { query: 'x'.repeat(101) }],
      ['malformed category filter', 'ExpenseService/ListExpenses', { categoryId: 'not-a-uuid' }],
      ['missing expense input', 'ExpenseService/CreateExpense', {}],
      ['zero amount', 'ExpenseService/CreateExpense', { input: { ...validInput, amountMinor: '0' } }],
      ['amount above limit', 'ExpenseService/CreateExpense', { input: { ...validInput, amountMinor: '100000000000' } }],
      ['unsupported currency', 'ExpenseService/CreateExpense', { input: { ...validInput, currency: 'CURRENCY_UNSPECIFIED' } }],
      ['unknown category', 'ExpenseService/CreateExpense', { input: { ...validInput, categoryId: randomUUID() } }],
      ['future date', 'ExpenseService/CreateExpense', { input: { ...validInput, occurredAt: '2100-01-01T12:00:00Z' } }],
      ['long description', 'ExpenseService/CreateExpense', { input: { ...validInput, description: 'x'.repeat(501) } }],
      ['malformed expense ID', 'ExpenseService/GetExpense', { id: 'not-a-uuid' }],
    ];
    for (const [name, method, payload] of cases) {
      const response = await call(method, payload, { cookie });
      assert.equal(response.statusCode, 400, name + ': ' + response.body);
    }
    assert.equal((await call('ExpenseService/ListExpenses', {}, { cookie })).json().total ?? 0, 0);
  } finally {
    await app.close();
  }
});

test('login is rate limited and unknown users get the same error as wrong passwords', async () => {
  const { app, call } = await createFixture();
  try {
    const unknown = await call('AuthService/Login', { email: 'missing@example.com', password: 'wrong' });
    const wrong = await call('AuthService/Login', { email: 'first@example.com', password: 'wrong' });
    assert.equal(unknown.statusCode, 401);
    assert.equal(wrong.statusCode, 401);
    assert.equal(unknown.json().message, wrong.json().message);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      assert.equal((await call('AuthService/Login', { email: 'first@example.com', password: 'wrong' })).statusCode, 401);
    }
    const limited = await app.inject({
      method: 'POST',
      url: '/extra.v1.AuthService/Login?source=browser',
      headers: { 'content-type': 'application/json', origin: frontendOrigin },
      payload: { email: 'first@example.com', password },
    });
    assert.equal(limited.statusCode, 429);
    assert.ok(Number(limited.headers['retry-after']) > 0);
    assert.equal(limited.json().code, 'resource_exhausted');
    assert.equal((await call('AuthService/Login', { email: 'first@example.com', password })).statusCode, 429);
  } finally {
    await app.close();
  }
});
