import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileFromFile } from 'json-schema-to-typescript';

const core = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const schemaDirectory = resolve(core, '../schema');

// No network resolution, timestamps, environment paths, or platform-specific EOLs.
export async function generatedFiles() {
  const filenames = (await readdir(schemaDirectory))
    .filter((name) => name.endsWith('.schema.json') && name !== 'common.schema.json')
    .sort();
  const files = new Map();
  for (const filename of filenames) {
    const schema = JSON.parse(await readFile(resolve(schemaDirectory, filename), 'utf8'));
    const output = await compileFromFile(resolve(schemaDirectory, filename), {
      cwd: schemaDirectory,
      $refOptions: { resolve: { http: false } },
      bannerComment: '/* Generated from schema/' + filename + '. Do not edit. Run pnpm run generate. */',
      enableConstEnums: false,
      unknownAny: true,
      style: { singleQuote: true, semi: true, tabWidth: 2, printWidth: 100, endOfLine: 'lf' },
    });
    if (!schema.title) throw new Error(`${filename} must declare a title`);
    files.set(filename.replace('.schema.json', '.ts'), output.replaceAll('\r\n', '\n'));
  }
  const common = JSON.parse(await readFile(resolve(schemaDirectory, 'common.schema.json'), 'utf8'));
  const vocabularies = [
    ['CONTACT_STATES', 'contact_state', "Contact['state']"],
    ['PROJECT_STATES', 'project_state', "Project['state']"],
    ['ITEM_STATES', 'item_state', "WorkItem['state']"],
    ['WORK_ITEM_KINDS', 'work_kind', "WorkItem['kind']"],
  ];
  const constants = vocabularies.map(([name, key, type]) => {
    const values = common.$defs[key].enum;
    if (!Array.isArray(values) || values.some((value) => typeof value !== 'string')) {
      throw new Error(`Invalid vocabulary: ${key}`);
    }
    return `export const ${name} = ${JSON.stringify(values)} as const satisfies readonly ${type}[];`;
  });
  files.set('status.ts', [
    '/* Generated from schema/common.schema.json. Do not edit. Run pnpm run generate. */',
    "import type { Contact } from './contact.js';",
    "import type { Project } from './project.js';",
    "import type { WorkItem } from './work_item.js';",
    '', ...constants, '',
  ].join('\n'));
  return files;
}

export async function generate(destination = resolve(core, 'src/generated')) {
  const files = await generatedFiles();
  await mkdir(destination, { recursive: true });
  for (const [name, content] of files) await writeFile(resolve(destination, name), content);
  return files;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await generate(process.argv[2] ? resolve(process.argv[2]) : undefined);
}
