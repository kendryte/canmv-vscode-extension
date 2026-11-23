const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { compileFunction } = require('node:vm');
const { buildSync } = require('esbuild');

const { outputFiles: [{ text: bundle }] } = buildSync({
  stdin: {
    contents: `
      export { ExamplesService } from './src/service/examplesService';
      export { isUsableExamplesCache, listExamplesCaches } from './src/service/resourceCache';
      export { StubsService } from './src/service/stubsService';
    `,
    resolveDir: path.resolve(__dirname, '..'),
    loader: 'ts',
  },
  bundle: true,
  write: false,
  platform: 'node',
  format: 'cjs',
  external: ['vscode'],
});
const loadServices = compileFunction(bundle, ['require', 'module']);

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'canmv-resource-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'profile-\u674e');
  fs.mkdirSync(home);
  const vscode = {
    EventEmitter: class { event = () => {}; fire() {} },
    l10n: { t: message => message },
    workspace: { getConfiguration: () => ({ get: (_key, fallback) => fallback }) },
    window: { createOutputChannel: () => ({ appendLine() {} }) },
  };
  const testModule = { exports: {} };
  loadServices(id => id === 'vscode' ? vscode : id === 'os' ? { ...os, homedir: () => home } : require(id), testModule);
  return { home, ...testModule.exports };
}

function writeFile(filename, contents) {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, contents);
}

// Windows may refuse a junction to a missing folder, so link first and then remove the target.
function brokenLink(target, link) {
  fs.mkdirSync(target, { recursive: true });
  fs.symlinkSync(target, link, 'junction');
  fs.rmSync(target, { recursive: true });
}

test('Pylance copies nested stubs without cpSync and keeps CanMV entries on collision', t => {
  t.mock.method(fs, 'cpSync', () => assert.fail('Do not use fs.cpSync for overlays'));
  const { home, StubsService } = fixture(t);
  const service = new StubsService(undefined);
  const stubs = path.join(home, 'stubs');
  const custom = path.join(home, 'custom');
  writeFile(path.join(stubs, 'array.pyi'), 'CanMV array');
  writeFile(path.join(stubs, 'asyncio', 'tasks', '__init__.pyi'), 'CanMV tasks');
  writeFile(path.join(custom, 'array.pyi'), 'user array');
  writeFile(path.join(custom, 'asyncio', 'user.pyi'), 'user asyncio');
  writeFile(path.join(custom, 'extra', '__init__.pyi'), 'user extra');

  const overlay = service.buildPylanceStubOverlay(stubs, custom);
  assert.equal(overlay.refreshed, true);
  assert.equal(fs.readFileSync(path.join(overlay.stubPath, 'array.pyi'), 'utf8'), 'CanMV array');
  assert.equal(fs.readFileSync(path.join(overlay.stubPath, 'asyncio', 'tasks', '__init__.pyi'), 'utf8'), 'CanMV tasks');
  assert.equal(fs.existsSync(path.join(overlay.stubPath, 'asyncio', 'user.pyi')), false);
  assert.equal(fs.readFileSync(path.join(overlay.stubPath, 'extra', '__init__.pyi'), 'utf8'), 'user extra');
  assert.deepEqual(service.buildPylanceStubOverlay(stubs, custom), { stubPath: overlay.stubPath, refreshed: false });
});

test('Pylance materializes directory links and skips cycles and broken links', t => {
  const { home, StubsService } = fixture(t);
  const service = new StubsService(undefined);
  const stubs = path.join(home, 'stubs');
  const linked = path.join(home, 'linked');
  writeFile(path.join(linked, '__init__.pyi'), 'linked file');
  writeFile(path.join(stubs, 'nested', 'mod.pyi'), 'nested');
  fs.symlinkSync(linked, path.join(stubs, 'linked'), 'junction');

  const overlay = service.buildPylanceStubOverlay(stubs, '');
  const target = path.join(overlay.stubPath, 'linked');
  assert(fs.lstatSync(target).isDirectory());
  assert.equal(fs.readFileSync(path.join(target, '__init__.pyi'), 'utf8'), 'linked file');

  fs.symlinkSync(stubs, path.join(stubs, 'cycle'), 'junction');
  fs.symlinkSync(path.join(stubs, 'nested'), path.join(stubs, 'nested', 'self'), 'junction');
  brokenLink(path.join(home, 'missing'), path.join(stubs, 'broken'));
  const rebuilt = service.buildPylanceStubOverlay(stubs, '');
  assert.equal(rebuilt.refreshed, true);
  assert.deepEqual(fs.readdirSync(rebuilt.stubPath).filter(name => !name.startsWith('.')).sort(), ['linked', 'nested']);
  assert.deepEqual(fs.readdirSync(path.join(rebuilt.stubPath, 'nested')), ['mod.pyi']);
  assert.deepEqual(service.buildPylanceStubOverlay(stubs, ''), { stubPath: rebuilt.stubPath, refreshed: false });
});

