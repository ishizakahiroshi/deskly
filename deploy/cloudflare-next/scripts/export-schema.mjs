// Explicit offline generation only. No credentials or remote connection.
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { migrations, checksum } from '../../../core/.build/adapters/sql/migrations.js';
const output = process.argv[2];
if (!output || process.argv.length !== 3) throw new Error('Usage: node export-schema.mjs <new-output.sql>');
const quote = value => `'${value.replaceAll("'", "''")}'`;
const sql = ['-- Apply once to a new empty D1 database, never to the legacy database.',
  'CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL) STRICT;'];
for (const [index, migration] of migrations.entries()) {
  sql.push(migration.sql, `INSERT INTO schema_migrations(version,name,checksum) VALUES (${index + 1},${quote(migration.name)},${quote(await checksum(migration.sql))});`);
}
await writeFile(resolve(output), sql.join('\n'), { flag: 'wx' });
