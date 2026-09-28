'use strict';
// Runnable checks for the wrapper. No framework, real servers, real network.
//   1. argv passthrough.
//   2. version resolution: no pin + no .version -> latest, remembered; then
//      cached runs are offline and instant.
//   3. TERMCP_VERSION pins a different release into its own dir, leaving the
//      remembered version untouched.
//   4. fastest-source selection between two local "mirrors".
//   5. resume across sources when the winner dies mid-file.
//   6. integrity: wrong bytes are rejected and never installed.
const { execFileSync, spawn } = require('node:child_process');
const http = require('node:http');
const crypto = require('node:crypto');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const assert = require('node:assert');

const WRAPPER = path.join(__dirname, '..', 'bin', 'termcp.js');
// Same default the wrapper and termcp use; TERMCP_DATA_DIR relocates both.
const HOME = (process.env.TERMCP_DATA_DIR || '').trim() || path.join(os.homedir(), '.termcp');
const VERSIONS = path.join(HOME, 'versions');
const VERSION_FILE = path.join(HOME, '.version');
const ASSET = {
  win32: { x64: 'termcp-windows-amd64.exe', arm64: 'termcp-windows-arm64.exe' },
  darwin: { x64: 'termcp-darwin-amd64', arm64: 'termcp-darwin-arm64' },
  linux: { x64: 'termcp-linux-amd64', arm64: 'termcp-linux-arm64' },
}[process.platform]?.[process.arch];
const BIN = (tag) => path.join(VERSIONS, tag, process.platform === 'win32' ? 'termcp.exe' : 'termcp');

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

// Run the wrapper, forcing a fresh download when asked.
function runWrapper(mirrors, version, timeout = 180000, extraEnv = null) {
  return new Promise((resolve) => {
    const env = Object.assign({}, process.env, { TERMCP_BIN: '', TERMCP_SKIP_DOWNLOAD: '' }, extraEnv || {});
    if (mirrors) env.TERMCP_MIRROR = mirrors.join(',');
    else delete env.TERMCP_MIRROR;
    if (version) env.TERMCP_VERSION = version;
    else delete env.TERMCP_VERSION;
    // async spawn, not spawnSync: this process may also serve the fake mirrors,
    // and spawnSync would block the event loop so their requests never answer.
    const child = spawn(process.execPath, [WRAPPER, '--version'], { env, timeout });
    let stderr = '';
    let stdout = '';
    child.stderr.on('data', (d) => { stderr += d; });
    child.stdout.on('data', (d) => { stdout += d; });
    child.on('close', (status) => resolve({ status, stderr, stdout }));
  });
}

// A fake mirror: serves `body` with Range support, at a chosen chunk delay.
// `dieAfter` drops the connection after N bytes, to exercise failover.
function mirror(body, { delayMs = 0, dieAfter = 0, tag = '' } = {}) {
  const srv = http.createServer((req, res) => {
    const m = /bytes=(\d+)-/.exec(req.headers.range || '');
    const start = m ? Number(m[1]) : 0;
    const slice = body.subarray(start);
    res.writeHead(start ? 206 : 200, {
      'content-type': 'application/octet-stream',
      'content-length': String(slice.length),
      ...(start ? { 'content-range': `bytes ${start}-${body.length - 1}/${body.length}` } : {}),
    });
    let sent = 0;
    const step = Math.max(1, Math.floor(slice.length / 8));
    const tick = () => {
      if (res.destroyed || res.writableEnded) return;
      if (dieAfter && sent >= dieAfter) { res.destroy(); return; }
      if (sent >= slice.length) { res.end(); return; }
      res.write(slice.subarray(sent, sent + step));
      sent += step;
      setTimeout(tick, delayMs);
    };
    if (delayMs || dieAfter) setTimeout(tick, delayMs); else res.end(slice);
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({ srv, url: `http://127.0.0.1:${srv.address().port}/${tag}` })));
}

