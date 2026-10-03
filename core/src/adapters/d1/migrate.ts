import type { D1Driver } from './driver.js';
import { batch } from './driver.js';
import { migrations, checksum, statements } from '../sql/migrations.js';
interface Applied { version: number; name: string; checksum: string }
/** Run explicitly at setup, never per HTTP request. Each version is one atomic batch. */
export async function migrate(driver: D1Driver): Promise<void> {
  await batch(driver, [driver.prepare(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL
  ) STRICT;`)]);
  const result = await driver.prepare('SELECT version, name, checksum FROM schema_migrations ORDER BY version').all<Applied>();
  if (!result.success) throw new Error('Cannot read D1 migration history');
  if (result.results.length > migrations.length) throw new Error('Database schema is newer than this adapter');
  for (const [index, script] of migrations.entries()) {
    const version = index + 1;
    const digest = await checksum(script.sql);
    const prior = result.results[index];
    if (prior) {
      if (prior.version !== version || prior.name !== script.name || prior.checksum !== digest) {
        throw new Error('D1 migration history does not match this adapter');
      }
    } else {
      await batch(driver, [...statements(script.sql).map(sql => driver.prepare(sql)),
        driver.prepare('INSERT INTO schema_migrations(version, name, checksum) VALUES (?, ?, ?)').bind(version, script.name, digest)]);
    }
  }
}
