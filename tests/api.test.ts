import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import argon2 from 'argon2';
import type { Pool } from 'pg';
import { buildServer } from '../src/server.js';

const categoryId = 'cbcd0ac9-8d90-4ac9-a811-f868110f2fb1';

test('authenticated expense CRUD, validation, and owner isolation', async () => {
  const database = new PGlite();
  const migration = await readFile(fileURLToPath(new URL('../migrations/0001_init.sql', import.meta.url)), 'utf8');
  await database.exec(migration);
  const firstUserId = randomUUID();
  const secondUserId = randomUUID();
  const hash = await argon2.hash('correct horse battery staple');
  await database.query('INSERT INTO users (id, email, password_hash) VALUES ($1, $2, $3), ($4, $5, $6)', [
    firstUserId, 'first@example.com', hash, secondUserId, 'second@example.com', hash,
  ]);
  const pool = {
    query: database.query.bind(database),
    end: database.close.bind(database),
  } as unknown as Pool;
  const app = await buildServer(pool, 'http://localhost:3000', false);
  await app.ready();
  const call = async (method: string, payload: object, cookie?: string) => {
    const response = await app.inject({
      method: 'POST',
      url: `/extra.v1.${method}`,
      headers: { 'content-type': 'application/json', origin: 'http://localhost:3000', ...(cookie ? { cookie } : {}) },
      payload,
    });
    return response;
  };

  try {
    const unauthorized = await call('ExpenseService/ListExpenses', {});
    assert.equal(unauthorized.statusCode, 401);

    const badLogin = await call('AuthService/Login', { email: 'first@example.com', password: 'wrong' });
    assert.equal(badLogin.statusCode, 401);

    const login = await call('AuthService/Login', { email: 'first@example.com', password: 'correct horse battery staple' });
    assert.equal(login.statusCode, 200);
    const cookie = login.headers['set-cookie']?.toString().split(';')[0];
    assert.ok(cookie?.startsWith('extra_session='));

    const categories = await call('ExpenseService/ListCategories', {}, cookie);
    assert.equal(categories.statusCode, 200);
    assert.equal(categories.json().categories.length, 4);

    const invalid = await call('ExpenseService/CreateExpense', { input: {
      amountMinor: '0', currency: 'CURRENCY_GEL', occurredAt: '2026-01-01T12:00:00Z', categoryId,
    } }, cookie);
    assert.equal(invalid.statusCode, 400);

    const create = await call('ExpenseService/CreateExpense', { input: {
      amountMinor: '1234', currency: 'CURRENCY_GEL', occurredAt: '2026-01-01T12:00:00Z',
      description: 'Lunch', categoryId,
    } }, cookie);
    assert.equal(create.statusCode, 200, create.body);
    const id = create.json().expense.id as string;
    assert.equal(create.json().expense.amountMinor, '1234');

    const list = await call('ExpenseService/ListExpenses', { query: 'lun' }, cookie);
    assert.equal(list.statusCode, 200, list.body);
    assert.equal(list.json().total, 1);
    assert.equal(list.json().expenses[0].id, id);

    const update = await call('ExpenseService/UpdateExpense', { id, input: {
      amountMinor: '5678', currency: 'CURRENCY_USD', occurredAt: '2026-01-02T12:00:00Z',
      description: 'Dinner', categoryId,
    } }, cookie);
    assert.equal(update.statusCode, 200, update.body);
    assert.equal(update.json().expense.amountMinor, '5678');

    const otherLogin = await call('AuthService/Login', { email: 'second@example.com', password: 'correct horse battery staple' });
    const otherCookie = otherLogin.headers['set-cookie']?.toString().split(';')[0];
    assert.ok(otherCookie);
    const inaccessible = await call('ExpenseService/GetExpense', { id }, otherCookie);
    assert.equal(inaccessible.statusCode, 404);

    const deleted = await call('ExpenseService/DeleteExpense', { id }, cookie);
    assert.equal(deleted.statusCode, 200);
    const afterDelete = await call('ExpenseService/GetExpense', { id }, cookie);
    assert.equal(afterDelete.statusCode, 404);

    const logout = await call('AuthService/Logout', {}, cookie);
    assert.equal(logout.statusCode, 200);
    const afterLogout = await call('AuthService/Me', {}, cookie);
    assert.equal(afterLogout.statusCode, 401);

    let limited;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      limited = await call('AuthService/Login', { email: 'first@example.com', password: 'wrong' });
      if (limited.statusCode === 429) break;
    }
    assert.equal(limited?.statusCode, 429);
  } finally {
    await app.close();
  }
});
