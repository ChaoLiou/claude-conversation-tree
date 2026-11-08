/**
 * Check every tool file for a syntax error.
 *
 * These files are plain JavaScript, so TypeScript never looks at them.
 * The usual way to break one is a backtick inside a comment inside a
 * template literal, which ends the literal and ruins the rest of the file.
 * That has happened twice, so this runs over all of them at once.
 */
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const files = readdirSync(HERE).filter((name) => /\.(mjs|js)$/.test(name));

let bad = 0;
for (const name of files) {
  try {
    execFileSync(process.execPath, ['--check', join(HERE, name)], { stdio: 'pipe' });
    console.log(`  ok    ${name}`);
  } catch (error) {
    bad++;
    const text = String(error.stderr ?? error.message).split('\n').slice(0, 4).join('\n');
    console.log(`  BAD   ${name}`);
    console.log(text.replace(/^/gm, '        '));
  }
}

console.log('');
console.log(bad === 0 ? `all ${files.length} tool files parse` : `${bad} tool file(s) will not parse`);
process.exit(bad === 0 ? 0 : 1);
