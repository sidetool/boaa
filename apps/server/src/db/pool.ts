import pg from 'pg';
import { ServerConfig } from '../config.js';

const { Pool } = pg;

/** Only implicit defaults may fall back; network/permission errors never select another database. */
export async function compatibleDatabaseUrl(
  config: Pick<ServerConfig, 'databaseUrl' | 'legacyDatabaseUrl'>,
  probe: (url: string) => Promise<void> = async (connectionString) => {
    const client = new pg.Client({ connectionString });
    try {
      await client.connect();
    } finally {
      await client.end();
    }
  },
): Promise<string> {
  if (!config.legacyDatabaseUrl) return config.databaseUrl;
  try {
    await probe(config.databaseUrl);
    return config.databaseUrl;
  } catch (error) {
    if (!['3D000', '28P01', '28000'].includes((error as { code?: string }).code ?? '')) throw error;
    await probe(config.legacyDatabaseUrl);
    return config.legacyDatabaseUrl;
  }
}

export function createPool(config: ServerConfig): pg.Pool {
  const pool = new Pool({ connectionString: config.databaseUrl, max: 10 });
  if (!config.legacyDatabaseUrl) return pool;
  const connect = pool.connect.bind(pool);
  let ready: Promise<void> | undefined;
  type Callback = (
    error: Error | undefined,
    client: pg.PoolClient | undefined,
    done: (release?: boolean) => void,
  ) => void;
  pool.connect = ((callback?: Callback) => {
    ready ??= compatibleDatabaseUrl(config)
      .then((url) => {
        pool.options.connectionString = url;
      })
      .catch((error: unknown) => {
        ready = undefined;
        throw error;
      });
    const pending = ready.then(() => connect());
    if (!callback) return pending;
    void pending.then(
      (client) => callback(undefined, client, client.release.bind(client)),
      (error: Error) => callback(error, undefined, () => undefined),
    );
  }) as typeof pool.connect;
  return pool;
}

export async function seedDefaultUser(pool: pg.Pool, userId: string): Promise<void> {
  const owner = await pool.query<{ user_id: string }>(
    'select user_id from self_host_accounts where bootstrap_owner_key = 1',
  );
  if (owner.rows[0] && owner.rows[0].user_id !== userId) throw new Error('self_host_account_owner_mismatch');
  await pool.query(
    `
      insert into users (id, email, display_name)
      values ($1, $2, $3)
      on conflict (id) do nothing
    `,
    [userId, 'reader@localhost', 'Local Reader'],
  );
}
