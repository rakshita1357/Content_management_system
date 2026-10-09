import { AppError } from './errors.js';

// Same job as stateStore.js, but the data lives in a Postgres database (for example a free Neon database), so it survives
// restarts and redeploys on hosts whose disk is wiped. One small table of named JSON values.
const TABLE = 'tvads_kv';

export async function createPgStore(databaseUrl, log = null, { pg = null } = {}) {
  let Pool;
  try {
    Pool = (pg || (await import('pg'))).default?.Pool || (pg || (await import('pg'))).Pool;
  } catch {
    throw new AppError(500, 'DATABASE_URL is set, but the "pg" package is not installed.', 'Run "npm install" in the tv-ad-backend folder (on Render, set the build command to: cd tv-ad-backend && npm ci --omit=dev).');
  }
  const pool = new Pool({
    connectionString: databaseUrl,
    max: 3,
    connectionTimeoutMillis: 20_000,   // a sleeping Neon database needs a few seconds to wake
    idleTimeoutMillis: 10_000,         // Neon closes idle connections anyway; let the pool drop them first
  });
  // An idle connection that the database closes must not crash the server: the pool simply opens a new one next time.
  pool.on('error', (err) => { if (log) log.warn(`Database connection dropped (${err.message}); it will reconnect.`); });

  const get = async (key) => {
    const res = await pool.query(`SELECT value FROM ${TABLE} WHERE key = $1`, [key]);
    if (!res.rows.length) return null;
    try {
      return JSON.parse(res.rows[0].value);
    } catch {
      if (log) log.warn(`Saved value "${key}" in the database could not be read; starting without it.`);
      return null;
    }
  };
  const set = (key, value) => pool.query(
    `INSERT INTO ${TABLE} (key, value, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [key, JSON.stringify(value)],
  );
  const del = (key) => pool.query(`DELETE FROM ${TABLE} WHERE key = $1`, [key]);

  // Creates the table on first use. Retries a few times so a database that is waking up does not stop the start-up.
  async function init({ attempts = 4, waitMs = 3000 } = {}) {
    for (let i = 1; ; i++) {
      try {
        await pool.query(`CREATE TABLE IF NOT EXISTS ${TABLE} (key text PRIMARY KEY, value text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now())`);
        return;
      } catch (err) {
        if (i >= attempts) {
          throw new AppError(502, `Cannot reach the database (${err.message}).`, 'Check DATABASE_URL (copy it again from the Neon dashboard, with ?sslmode=require) and that the database is not suspended.');
        }
        if (log) log.warn(`Database not ready (${err.message}); trying again in ${Math.round(waitMs / 1000)} s.`);
        await new Promise((r) => setTimeout(r, waitMs));
      }
    }
  }

  return {
    kind: 'database',
    init,
    async load() { return (await get('state')) || {}; },
    save: (state) => set('state', state),
    loadManifest: () => get('manifest'),
    saveManifest: (manifest) => (manifest ? set('manifest', manifest) : del('manifest')),
    loadScreens: async () => (await get('screens')) || [],
    saveScreens: (rows) => set('screens', rows),
    close: () => pool.end(),
  };
}
