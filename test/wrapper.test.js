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

// The version the wrapper would run right now, and a different release the suite
// has already installed. Both are read at use time: the newest release on GitHub
// is not necessarily the one cached on this machine, and that stops being true
// the day a newer one is published.
const currentTag = () => fs.readFileSync(VERSION_FILE, 'utf8').trim();
const otherTag = (tag) => (tag === 'v0.2.2' ? 'v0.2.3' : 'v0.2.2');

// A direct GitHub API call that degrades to null when the hourly rate limit
// (60/h, and this suite + the wrapper's own resolves share it) is exhausted.
// Those calls are all assertions or installs of releases this run does not
// strictly need, and turning a rate limit into a red suite trains people to
// ignore red suites.
async function apiJSON(path, opts) {
  const res = await fetch(`https://api.github.com/repos/open-mcp-ai/termcp/${path}`, Object.assign({
    headers: { 'User-Agent': 'termcp-npm-test' },
  }, opts || {})).catch(() => null);
  if (!res) return { rateLimited: false, body: null };
  if (res.status === 403 || res.status === 429) return { rateLimited: true, body: null };
  return { rateLimited: false, body: res.ok ? await res.json() : null };
}

// The official sha256 for one tag's asset, straight from the API.
async function officialDigest(tag) {
  const { body } = await apiJSON(`releases/tags/${tag}`);
  const asset = body && (body.assets || []).find((a) => a.name === ASSET);
  if (!asset) throw new Error('test needs the release metadata for ' + tag);
  return asset.digest.slice(7);
}

// Is `tag` a real published release? Unknown (null) when the rate limit is out.
async function isPublished(tag) {
  const { rateLimited, body } = await apiJSON(`releases/tags/${tag}`);
  if (rateLimited) return null;
  return !!(body && body.tag_name);
}

