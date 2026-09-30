import { randomUUID } from 'node:crypto';
import argon2 from 'argon2';
import { makePool } from '../src/db.js';

const email = process.argv[2]?.trim().toLowerCase();
if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Pass a valid email address');
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
if (!process.stdin.isTTY) throw new Error('Run this command in an interactive terminal');
process.stdout.write('Password: ');
const password = await new Promise<string>((resolve, reject) => {
  let value = '';
  process.stdin.setRawMode(true);
  process.stdin.resume();
  const cleanup = () => {
    process.stdin.setRawMode(false);
    process.stdin.pause();
    process.stdin.off('data', onData);
    process.stdout.write('\n');
  };
  const onData = (chunk: Buffer) => {
    for (const char of chunk.toString('utf8')) {
      if (char === '\r' || char === '\n') {
        cleanup();
        resolve(value);
        return;
      }
      if (char === '\u0003') {
        cleanup();
        reject(new Error('Cancelled'));
        return;
      }
      if (char === '\u007f' || char === '\b') value = value.slice(0, -1);
      else value += char;
    }
  };
  process.stdin.on('data', onData);
});
if (password.length < 12) throw new Error('Password must have at least 12 characters');
const pool = makePool(process.env.DATABASE_URL);
try {
  const count = await pool.query<{ count: string }>('SELECT count(*) FROM users');
  if (Number(count.rows[0]?.count) !== 0) throw new Error('A user already exists');
  await pool.query('INSERT INTO users (id, email, password_hash) VALUES ($1, $2, $3)', [randomUUID(), email, await argon2.hash(password)]);
  console.log('User created');
} finally {
  await pool.end();
}
