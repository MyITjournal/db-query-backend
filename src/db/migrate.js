import "dotenv/config";
import pool from "./index.js";

/**
 * Creates the users and refresh_tokens tables if they don't already exist.
 * Safe to call on every startup — uses CREATE TABLE IF NOT EXISTS.
 * Does NOT close the pool (safe for use inside a running server).
 */
export async function runMigrations() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Users table — stores GitHub OAuth users with role + active status
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id          VARCHAR(36)  PRIMARY KEY,
        github_id   VARCHAR(50)  NOT NULL UNIQUE,
        username    VARCHAR(255) NOT NULL,
        email       VARCHAR(255),
        avatar_url  VARCHAR(500),
        role        VARCHAR(20)  NOT NULL DEFAULT 'analyst',
        is_active   BOOLEAN      NOT NULL DEFAULT TRUE,
        last_login_at TIMESTAMPTZ,
        created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
      )
    `);

    // Refresh tokens table — tracks issued tokens by jti for rotation + invalidation
    await client.query(`
      CREATE TABLE IF NOT EXISTS refresh_tokens (
        jti         VARCHAR(36)  PRIMARY KEY,
        user_id     VARCHAR(36)  NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        expires_at  TIMESTAMPTZ  NOT NULL,
        created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
      )
    `);

    await client.query("COMMIT");
    console.log("Migration complete: users and refresh_tokens tables ready.");
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Migration failed:", err.message);
    throw err;
  } finally {
    client.release();
  }
}

// Standalone execution: node --env-file=.env src/db/migrate.js
if (process.argv[1].endsWith("migrate.js")) {
  runMigrations()
    .then(() => pool.end())
    .catch(() => process.exit(1));
}