// Run the wrapper, forcing a fresh download when asked.
function runWrapper(mirrors, version, timeout = 180000, extraEnv = null, args = ['--version']) {
  return new Promise((resolve) => {
    const env = Object.assign({}, process.env, { TERMCP_BIN: '', TERMCP_SKIP_DOWNLOAD: '' }, extraEnv || {});
    if (mirrors) env.TERMCP_MIRROR = mirrors.join(',');
    else delete env.TERMCP_MIRROR;
    if (version) env.TERMCP_VERSION = version;
    else delete env.TERMCP_VERSION;
    // async spawn, not spawnSync: this process may also serve the fake mirrors,
    // and spawnSync would block the event loop so their requests never answer.
    const child = spawn(process.execPath, [WRAPPER].concat(args), { env, timeout });
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

// A fake releases API: the channel tests need tags and an ordering GitHub does
// not have (a hotfix on an older line published after a newer rc, rc.10 next to
// rc.4), and they must not depend on what has been published this morning.
// `releases/latest` is answered from the same list, stable-only, as GitHub does.
function releasesAPI(getReleases) {
  const srv = http.createServer((req, res) => {
    const send = (obj, code = 200) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    const pathname = new URL(req.url, 'http://127.0.0.1').pathname.replace(/^\/repos\/open-mcp-ai\/termcp\//, '');
    const releases = getReleases();
    if (pathname.startsWith('releases/tags/')) {
      const tag = decodeURIComponent(pathname.slice('releases/tags/'.length));
      const found = releases.find((r) => r.tag_name === tag);
      return found ? send(found) : send({ message: 'Not Found' }, 404);
    }
    if (pathname === 'releases/latest') {
      const stable = releases.filter((r) => !r.prerelease);
      return stable.length ? send(stable[0]) : send({ message: 'Not Found' }, 404);
    }
    if (pathname === 'releases') return send(releases);
    return send({ message: 'Not Found' }, 404);
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({ srv, url: `http://127.0.0.1:${srv.address().port}` })));
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
  const { body: meta } = await apiJSON(`releases/tags/${remembered}`);
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
    // A fresh data dir has no remembered version, so it resolves the newest
    // release - which is not necessarily the one cached in the default dir.
    const fresh = fs.readFileSync(path.join(dir, '.version'), 'utf8').trim();
    const where = path.join(dir, 'versions', fresh, process.platform === 'win32' ? 'termcp.exe' : 'termcp');
    assert.ok(fs.existsSync(where), `binary must land in ${where}`);
    assert.equal(sha(fs.readFileSync(where)), await officialDigest(fresh), 'relocated binary must match the official digest');
    assert.ok(await isPublished(fresh) !== false, `the resolved tag ${fresh} must be a published release`);
    fs.rmSync(dir, { recursive: true, force: true });
    console.log(`ok: TERMCP_DATA_DIR holds versions/ and .version (${fresh})`);
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
    // A remembered version on the stable line: `latest` must re-resolve it even
    // though something is already installed. The value is a plain version because
    // that is what decides which line `latest` means.
    fs.writeFileSync(VERSION_FILE, 'v0.0.0\n');
    const run = await runWrapper(null, 'latest', 300000);
    assert.equal(run.status, 0, 'latest must resolve: ' + run.stderr);
    const after = currentTag();
    assert.notEqual(after, 'v0.0.0', 'latest must rewrite .version');
    assert.ok(fs.existsSync(BIN(after)), `latest must leave ${after} installed`);
    const check = await runWrapper(null, null, 60000);
    assert.match(check.stdout, new RegExp(after), 'the recorded version must be the one that runs');
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

  // 11. Channels: `use --channel rc|nightly` resolves the newest release on that
  // line, records the tag in .version. Nothing else is written: the tag says which
  // line it is on.
  // Runs against a fake API and mirror, so the answer cannot change the day
  // GitHub publishes something, and no bandwidth is spent proving a comparison.
  {
    const dir = path.join(os.tmpdir(), `termcp-channel-${process.pid}`);
    fs.rmSync(dir, { recursive: true, force: true });
    const body = Buffer.from('termcp fake release\n'.repeat(64));
    const rel = (tag, prerelease = false) => ({
      tag_name: tag,
      draft: false,
      prerelease,
      assets: [{ name: ASSET, size: body.length, digest: `sha256:${sha(body)}` }],
    });
    // Newest-first, the way GitHub orders by creation: a hotfix on the older line
    // sits on top, and rc.10 sorts below rc.4 as a string. Taking the first entry
    // would install v9.0.1-rc.9; the newest by version is v9.0.2-rc.10.
    let releases = [rel('v9.0.1-rc.9', true), rel('v9.0.2-rc.4', true), rel('v9.0.2-rc.10', true)];
    const api = await releasesAPI(() => releases);
    const asset = await mirror(body, { tag: 'fake' });
    const env = { TERMCP_DATA_DIR: dir, TERMCP_API: api.url };
    const run = (args) => runWrapper([asset.url], null, 60000, env, args);
    const version = () => fs.readFileSync(path.join(dir, '.version'), 'utf8').trim();
    const channelFile = () => path.join(dir, 'channel');
    const installedAt = (tag) => path.join(dir, 'versions', tag, process.platform === 'win32' ? 'termcp.exe' : 'termcp');

    const rc = await run(['use', '--channel', 'rc']);
    assert.equal(rc.status, 0, 'use --channel rc must work: ' + rc.stderr);
    assert.equal(version(), 'v9.0.2-rc.10', 'rc must take the newest rc, not the first in the list');
    // Nothing records the channel: the tag in .version says which line it is on,
    // and a second file could only disagree with it.
    assert.ok(!fs.existsSync(channelFile()), '--channel must not be recorded anywhere');
    assert.ok(fs.existsSync(installedAt('v9.0.2-rc.10')), 'the resolved rc must be installed');
    assert.match(rc.stdout, /ready at .*v9\.0\.2-rc\.10/, 'use must report what it switched to: ' + rc.stdout);
    // The binary's own --version prints "… (commit …) built …"; the installer
    // must print its own report and exit without ever spawning it.
    assert.ok(!/built \d/.test(rc.stdout), 'use must not start the binary: ' + rc.stdout);
    console.log('ok: `use --channel rc` took v9.0.2-rc.10 from a list ordered against it');

    // A final outranks its own rcs, and `latest` stays on the line it is already
    // on: that is what "latest" means without --channel.
    releases = [rel('v9.0.2-rc.10', true), rel('v9.0.2')];
    const final = await run(['use', 'latest']);
    assert.equal(final.status, 0, 'use latest must work: ' + final.stderr);
    assert.equal(version(), 'v9.0.2', 'the final must outrank its own rcs');

    // nightly is a dated tag, so it is ordered as a string, because YYYYMMDD is
    // one.
    releases = [rel('nightly-20261001', true), rel('nightly-20261002', true), rel('v9.0.2')];
    const nightly = await run(['use', '--channel=nightly']);
    assert.equal(nightly.status, 0, 'the nightly channel must work: ' + nightly.stderr);
    assert.equal(version(), 'nightly-20261002', 'nightly must take the newest dated tag');
    assert.ok(!fs.existsSync(channelFile()), 'the --channel= spelling records nothing either');

    // `latest` advances along the line .version is on, which is nightly here.
    const onwardNightly = await run(['use', 'latest']);
    assert.equal(onwardNightly.status, 0, 'use latest must advance on the nightly line: ' + onwardNightly.stderr);
    assert.equal(version(), 'nightly-20261002');

    // `use <tag>` is the way down, and it says nothing about a line: the tag does.
    // v9.0.1 is in the list as the final of the rc being left behind, and the
    // newer v9.0.2-rc.10 must still win: the line answers with its newest.
    releases = [rel('nightly-20261002', true), rel('v9.0.2-rc.10', true), rel('v9.0.1-rc.9', true), rel('v9.0.1')];
    const down = await run(['use', 'v9.0.1-rc.9']);
    assert.equal(down.status, 0, 'use <tag> must work: ' + down.stderr);
    assert.equal(version(), 'v9.0.1-rc.9', 'use <tag> must record exactly that tag');
    assert.match(down.stdout, /\(channel rc\)/, 'an rc tag is on the rc line: ' + down.stdout);
    const onward = await run(['use', 'latest']);
    assert.equal(onward.status, 0, 'use latest must work after a downgrade: ' + onward.stderr);
    assert.equal(version(), 'v9.0.2-rc.10', 'the rc line answers with its newest, and its finals are candidates');

    const cached = await run(['use', 'v9.0.1-rc.9']);
    assert.equal(cached.status, 0, 'a tag already on disk must switch: ' + cached.stderr);
    assert.ok(!/\[(?:probe|download)\]/.test(cached.stderr), 'a cached tag must not download: ' + cached.stderr);
    console.log('ok: `use <tag>` is the way down, and a cached tag switches offline');

    // `update` is gone: the binary's own parser would answer it with a directive
    // error nobody can act on, so the wrapper points at the word that means it.
    const deadUpdate = await run(['update']);
    assert.notEqual(deadUpdate.status, 0, 'update must be refused');
    assert.match(deadUpdate.stderr, /use `termcp use latest`/, 'expected the pointer: ' + deadUpdate.stderr);
    console.log('ok: `update` refused, pointing at `use latest`');

    // Refusals: a channel nobody published, a release nobody published,
    // and --channel outside the one command that reads it.
    const bare = await run(['use']);
    assert.equal(bare.status, 0, 'bare use must report instead of failing: ' + bare.stderr);
    assert.match(bare.stdout, new RegExp(version()), 'bare use must name the current version: ' + bare.stdout);
    assert.match(bare.stdout, /\(channel rc\)/, 'bare use must name the line too: ' + bare.stdout);
    assert.match(bare.stdout, /usage: termcp use/, 'bare use must show how to move: ' + bare.stdout);
    assert.ok(!/\[(?:probe|download)\]/.test(bare.stderr), 'bare use must not touch the network: ' + bare.stderr);
    console.log('ok: bare `use` reports the version and the usage, without a request');
    // A channel you invented has nothing on it, and the error lists what is.
    const custom = await run(['use', '--channel', 'preview']);
    assert.notEqual(custom.status, 0, 'an empty channel must be refused');
    assert.match(custom.stderr, /no release is published on the preview channel/, 'must name the channel: ' + custom.stderr);
    assert.match(custom.stderr, /published lines: nightly, rc, stable/, 'must list the published lines: ' + custom.stderr);
    console.log('ok: a channel is simply a line of tags; an unpopulated one is refused with published lines');
    const missing = await run(['use', 'v9.9.9']);
    assert.notEqual(missing.status, 0, 'a release nobody published must fail');
    assert.match(missing.stderr, /no such release/, 'expected a 404 to say so: ' + missing.stderr);
    const stray = await run(['--channel', 'rc']);
    assert.notEqual(stray.status, 0, '--channel without the verb must be refused');
    assert.match(stray.stderr, /only applies to/, 'expected the pointer to `use`: ' + stray.stderr);
    releases = [rel('v9.0.2')];
    const empty = await run(['use', '--channel', 'nightly']);
    assert.notEqual(empty.status, 0, 'a channel with nothing on it must fail');
    assert.match(empty.stderr, /no release is published on the nightly channel/, 'expected a clear message: ' + empty.stderr);
    console.log('ok: missing channel, missing release and stray flag all refused');

    api.srv.close();
  // 12. No digest, no install. A mirror is the party that could hand over
  // something else, so bytes that cannot be checked against the official digest
  // are refused rather than installed on trust. This used to warn and install.
  {
    const dir = path.join(os.tmpdir(), `termcp-nodigest-${process.pid}`);
    fs.rmSync(dir, { recursive: true, force: true });
    const body = Buffer.from('unverifiable bytes\n'.repeat(64));
    const undigested = {
      tag_name: 'v9.9.0',
      draft: false,
      prerelease: false,
      assets: [{ name: ASSET, size: body.length }], // no digest published
    };
    const api = await releasesAPI(() => [undigested]);
    const asset = await mirror(body, { tag: 'undigested' });
    const run = await runWrapper([asset.url], null, 60000, { TERMCP_DATA_DIR: dir, TERMCP_API: api.url }, ['use', 'v9.9.0']);
    assert.notEqual(run.status, 0, 'an unverifiable release must not install');
    assert.match(run.stderr, /no SHA-256 digest is published/, 'expected the refusal: ' + run.stderr);
    assert.ok(!fs.existsSync(path.join(dir, 'versions', 'v9.9.0')), 'nothing may be installed');
    assert.ok(!fs.existsSync(path.join(dir, '.version')), 'and nothing may be recorded');

    // TERMCP_SKIP_VERIFY is the escape hatch: it downloads and installs anyway,
    // only checking length.
    const bypassed = await runWrapper([asset.url], null, 60000, {
      TERMCP_DATA_DIR: dir, TERMCP_API: api.url, TERMCP_SKIP_VERIFY: '1',
    }, ['use', 'v9.9.0']);
    assert.equal(bypassed.status, 0, 'SKIP_VERIFY must install unchecked: ' + bypassed.stderr);
    assert.ok(fs.existsSync(path.join(dir, 'versions', 'v9.9.0')), 'the unchecked binary must land in place');
    assert.equal(fs.readFileSync(path.join(dir, '.version'), 'utf8').trim(), 'v9.9.0');
    console.log('ok: TERMCP_SKIP_VERIFY allows the install through unchecked');

    api.srv.close();
    asset.srv.close();
    fs.rmSync(dir, { recursive: true, force: true });
    console.log('ok: a release with no published digest is refused, not installed');
  }

    asset.srv.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // Restore a real install so the next run is cheap.
  fs.writeFileSync(VERSION_FILE, remembered + '\n');
  console.log('all checks passed');
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
