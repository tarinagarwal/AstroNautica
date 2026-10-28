import pg from "pg";

export type Pool = pg.Pool;
export type Client = pg.PoolClient;
/** Anything that can run a query: the pool or a client inside a transaction. */
export type Queryable = Pick<pg.Pool, "query">;

export function createPool(connectionString: string, max = 10): pg.Pool {
  const pool = new pg.Pool({ connectionString, max });
  // An idle client error (e.g. the server restarted) must not crash the process; the next query reconnects.
  pool.on("error", () => {});
  return pool;
}

/** Run `fn` in a transaction; commits on success, rolls back on any error. */
export async function withTx<T>(pool: pg.Pool, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/** Postgres unique-violation error code. */
export const isUniqueViolation = (e: unknown) => (e as { code?: string })?.code === "23505";
