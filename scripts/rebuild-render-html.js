#!/usr/bin/env node

import { mkdir, readdir, readFile, writeFile } from 'fs/promises';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PARTS_DIR = join(SCRIPT_DIR, 'render-html.parts');
const OUTPUT_PATH = join(SCRIPT_DIR, 'render-html.js');

async function main() {
  const files = (await readdir(PARTS_DIR))
    .filter((name) => /^part-\d+\.txt$/.test(name))
    .sort((left, right) => left.localeCompare(right));

  if (files.length === 0) {
    throw new Error(`No render-html parts found in ${PARTS_DIR}`);
  }

  const chunks = [];
  for (const file of files) {
    chunks.push(await readFile(join(PARTS_DIR, file), 'utf-8'));
  }

  await mkdir(SCRIPT_DIR, { recursive: true });
  await writeFile(OUTPUT_PATH, chunks.join(''), 'utf-8');

  console.log(JSON.stringify({
    status: 'ok',
    output: OUTPUT_PATH,
    parts: files.length
  }, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({ status: 'error', message: error.message }, null, 2));
  process.exit(1);
});