test('Pylance keeps the overlay when a user stub entry is unusable', t => {
  const { home, StubsService } = fixture(t);
  const service = new StubsService(undefined);
  const stubs = path.join(home, 'stubs');
  const custom = path.join(home, 'custom');
  writeFile(path.join(stubs, 'machine.pyi'), 'CanMV machine');
  writeFile(path.join(custom, 'mylib.pyi'), 'user lib');
  brokenLink(path.join(home, 'gone'), path.join(custom, 'gone'));

  const overlay = service.buildPylanceStubOverlay(stubs, custom);
  assert.equal(fs.readFileSync(path.join(overlay.stubPath, 'mylib.pyi'), 'utf8'), 'user lib');
  assert.equal(fs.existsSync(path.join(overlay.stubPath, 'gone')), false);
  assert.deepEqual(service.buildPylanceStubOverlay(stubs, custom), { stubPath: overlay.stubPath, refreshed: false });
});

test('Pylance refuses a user stub folder that contains the overlay and cleans up', t => {
  const { home, StubsService } = fixture(t);
  const service = new StubsService(undefined);
  const stubs = path.join(home, 'stubs');
  writeFile(path.join(stubs, 'machine.pyi'), 'CanMV machine');

  assert.throws(() => service.buildPylanceStubOverlay(stubs, home), /contains the Pylance overlay/);
  const overlayParents = path.join(home, '.kendryte', 'k230_canmv_pylance');
  for (const scope of fs.readdirSync(overlayParents)) {
    assert.deepEqual(fs.readdirSync(path.join(overlayParents, scope)), []);
  }
});

function examplesFixture(t) {
  const { ExamplesService, isUsableExamplesCache, listExamplesCaches } = fixture(t);
  const state = new Map();
  const context = {
    globalState: { get: key => state.get(key), update: async (key, value) => state.set(key, value) },
  };
  const routes = { fetchBuffer: async () => Buffer.from('mock archive') };
  const service = new ExamplesService(context, routes);
  const route = { examplesId: 'a'.repeat(64), examplesUrl: 'https://example.invalid/examples.zip' };
  const cache = path.join(service.examplesRootDir(), route.examplesId);
  return { service, route, cache, state, isUsableExamplesCache, listExamplesCaches };
}

test('Examples retry after a partial extraction and publish only on success', async t => {
  const { service, route, cache, isUsableExamplesCache } = examplesFixture(t);
  let attempts = 0;
  service.extractArchive = async (archive, staging) => {
    assert.equal(fs.existsSync(archive), true);
    writeFile(path.join(staging, 'examples', 'nested', 'main.py'), 'example');
    assert.notEqual(cache, staging);
    assert.equal(fs.existsSync(cache), false);
    assert.equal(isUsableExamplesCache(staging), false);
    assert.equal(service.activeExamplesDir(), '');
    if (++attempts === 1) throw new Error('interrupted extraction');
  };

  assert.equal(await service.ensureExamples(route), null);
  assert.deepEqual(fs.readdirSync(service.examplesRootDir()), []);
  assert.equal(await service.ensureExamples(route), cache);
  assert.equal(await service.ensureExamples(route), cache);
  assert.equal(attempts, 2);
  assert.deepEqual(fs.readdirSync(service.examplesRootDir()), [route.examplesId]);
  assert.deepEqual(fs.readdirSync(cache), ['examples']);
  assert.equal(fs.readFileSync(path.join(cache, 'examples', 'nested', 'main.py'), 'utf8'), 'example');
});

test('Examples refresh replaces an unfinished legacy cache and preserves valid offline caches', async t => {
  const { service, route, cache, isUsableExamplesCache } = examplesFixture(t);
  const offline = path.join(service.examplesRootDir(), 'b'.repeat(64));
  writeFile(path.join(offline, 'models', 'old.kmodel'), 'model');
  fs.mkdirSync(path.join(cache, 'examples'), { recursive: true });
  assert.equal(isUsableExamplesCache(cache), false);
  writeFile(path.join(cache, 'examples', 'partial.py'), 'partial');
  writeFile(path.join(cache, 'examples.zip'), 'leftover archive');
  assert.equal(isUsableExamplesCache(cache), false);
  assert.equal(await service.ensureExamples(null), offline);

  service.extractArchive = async (_archive, staging) => fs.mkdirSync(path.join(staging, 'examples'));
  assert.equal(await service.ensureExamples(route), null);
  assert.equal(fs.existsSync(path.join(cache, 'examples.zip')), true);
  assert.equal(service.activeExamplesDir(), offline);

  service.extractArchive = async (_archive, staging) => writeFile(path.join(staging, 'examples', 'full.py'), 'complete');
  assert.equal(await service.ensureExamples(route), cache);
  assert.equal(isUsableExamplesCache(cache), true);
  assert.deepEqual(fs.readdirSync(path.join(cache, 'examples')), ['full.py']);
  assert.equal(isUsableExamplesCache(offline), true);
});

