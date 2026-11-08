/**
 * Build the extension for Chrome and for Firefox from one source tree.
 *
 * The two differ only in the manifest. Firefox needs an add-on id, or its
 * storage area is not kept between runs.
 *
 * Usage:
 *   node tools/build.mjs            build both
 *   node tools/build.mjs --watch    rebuild on every change
 *   node tools/build.mjs --target chrome
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const DIST = join(ROOT, 'dist');

// package.json holds the one true version. The release workflow checks that
// the git tag agrees with it, so the manifest and the tag can never differ.
const VERSION = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
const NAME = 'Claude Conversation Tree';
const DESCRIPTION =
  'Show the dependency tree of the questions and answers in a claude.ai conversation, '
  + 'and say which exchange each question depends on.';

const args = process.argv.slice(2);
const watch = args.includes('--watch');
const only = args.includes('--target') ? args[args.indexOf('--target') + 1] : null;

/** The part of the manifest that both browsers share. */
function baseManifest() {
  return {
    manifest_version: 3,
    name: NAME,
    version: VERSION,
    description: DESCRIPTION,
    permissions: ['storage'],
    content_scripts: [
      {
        matches: ['https://claude.ai/*'],
        js: ['content.js'],
        run_at: 'document_idle',
        all_frames: false,
      },
    ],
  };
}

const TARGETS = {
  chrome: {
    /** Chrome 120 covers every current Chrome and Edge. */
    esbuildTarget: ['chrome120'],
    manifest: () => baseManifest(),
  },
  firefox: {
    /** Firefox 115 is the oldest release with manifest version 3. */
    esbuildTarget: ['firefox115'],
    manifest: () => ({
      ...baseManifest(),
      browser_specific_settings: {
        gecko: {
          // Firefox ties the storage area to this id. Without it, the tree
          // disappears between runs.
          id: 'claude-conversation-tree@chaol.local',
          strict_min_version: '115.0',
        },
        gecko_android: {
          strict_min_version: '115.0',
        },
      },
    }),
  },
};

const chosen = only === null ? Object.keys(TARGETS) : [only];
for (const name of chosen) {
  if (TARGETS[name] === undefined) {
    console.error(`unknown target: ${name}. Pick one of: ${Object.keys(TARGETS).join(', ')}`);
    process.exit(1);
  }
}

async function buildOne(name) {
  const target = TARGETS[name];
  const outDir = join(DIST, name);
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  writeFileSync(
    join(outDir, 'manifest.json'),
    JSON.stringify(target.manifest(), null, 2) + '\n',
  );

  const options = {
    entryPoints: [join(ROOT, 'src', 'content.ts')],
    outfile: join(outDir, 'content.js'),
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: target.esbuildTarget,
    sourcemap: watch ? 'inline' : false,
    minify: !watch,
    legalComments: 'none',
    logLevel: 'warning',
  };

  if (watch) {
    const context = await esbuild.context(options);
    await context.watch();
    console.log(`[build] watching ${name} -> dist/${name}/`);
    return context;
  }

  const result = await esbuild.build(options);
  const bytes = result.metafile ? 0 : 0;
  void bytes;
  console.log(`[build] ${name} -> dist/${name}/`);
  return null;
}

const contexts = [];
for (const name of chosen) {
  contexts.push(await buildOne(name));
}

if (watch) {
  console.log('[build] press ctrl+c to stop');
  await new Promise(() => {});
} else {
  const { statSync } = await import('node:fs');
  for (const name of chosen) {
    const size = statSync(join(DIST, name, 'content.js')).size;
    console.log(`[build] ${name}/content.js  ${(size / 1024).toFixed(1)} KiB`);
  }
}
