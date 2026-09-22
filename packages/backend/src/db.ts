import { readFile } from "node:fs/promises";
import pg from "pg";
export interface Sql {
  query<T = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<T[]>;
}
export interface Database extends Sql {
  transaction<T>(fn: (sql: Sql) => Promise<T>): Promise<T>;
  exec(sql: string): Promise<void>;
  close(): Promise<void>;
}
export function postgres(url: string): Database {
  const pool = new pg.Pool({
    connectionString: url,
    max: 10,
    connectionTimeoutMillis: 5000,
    statement_timeout: 30000,
  });
  const wrap = (client: pg.Pool | pg.PoolClient): Sql => ({
    query: async <T>(sql: string, params?: unknown[]) =>
      (await client.query(sql, params)).rows as T[],
  });
  return {
    ...wrap(pool),
    exec: async (sql) => {
      await pool.query(sql);
    },
    close: () => pool.end(),
    transaction: async (fn) => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await fn(wrap(client));
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
  };
}
export async function migrate(db: Database) {
  await db.exec(
    await readFile(new URL("./schema.sql", import.meta.url), "utf8"),
  );
}
export async function locked<T>(
  db: Database,
  fn: (sql: Sql) => Promise<T>,
): Promise<T> {
  return db.transaction(async (sql) => {
    await sql.query("SELECT id FROM service_lock WHERE id=1 FOR UPDATE");
    return fn(sql);
  });
}