(async () => {
  // 1. passthrough — installs latest if nothing is cached yet.
  {
    const out = execFileSync(process.execPath, [WRAPPER, '--version'], { encoding: 'utf8', timeout: 300000 });
    assert.match(out, /termcp v?\d/, 'termcp --version must pass through: ' + JSON.stringify(out));
    console.log('ok: --version ->', out.trim().split('\n').pop());
  }

  // 2. version resolution: whatever ran, it is the remembered one, and a second
  // run needs no network at all.
  const remembered = fs.readFileSync(VERSION_FILE, 'utf8').trim();
  const installed = fs.readFileSync(BIN(remembered));
  console.log(`ok: ~/.termcp/.version -> ${remembered} (binary installed)`);
  {
    const again = await runWrapper(null, null, 30000);
    assert.equal(again.status, 0, 'cached run must work');
    assert.match(again.stdout, /termcp v?\d/, 'cached run must still pass through');
    assert.ok(!/\[(?:probe|download)\]/.test(again.stderr), 'cached run must not download: ' + again.stderr);
    assert.match(again.stderr, /\[cache\] using installed/, 'cached run should explain the cache hit');
    console.log('ok: cached run performs no download');
  }

  // Official digest for the checked asset, straight from the API.
  const meta = await fetch(`https://api.github.com/repos/open-mcp-ai/termcp/releases/tags/${remembered}`, {
    headers: { 'User-Agent': 'termcp-npm-test' },
  }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  const official = meta && (meta.assets || []).find((a) => a.name === ASSET);
  if (!official) throw new Error('test needs the release metadata for ' + remembered);
  assert.equal(official.digest, `sha256:${sha(installed)}`, 'installed binary must be the official one');
  console.log('ok: installed binary matches the official digest from the API');

  // 3. pinning: a specific release goes to its own directory and leaves the
  // remembered version alone.
  {
    const pinnedTag = remembered === 'v0.2.2' ? 'v0.2.3' : 'v0.2.2';
    const run = await runWrapper(null, pinnedTag, 180000);
    assert.equal(run.status, 0, 'pinned install must work: ' + run.stderr);
    assert.ok(fs.existsSync(BIN(pinnedTag)), `pin must install into versions/${pinnedTag}`);
    assert.equal(fs.readFileSync(VERSION_FILE, 'utf8').trim(), remembered, 'a pin must not rewrite .version');
    console.log(`ok: TERMCP_VERSION=${pinnedTag} installed separately, .version untouched`);
  }

  const real = fs.readFileSync(BIN(remembered));

  // 4 + 5. fake mirrors serving the real release: the fast one wins, then dies
  // mid-file, and the next one must continue from the same offset. A byte-auth
  // error would surface as a checksum mismatch, so a clean install proves the
  // resume lined up.
  const dir = path.dirname(BIN(remembered));
  fs.rmSync(dir, { recursive: true, force: true });
  const fast = await mirror(real, { dieAfter: 4 * 1024 * 1024, tag: 'fast-then-dies' });
  const slow = await mirror(real, { delayMs: 150, tag: 'slow' });
  const failover = await runWrapper([fast.url, slow.url], null, 240000);
  fast.srv.close(); slow.srv.close();
  assert.equal(failover.status, 0, 'install must succeed via failover: ' + failover.stderr);
  assert.equal(sha(fs.readFileSync(BIN(remembered))), official.digest.slice(7), 'failover install must match the official digest');
  console.log('ok: fastest mirror chosen; install verifies');
  assert.match(failover.stderr, /next source/, 'the winner must die mid-file and hand over: ' + failover.stderr);
  console.log('ok: resumed on the next source after a mid-file failure');

  // 6. integrity: right length, wrong bytes -> rejected, nothing installed.
  fs.rmSync(dir, { recursive: true, force: true });
  const bad = await mirror(Buffer.alloc(real.length, 7), { tag: 'bad' });
  const badRun = await runWrapper([bad.url], null, 240000);
  bad.srv.close();
  assert.notEqual(badRun.status, 0, 'a checksum mismatch must fail, not install');
  assert.match(badRun.stderr, /checksum mismatch/, 'expected a checksum mismatch: ' + badRun.stderr);
  assert.ok(!fs.existsSync(BIN(remembered)), 'rejected download must not be installed');
  console.log('ok: checksum mismatch rejected, nothing installed');

  // 7. TERMCP_DATA_DIR relocates the cache — the same variable termcp itself
  // honours — and is created on demand.
  {
    const dir = path.join(os.tmpdir(), `termcp-test-${process.pid}`);
    fs.rmSync(dir, { recursive: true, force: true });
    const run = await runWrapper(null, null, 300000, { TERMCP_DATA_DIR: dir });
    assert.equal(run.status, 0, 'relocated data dir must work: ' + run.stderr);
    const where = path.join(dir, 'versions', remembered, process.platform === 'win32' ? 'termcp.exe' : 'termcp');
    assert.ok(fs.existsSync(where), `binary must land in ${where}`);
    assert.equal(sha(fs.readFileSync(where)), official.digest.slice(7), 'relocated binary must match the official digest');
    assert.equal(fs.readFileSync(path.join(dir, '.version'), 'utf8').trim(), remembered, 'version is remembered in the data dir');
    fs.rmSync(dir, { recursive: true, force: true });
    console.log('ok: TERMCP_DATA_DIR holds versions/ and .version');
  }

  // Restore a real install (the integrity check above leaves the cache empty) so
  // the checks below have a binary to work with.
  {
    const restore = await runWrapper(null, null, 300000);
    assert.equal(restore.status, 0, 'restore install must work: ' + restore.stderr);
    assert.equal(sha(fs.readFileSync(BIN(remembered))), official.digest.slice(7), 'restore must match the official digest');
  }

  // 8. TERMCP_SKIP_DOWNLOAD: resolves a real executable on PATH (on Windows only
  // `termcp.exe` can be spawned; npm's `termcp.cmd` shim is this wrapper itself).
  {
    const dir = path.join(os.tmpdir(), `termcp-skip-${process.pid}`);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    const exe = process.platform === 'win32' ? 'termcp.exe' : 'termcp';
    fs.copyFileSync(BIN(remembered), path.join(dir, exe));
    const run = await runWrapper(null, null, 60000, { TERMCP_SKIP_DOWNLOAD: '1', PATH: dir });
    fs.rmSync(dir, { recursive: true, force: true });
    assert.equal(run.status, 0, 'SKIP_DOWNLOAD must use the binary on PATH: ' + run.stderr);
    assert.ok(!/\[(?:probe|download)\]/.test(run.stderr), 'SKIP_DOWNLOAD must not download');
    console.log('ok: TERMCP_SKIP_DOWNLOAD uses the PATH binary, no download');
  }

  // 9. `latest` refreshes .version even when that version is already installed
  // (the early return used to skip recording it, so the next run regressed).
  {
    fs.writeFileSync(VERSION_FILE, 'v0.0.0-stale\n');
    const run = await runWrapper(null, 'latest', 300000);
    assert.equal(run.status, 0, 'latest must resolve: ' + run.stderr);
    const after = fs.readFileSync(VERSION_FILE, 'utf8').trim();
    assert.notEqual(after, 'v0.0.0-stale', 'latest must rewrite .version');
    assert.equal(after, remembered, 'latest must record the resolved release');
    console.log(`ok: TERMCP_VERSION=latest recorded ${after} in .version`);
  }

  // 10. Offline with an installed version: stays on it instead of failing.
  {
    const run = await runWrapper(null, 'latest', 120000, {
      NODE_USE_ENV_PROXY: '1',
      HTTPS_PROXY: 'http://127.0.0.1:9', // nothing listens here
    });
    assert.equal(run.status, 0, 'offline must fall back to an installed version: ' + run.stderr);
    assert.match(run.stderr, /GitHub unreachable, staying on/, 'expected the offline notice: ' + run.stderr);
    assert.ok(!/all \d+ sources failed/.test(run.stderr), 'offline must not try to download');
    console.log('ok: offline run stays on the installed version');
  }

  // Restore a real install so the next run is cheap.
  fs.writeFileSync(VERSION_FILE, remembered + '\n');
  console.log('all checks passed');
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
