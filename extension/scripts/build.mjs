import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, context } from 'esbuild';

const extensionRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(extensionRoot, 'out');
const watch = process.argv.includes('--watch');

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(path.join(outDir, 'mcp'), { recursive: true });

const shared = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  sourcemap: false,
  legalComments: 'eof',
  logLevel: 'info',
};
const builds = [
  {
    ...shared,
    entryPoints: [path.join(extensionRoot, 'src', 'extension.ts')],
    outfile: path.join(outDir, 'extension.js'),
    external: ['vscode'],
  },
  {
    ...shared,
    entryPoints: [path.join(extensionRoot, 'src', 'mcp', 'server.ts')],
    outfile: path.join(outDir, 'mcp', 'server.js'),
  },
];

if (watch) {
  const contexts = await Promise.all(builds.map((options) => context(options)));
  await Promise.all(contexts.map((buildContext) => buildContext.watch()));
  console.log('Watching extension and MCP server bundles...');
} else {
  await Promise.all(builds.map((options) => build(options)));
}