test('Examples remove interrupted downloads that are older than an hour', async t => {
  const { service } = examplesFixture(t);
  const root = service.examplesRootDir();
  const stale = path.join(root, `${'a'.repeat(64)}.tmp-Ab12Cd`);
  const active = path.join(root, `${'b'.repeat(64)}.tmp-Ef34Gh`);
  const unrelated = path.join(root, 'notes.tmp-123456');
  writeFile(path.join(stale, 'examples.zip'), 'partial');
  writeFile(path.join(active, 'examples.zip'), 'in progress');
  fs.mkdirSync(unrelated);
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
  fs.utimesSync(stale, twoHoursAgo, twoHoursAgo);
  fs.utimesSync(unrelated, twoHoursAgo, twoHoursAgo);

  assert.equal(await service.ensureExamples(null), null);
  assert.deepEqual(fs.readdirSync(root).sort(), [path.basename(active), 'notes.tmp-123456']);
});

test('Examples retry publishing while Windows holds a lock', async t => {
  const { service, route, cache } = examplesFixture(t);
  const renameSync = fs.renameSync;
  let failures = 0;
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (to === cache && failures++ < 2) {
      throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
    }
    return renameSync(from, to);
  });
  service.extractArchive = async (_archive, staging) => writeFile(path.join(staging, 'models', 'a.kmodel'), 'model');

  assert.equal(await service.ensureExamples(route), cache);
  assert.equal(failures, 3);
  assert.deepEqual(fs.readdirSync(service.examplesRootDir()), [route.examplesId]);
});

test('Examples keep a cache another window published during the download', async t => {
  const { service, route, cache } = examplesFixture(t);
  service.extractArchive = async (_archive, staging) => {
    writeFile(path.join(cache, 'examples', 'main.py'), 'other window');
    writeFile(path.join(staging, 'examples', 'main.py'), 'this window');
  };

  assert.equal(await service.ensureExamples(route), cache);
  assert.equal(fs.readFileSync(path.join(cache, 'examples', 'main.py'), 'utf8'), 'other window');
  assert.deepEqual(fs.readdirSync(service.examplesRootDir()), [route.examplesId]);
});

test('Examples fall back to a legacy cache only when nothing complete is cached', async t => {
  const { service, cache, state, isUsableExamplesCache, listExamplesCaches } = examplesFixture(t);
  writeFile(path.join(cache, 'examples', 'main.py'), 'legacy');
  writeFile(path.join(cache, 'examples.zip'), 'archive the old version could not delete');
  assert.equal(isUsableExamplesCache(cache), false);

  assert.equal(await service.ensureExamples(null), cache);
  assert.equal(service.activeExamplesDir(), cache);
  assert.deepEqual(listExamplesCaches(service.examplesRootDir()).map(entry => entry.legacy), [true]);

  const complete = path.join(service.examplesRootDir(), 'c'.repeat(64));
  writeFile(path.join(complete, 'examples', 'main.py'), 'complete');
  assert.equal(service.activeExamplesDir(), complete);
  state.clear();
  assert.equal(await service.ensureExamples(null), complete);
});

test('Examples ignore folders whose name is not a canonical examples ID', async t => {
  const { service } = examplesFixture(t);
  const upper = path.join(service.examplesRootDir(), 'A'.repeat(64));
  writeFile(path.join(upper, 'examples', 'main.py'), 'example');
  assert.equal(await service.ensureExamples(null), null);
  assert.equal(service.activeExamplesDir(), '');
});

test('Examples count files reached through directory links', t => {
  const { home, isUsableExamplesCache } = fixture(t);
  const cache = path.join(home, 'cache', 'd'.repeat(64));
  const shared = path.join(home, 'shared-models');
  writeFile(path.join(shared, 'yolo.kmodel'), 'model');
  fs.mkdirSync(path.join(cache, 'models'), { recursive: true });
  fs.symlinkSync(shared, path.join(cache, 'models', 'shared'), 'junction');
  assert.equal(isUsableExamplesCache(cache), true);
});
