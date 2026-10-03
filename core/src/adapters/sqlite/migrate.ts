import { migrations, checksum as hash } from '../sql/migrations.js';
import type { SqlDriver } from './driver.js';

/** Numbered migrations and their checksums are committed together, once only. */
export async function migrate(driver: SqlDriver): Promise<void> {
  const scripts = migrations;
  await driver.transaction(true, async () => {
    driver.run(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL
    ) STRICT;`);
    const applied = driver.prepare('SELECT version, name, checksum FROM schema_migrations ORDER BY version').all();
    if (applied.length > scripts.length) throw new Error('Database schema is newer than this adapter');
    for (const [index, script] of scripts.entries()) {
      const version = index + 1;
      const checksum = await hash(script.sql);
      const prior = applied[index];
      if (prior) {
        if (prior.version !== version || prior.name !== script.name || prior.checksum !== checksum) {
          throw new Error('SQLite migration history does not match this adapter');
        }
      } else {
        driver.run(script.sql);
        driver.prepare('INSERT INTO schema_migrations(version, name, checksum) VALUES (?, ?, ?)').run(version, script.name, checksum);
      }
    }
  });
}
