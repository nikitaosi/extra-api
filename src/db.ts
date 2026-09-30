import pg from 'pg';

export function makePool(databaseUrl: string): pg.Pool {
  return new pg.Pool({ connectionString: databaseUrl, max: 5 });
}

export type Database = Pick<pg.Pool, 'query'>;
