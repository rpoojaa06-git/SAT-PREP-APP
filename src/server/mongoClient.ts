import { MongoClient, Db, MongoError } from 'mongodb';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let connectionPromise: Promise<Db> | null = null;

// Indexes for collections hit by tight polling loops and page-load queries.
// createIndex is a no-op if the index already exists.
async function ensureIndexes(db: Db): Promise<void> {
  try {
    await Promise.all([
      db.collection('questions').createIndex({ question_id: 1 }, { unique: true }),
      db.collection('questions').createIndex({ exam_type: 1, status: 1 }),
      db.collection('audit_logs').createIndex({ id: 1 }, { unique: true }),
      db.collection('audit_logs').createIndex({ exam_type: 1, timestamp: -1 }),
      db.collection('pipeline_runs').createIndex({ question_id: 1 }, { unique: true }),
      db.collection('pipeline_runs').createIndex({ exam_type: 1, started_at: -1 }),
      db.collection('batch_runs').createIndex({ batch_id: 1 }, { unique: true }),
      db.collection('batch_runs').createIndex({ exam_type: 1, status: 1 })
    ]);
    console.log('[MongoDB] ✅ Indexes ensured');
  } catch (e) {
    // Non-fatal — app still works without indexes, just slower.
    console.warn('[MongoDB] Index creation skipped (non-fatal):', e);
  }
}

export async function getDb(): Promise<Db> {
  if (!connectionPromise) {
    connectionPromise = (async () => {
      // Read URI inside the function, not at module load time
      // This ensures dotenv has already run before we read the env var
      const uri = process.env.MONGODB_URI;

      if (!uri) {
        throw new Error('[MongoDB] MONGODB_URI is not set in .env.local');
      }

      const client = new MongoClient(uri, {
        // Let the driver keep retrying reads/writes across a transient
        // network blip instead of surfacing it immediately.
        retryWrites: true,
        retryReads: true,
        // Close idle connections after 30 seconds to prevent Atlas from dropping them and causing ECONNRESET
        maxIdleTimeMS: 30000,
        // 5s was too tight for cold starts (VPN/Wi-Fi still settling, SRV DNS
        // lookup, Atlas cluster waking up) and was producing spurious
        // "Server selection timed out" failures at boot. The retry loop
        // below still gives up quickly on a genuinely dead config.
        serverSelectionTimeoutMS: 15000,
      });

      // CRITICAL: MongoClient is an EventEmitter. If it emits 'error' and
      // nothing is listening, Node throws it as an uncaught exception and
      // kills the entire process — which is exactly what was happening on
      // every ECONNRESET. These listeners just log it; the driver's own
      // connection pool handles reconnection automatically.
      client.on('error', (err) => {
        console.error('[MongoDB] Client error (non-fatal, connection pool will retry):', err);
      });
      client.on('close', () => {
        console.warn('[MongoDB] Connection closed — driver will attempt to reconnect.');
      });
      client.on('timeout', () => {
        console.warn('[MongoDB] Connection timeout — driver will attempt to reconnect.');
      });

      // Prevent process crash from unhandled transient connection errors.
      // Every network-related error the driver can throw (dropped sockets,
      // monitor-timeout pool clears, server-selection timeouts, etc.)
      // extends MongoError — checking the class instead of matching
      // specific error-name/message strings means we don't get blindsided
      // again by a driver error we hadn't seen before (e.g.
      // PoolClearedOnNetworkError, MongoServerSelectionError).
      process.on('uncaughtException', (err) => {
        if (err instanceof MongoError) {
          console.warn('[MongoDB] Caught transient process network error (non-fatal, pool will auto-reconnect):', err.message);
          return;
        }
        console.error('[Process] Uncaught Exception:', err);
        process.exit(1);
      });

      // Retry the *initial* connection a few times with backoff. A single
      // failed attempt at boot (Wi-Fi/VPN still settling, Atlas cluster
      // waking from idle) used to permanently fail getDb() until some other
      // call happened to retry it — this makes the very first call robust
      // to that instead of relying on a lucky second caller.
      const maxAttempts = 4;
      let lastErr: unknown;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          await client.connect();
          const db = client.db();
          console.log('[MongoDB] ✅ Connected to MongoDB Atlas (satprep)');
          await ensureIndexes(db);
          return db;
        } catch (err) {
          lastErr = err;
          console.warn(`[MongoDB] Connection attempt ${attempt}/${maxAttempts} failed:`, (err as Error).message);
          if (attempt < maxAttempts) {
            await sleep(attempt * 2000); // 2s, 4s, 6s backoff
          }
        }
      }

      connectionPromise = null;
      throw lastErr;
    })();
  }
  return connectionPromise;
}