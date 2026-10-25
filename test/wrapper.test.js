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

// What is on disk under versions/, the way the wrapper sees it.
function installedTagsIn(dir) {
  try { return fs.readdirSync(path.join(dir, 'versions')).sort(); } catch { return []; }
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
    // A spawn that never started is not a run that said nothing. Without this the
    // failure arrives as `status: null` with an empty stderr, and every assertion
    // message ends in a bare colon — which is how "the machine was out of process
    // slots" spent an afternoon looking like a wrapper bug.
    child.on('error', (e) => { stderr += `spawn failed: ${(e && e.message) || e}\n`; });
    // The signal too: killed by the timeout and exited non-zero are different
    // facts, and `status` is null for both.
    child.on('close', (status, signal) => resolve({ status, signal, stderr, stdout }));
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

// A minimal MCP client: newline-delimited frames out, replies matched by id. A
// line that is not a reply is collected as stray — stdout is the protocol, and
// anything else on it is a bug.
function mcpClient(dir, env = {}, args = ['use', '--mcp']) {
  const child = spawn(process.execPath, [WRAPPER].concat(args), {
    env: Object.assign({}, process.env, { TERMCP_DATA_DIR: dir, TERMCP_BIN: '', TERMCP_SKIP_DOWNLOAD: '' }, env),
  });
  const waiting = new Map();
  const stray = [];
  let buffer = '';
  let id = 0;
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d; });
  // Same reason as runWrapper's: a server that never started would otherwise show
  // up only as every request timing out, with the reason nowhere.
  child.on('error', (e) => { stderr += `spawn failed: ${(e && e.message) || e}\n`; });
  child.stdout.on('data', (d) => {
    buffer += d;
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (!line.trim()) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { stray.push(line); continue; }
      if (msg.id != null && waiting.has(msg.id)) {
        const done = waiting.get(msg.id);
        waiting.delete(msg.id);
        done(msg);
      } else {
        stray.push(line);
      }
    }
  });
  const send = (msg) => child.stdin.write(JSON.stringify(msg) + '\n');
  const request = (method, params) => new Promise((resolve, reject) => {
    const mine = ++id;
    waiting.set(mine, resolve);
    send({ jsonrpc: '2.0', id: mine, method, params });
    setTimeout(() => { if (waiting.delete(mine)) reject(new Error(`no reply to ${method}; stderr: ${stderr}`)); }, 60000);
  });
  return {
    request,
    notify: (method, params) => send({ jsonrpc: '2.0', method, params }),
    stray,
    stderr: () => stderr,
    close: () => new Promise((r) => { child.stdin.end(); child.on('close', (code) => r(code)); }),
  };
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
  // Nothing temporary survives. A probe file that produced no bytes used to stay
  // behind: dropping the losers compared URLs, and the winner is never its own
  // loser — so the one file that had to be deleted by name was the one kept.
  const leftovers = fs.readdirSync(dir).filter((f) => f.includes('.part'));
  assert.deepEqual(leftovers, [], 'no .part or .probe file may be left behind: ' + leftovers.join(', '));
  console.log('ok: resumed on the next source after a mid-file failure, leaving nothing behind');

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
    const channelFile = path.join(dir, '.check', 'channel');
    const installedAt = (tag) => path.join(dir, 'versions', tag, process.platform === 'win32' ? 'termcp.exe' : 'termcp');

    // A file that names lines is a scope for `--check`, not a permission: it is
    // what a check reports on when it is not told, and nothing is refused because
    // of it. Writing it the way a person would, because it is just a preference.
    fs.mkdirSync(path.dirname(channelFile), { recursive: true });
    const allowlist = ['# lines a check looks at when it is not told', 'rc', 'nightly', 'preview', ''].join(String.fromCharCode(10));
    fs.writeFileSync(channelFile, allowlist);

    const rc = await run(['use', '--channel', 'rc']);
    assert.equal(rc.status, 0, 'use --channel rc must work: ' + rc.stderr);
    assert.equal(version(), 'v9.0.2-rc.10', 'rc must take the newest rc, not the first in the list');
    // Nothing records the channel: the tag in .version says which line it is on,
    // and a second file could only disagree with it.
    assert.equal(fs.readFileSync(channelFile, 'utf8'), allowlist, '--channel must not rewrite the allowlist');
    assert.match(rc.stdout, /selected \(channel rc\)/, 'use must report what it selected: ' + rc.stdout);
    // Selecting is not installing: `.version` is one line, and the bytes belong to
    // the launch that needs them. A `use` that fetched thirteen megabytes would be
    // doing the launch's job, and it would make an offline switch impossible.
    assert.ok(!fs.existsSync(installedAt('v9.0.2-rc.10')), 'use must not install: ' + rc.stdout);
    assert.match(rc.stdout, /not on disk yet; the next launch installs it/, 'and must say so: ' + rc.stdout);
    assert.ok(!/\[(?:probe|download|install)\]/.test(rc.stderr), 'use must not fetch bytes: ' + rc.stderr);
    // The binary's own --version prints "… (commit …) built …"; selecting must
    // print its own report and exit without ever spawning it.
    assert.ok(!/built \d/.test(rc.stdout), 'use must not start the binary: ' + rc.stdout);
    console.log('ok: `use --channel rc` selected v9.0.2-rc.10 from a list ordered against it, without fetching it');

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
    assert.equal(fs.readFileSync(channelFile, 'utf8'), allowlist, 'the --channel= spelling rewrites nothing either');

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

    // A tag costs one API call to check it exists — a typo should not wait for a
    // launch to be noticed — and no bytes at all.
    const cached = await run(['use', 'v9.0.1-rc.9']);
    assert.equal(cached.status, 0, 'a tag must switch: ' + cached.stderr);
    assert.ok(!/\[(?:probe|download|install)\]/.test(cached.stderr), 'selecting a tag must fetch no bytes: ' + cached.stderr);
    // A tag nobody published is caught here, not at the next launch.
    const typo = await run(['use', 'v9.9.9']);
    assert.notEqual(typo.status, 0, 'a tag that does not exist must be refused: ' + typo.stdout);
    assert.match(typo.stderr, /no such release/, 'expected the 404 to say so: ' + typo.stderr);
    assert.equal(version(), 'v9.0.1-rc.9', 'and must not have been recorded');
    console.log('ok: `use <tag>` is the way down, and selecting one fetches nothing');

    // Only `use` is the wrapper's word. Everything else reaches the binary exactly
    // as typed — including a word the binary does not know, which is the binary's
    // to refuse and not this layer's to reinterpret. `update` is the case that
    // matters: it used to be answered here with a pointer, and a pointer is still
    // this layer answering a question it does not own.
    const notOurs = await run(['update']);
    assert.match(notOurs.stderr, /starting termcp/, 'a word that is not `use` must be forwarded: ' + notOurs.stderr);
    assert.ok(!/not a command|unknown command|use `termcp/.test(notOurs.stderr), 'the wrapper must not answer for the binary: ' + notOurs.stderr);
    console.log('ok: a word that is not `use` is forwarded to the binary, not answered here');

    // Nothing is refused for being absent from the file: it is a scope for
    // `--check`, not a permission, so a line it does not name switches like any
    // other.
    releases = [rel('v9.0.3-beta.1', true)];
    const offScope = await run(['use', '--channel', 'beta']);
    assert.equal(offScope.status, 0, 'a line outside the file must still switch: ' + offScope.stderr);
    assert.equal(version(), 'v9.0.3-beta.1', 'and must land on that line');
    assert.equal(fs.readFileSync(channelFile, 'utf8'), allowlist, 'and must not rewrite the file');
    // Several lines at once is not an ambiguous question, it is a wider net: a
    // switch lands on one release either way, so `--channel rc,nightly` takes the
    // newest of them. This is the only place a tag from one line is compared with
    // a tag from another, and the list is already in publication order — so the
    // answer is whichever published last, not whichever sorts higher.
    releases = [rel('nightly-20261002', true), rel('v9.0.2-rc.10', true), rel('v9.0.1-rc.9', true)];
    const twoLines = await run(['use', '--channel', 'rc,nightly']);
    assert.equal(twoLines.status, 0, 'two lines must be a wider net, not a refusal: ' + twoLines.stderr);
    assert.equal(version(), 'nightly-20261002', 'and the newest of them must win: ' + twoLines.stdout);
    assert.match(twoLines.stdout, /\(channel rc or nightly\)/, 'and the report must say which lines it chose from: ' + twoLines.stdout);
    // Order in the list is publication order, so flipping it flips the answer.
    releases = [rel('v9.0.2-rc.10', true), rel('nightly-20261002', true), rel('v9.0.1-rc.9', true)];
    const otherWay = await run(['use', '--channel', 'rc,nightly']);
    assert.equal(otherWay.status, 0, 'and must work the other way round: ' + otherWay.stderr);
    assert.equal(version(), 'v9.0.2-rc.10', 'the one published last must win: ' + otherWay.stdout);
    // Naming a tag is the same story, and always was: it says which line it is on.
    // Put the selection back on the rc line — the rest of the block asserts about it.
    releases = [rel('v9.0.1-rc.9', true), rel('v9.0.2-rc.4', true), rel('v9.0.2-rc.10', true)];
    const back = await run(['use', 'v9.0.2-rc.10']);
    assert.equal(back.status, 0, 'the selection must go back: ' + back.stderr);
    console.log('ok: the channel file is a check scope, not a permission; several lines mean the newest');

    // Refusals: a channel nobody published, a release nobody published,
    // and --channel outside the one command that reads it.
    const bare = await run(['use']);
    assert.equal(bare.status, 0, 'bare use must report instead of failing: ' + bare.stderr);
    assert.match(bare.stdout, new RegExp('current: ' + version()), 'bare use must name the current version: ' + bare.stdout);
    assert.match(bare.stdout, /\(channel rc\)/, 'bare use must name the line too: ' + bare.stdout);
    assert.match(bare.stdout, /checking: rc, nightly, preview/, 'and the lines a check reports on: ' + bare.stdout);
    assert.ok(!/\[(?:probe|download)\]/.test(bare.stderr), 'bare use must not touch the network: ' + bare.stderr);
    console.log('ok: bare `use` reports the version and the usage, without a request');
    // A channel you invented has nothing on it, and the error lists what is.
    releases = [rel('v9.0.2'), rel('v9.0.1-rc.9', true), rel('nightly-20261002', true)];
    const custom = await run(['use', '--channel', 'preview']);
    assert.notEqual(custom.status, 0, 'an empty channel must be refused');
    assert.match(custom.stderr, /no release is published on the preview channel/, 'must name the channel: ' + custom.stderr);
    assert.match(custom.stderr, /published lines: nightly, rc, stable/, 'must list the published lines: ' + custom.stderr);
    console.log('ok: a channel is simply a line of tags; an unpopulated one is refused with published lines');
    const missing = await run(['use', 'v9.9.9']);
    assert.notEqual(missing.status, 0, 'a release nobody published must fail');
    assert.match(missing.stderr, /no such release/, 'expected a 404 to say so: ' + missing.stderr);
    // A flag with no value is not the empty line. It used to be: `use --channel`
    // then resolved the line already in use and installed it, answering a
    // question nobody asked, and `list --channel` listed every line.
    for (const args of [['use', '--channel'], ['use', '--list', '--channel'], ['use', '--list', '--channel='], ['use', '--channel=']]) {
      const bare = await run(args);
      assert.notEqual(bare.status, 0, `${args.join(' ')} must be refused: ` + bare.stdout);
      assert.match(bare.stderr, /--channel needs a line name/, 'expected the value to be required: ' + bare.stderr);
    }
    // A tag already names its line, so --channel beside one is refused rather
    // than echoed back as if it had been applied.
    const before = version();
    const both = await run(['use', 'v9.0.2', '--channel', 'rc']);
    assert.notEqual(both.status, 0, 'a tag and --channel together must be refused');
    assert.match(both.stderr, /--channel applies to `use latest`, not to v9\.0\.2/, 'expected the reason: ' + both.stderr);
    assert.equal(version(), before, 'and it must not have switched anything');
    // Two versions, or two lines, is a question with no single answer.
    const twoTags = await run(['use', 'v9.0.2', 'v9.0.1']);
    assert.notEqual(twoTags.status, 0, 'two versions must be refused');
    assert.match(twoTags.stderr, /use takes one version, not v9\.0\.1/, 'expected the extra named: ' + twoTags.stderr);
    releases = [rel('v9.0.2')];
    const empty = await run(['use', '--channel', 'nightly']);
    assert.notEqual(empty.status, 0, 'a channel with nothing on it must fail');
    assert.match(empty.stderr, /no release is published on the nightly channel/, 'expected a clear message: ' + empty.stderr);
    console.log('ok: missing channel, missing release and stray flag all refused');

    // The command line carries the same one word the tool does, so the listing is
    // reachable here too. .version is on the rc line, so that is the line it marks.
    releases = [rel('v9.0.2'), rel('v9.0.3-rc.1', true)];
    const listed = await run(['use', '--list']);
    assert.equal(listed.status, 0, 'list must work from the command line: ' + listed.stderr);
    assert.match(listed.stdout, /stable\s+v9\.0\.2/, 'list must name each line: ' + listed.stdout);
    assert.match(listed.stdout, /rc\s+v9\.0\.3-rc\.1\s+<- current line/, 'list must mark the line .version is on: ' + listed.stdout);
    assert.ok(!/\[probe\]|\[download\]/.test(listed.stderr), 'list must never download: ' + listed.stderr);
    // `kill` is the binary's `daemon stop`, and only `use` reads --channel: a
    // stray flag is refused before anything is spawned.
    // A mode owns its arguments: `--kill` forwards them to `daemon stop`, and
    // `--channel` is not one of those.
    const strayKill = await run(['use', '--kill', '--channel', 'rc']);
    assert.notEqual(strayKill.status, 0, '--kill must refuse --channel');
    assert.match(strayKill.stderr, /`--channel` only applies to `use`, `use --list` and `use --check`/, 'expected a refusal: ' + strayKill.stderr);
    // MCP mode takes no release: the version is named inside the tool call.
    const strayMcp = await run(['use', '--mcp', 'v9.0.1']);
    assert.notEqual(strayMcp.status, 0, '--mcp must refuse a release argument');
    assert.match(strayMcp.stderr, /takes --checkupdate and nothing else/, 'expected the refusal: ' + strayMcp.stderr);
    console.log('ok: `list` runs from the command line, and stray flags are refused');

    // `check` is the MCP tool's alone: at a shell `list` already shows every line's
    // newest, so the word is answered rather than forwarded to the binary.
    // `--check` is an option of `use` like any other, so it answers at a shell too:
    // a door-specific option would be the kind of special case this shape exists to
    // remove. `--checkupdate` is the MCP-only half, because it is a standing order
    // to a client rather than a question anyone can ask at a prompt.
    const cliCheck = await run(['use', '--check']);
    assert.equal(cliCheck.status, 0, '--check must answer here too: ' + cliCheck.stderr);
    assert.match(cliCheck.stdout, /<- current line/, 'and mark the line in use: ' + cliCheck.stdout);
    const strayFlag = await run(['use', '--checkupdate']);
    assert.notEqual(strayFlag.status, 0, '--checkupdate without --mcp must be refused');
    assert.match(strayFlag.stderr, /only applies to `use --mcp`/, 'expected the pointer: ' + strayFlag.stderr);
    // Two modes on one line is two requests, and there is no rule for combining
    // them — so it is refused rather than resolved by precedence.
    const twoModes = await run(['use', '--list', '--check']);
    assert.notEqual(twoModes.status, 0, 'two options must be refused');
    assert.match(twoModes.stderr, /are two different requests/, 'expected the reason: ' + twoModes.stderr);
    console.log('ok: `--check` answers on both doors; `--checkupdate` is `--mcp` only');

    // Several lines at once is the point of `--check`: watching rc and nightly is
    // one question, not two. Only the line you are standing on gets a verdict — the
    // others get a newest tag, because comparing a tag on one line with a tag on
    // another compares two unrelated names. This runs after the `--list` block
    // because a check writes the release-list cache, and that block is about what
    // the list says when it is fetched fresh.
    releases = [rel('v9.0.2'), rel('v9.0.3-rc.1', true), rel('nightly-20261002', true)];
    const watching = await run(['use', '--check', '--force', '--channel', 'rc,nightly']);
    assert.equal(watching.status, 0, '--check must take several lines: ' + watching.stderr);
    assert.match(watching.stdout, /rc\s+.*<- current line/, 'expected the line in use marked: ' + watching.stdout);
    assert.match(watching.stdout, /nightly\s+newest: nightly-20261002/, 'expected the other line reported: ' + watching.stdout);
    assert.ok(!/nightly\s+(up to date|newer:)/.test(watching.stdout), 'a line nobody is on must not be judged: ' + watching.stdout);
    console.log('ok: `--check` takes several lines, and only the one in use is judged');

    // Nothing on the `use` surface fetches a byte. Selecting, listing, checking,
    // tuning, pointing and stopping are all things a launch does not need — the
    // bytes belong to the launch — and this walks the whole surface, because the
    // one that did fetch (`--kill`, through the launcher's resolver) was found by
    // accident rather than by looking.
    {
      const clean = path.join(dir, 'nothing-downloads');
      fs.mkdirSync(clean, { recursive: true });
      fs.writeFileSync(path.join(clean, '.version'), 'v9.0.2');
      const still = Object.assign({}, env, { TERMCP_DATA_DIR: clean });
      for (const args of [
        ['use'], ['use', 'v9.0.2'], ['use', 'latest'], ['use', '--channel', 'rc'],
        ['use', '--channel', 'rc,nightly'], ['use', '--list'], ['use', '--list', '--channel', 'rc'],
        ['use', '--check'], ['use', '--check', '--force'], ['use', '--check', '--channel', 'rc'],
        ['use', '--delay'], ['use', '--delay', '6h'], ['use', '--delay', 'default'],
        ['use', '--bin'], ['use', '--bin', 'off'], ['use', '--rm', 'v9.9.9'], ['use', '--kill'],
      ]) {
        const r = await runWrapper([asset.url], null, 60000, still, args);
        assert.ok(!/\[(?:probe|download|install)\]/.test(r.stderr), `${args.join(' ')} must not fetch: ` + r.stderr);
        assert.ok(!fs.existsSync(path.join(clean, 'versions')), `${args.join(' ')} must not install anything: ` + r.stderr);
      }
      fs.rmSync(clean, { recursive: true, force: true });
    }
    console.log('ok: nothing on the `use` surface downloads — the bytes belong to the launch');

    // `--rm` deletes one installed release and refuses the one .version names: that
    // would leave the record pointing at a binary that is not there. Selecting a
    // release no longer installs it, so the releases are put here the way a launch
    // would have put them: the download is the launch's job now.
    const installedAt2 = (t) => path.join(dir, 'versions', t);
    for (const t of ['v9.0.2', 'v9.0.2-rc.10']) {
      fs.mkdirSync(path.dirname(installedAt(t)), { recursive: true });
      fs.writeFileSync(installedAt(t), '');
    }
    const selected = version();
    const dropSelected = await run(['use', '--rm', selected]);
    assert.notEqual(dropSelected.status, 0, 'the selected version must not be removable');
    assert.match(dropSelected.stderr, /is the selected version/, 'expected the refusal: ' + dropSelected.stderr);
    assert.ok(fs.existsSync(installedAt2(selected)), 'a refused --rm must delete nothing');
    const dropMissing = await run(['use', '--rm', 'v9.9.9']);
    assert.notEqual(dropMissing.status, 0, 'an uninstalled tag must be refused');
    assert.match(dropMissing.stderr, /is not installed/, 'expected the refusal: ' + dropMissing.stderr);
    const spare = installedTagsIn(dir).find((t) => t !== selected);
    assert.ok(spare, 'the block must have left a second release installed');
    const dropped = await run(['use', '--rm', spare]);
    assert.equal(dropped.status, 0, '--rm must work: ' + dropped.stderr);
    assert.ok(!fs.existsSync(installedAt2(spare)), '--rm must delete the directory');
    assert.ok(dropped.stdout.includes('removed ' + spare), '--rm must say what it removed: ' + dropped.stdout);
    console.log('ok: `--rm` deletes an unselected version and refuses the selected one');

    // `bin` points every launch at a command instead of a release — a local build,
    // a wrapper script — and keeps its arguments. A developer building termcp
    // itself is the case this exists for, so it is checked by launching something
    // that reports the argv it was handed.
    const devBuild = path.join(dir, 'dev-build.js');
    fs.writeFileSync(devBuild, 'console.log("DEV-BUILD-ARGV " + JSON.stringify(process.argv.slice(2)));');
    const set = await run(['use', '--bin', process.execPath, devBuild]);
    assert.equal(set.status, 0, '--bin must work: ' + set.stderr);
    // Stored with quotes where a word has a space in it: this machine's node is
    // under "Program Files", and an unquoted store would read back as `C:\Program`.
    const stored = fs.readFileSync(path.join(dir, '.bin'), 'utf8').trim();
    assert.ok(stored.includes(devBuild), 'the command must be remembered: ' + stored);
    assert.ok(!stored.startsWith('"') || stored.includes('" '), 'a quoted word must be closed: ' + stored);
    assert.match(set.stdout, /launching: .*dev-build\.js \(from \.bin\)/, '--bin must report it: ' + set.stdout);
    // status answers "what would run", and now that is not the selected release.
    const withBin = await run(['use']);
    assert.match(withBin.stdout, /launching: .*dev-build\.js \(.bin; no release is used\)/, 'status must not claim a release runs: ' + withBin.stdout);
    assert.ok(withBin.stdout.includes('current: ' + version()), 'and must still say what is selected: ' + withBin.stdout);
    // The launch runs the command, with the command's own arguments first and the
    // user's after — that order is what makes `bin node dev.js --flag` usable.
    const launched = await run(['--port', '1234']);
    assert.equal(launched.status, 0, 'a launch must run the command: ' + launched.stderr);
    assert.match(launched.stdout, /DEV-BUILD-ARGV \["--port","1234"\]/, 'the arguments must arrive: ' + launched.stdout);
    // `use` cannot mean anything while a command launches, so it says why.
    const useWhileBin = await run(['use', 'latest']);
    assert.notEqual(useWhileBin.status, 0, 'use must be refused while bin is set');
    assert.match(useWhileBin.stderr, /`use --bin off` goes back to releases/, 'expected the way out: ' + useWhileBin.stderr);
    assert.equal(version(), selected, 'and nothing may have been switched');
    // A path that is not there is a typo now, not a launch failure later.
    const bogus = await run(['use', '--bin', path.join(dir, 'no-such-build')]);
    assert.notEqual(bogus.status, 0, 'a missing path must be refused');
    assert.match(bogus.stderr, /no such file:/, 'expected the path named: ' + bogus.stderr);
    assert.match(fs.readFileSync(path.join(dir, '.bin'), 'utf8'), /dev-build\.js/, 'a refused --bin must change nothing');
    const cleared = await run(['use', '--bin', 'off']);
    assert.equal(cleared.status, 0, '--bin off must work: ' + cleared.stderr);
    assert.ok(!fs.existsSync(path.join(dir, '.bin')), '--bin off must remove the file');
    const backToReleases = await run(['use']);
    assert.match(backToReleases.stdout, /^current: /m, 'status must go back to releases: ' + backToReleases.stdout);
    assert.ok(!/launching:/.test(backToReleases.stdout), 'and stop reporting a command: ' + backToReleases.stdout);
    console.log('ok: `--bin` launches a command instead of a release, and `--bin off` goes back');

    api.srv.close();
    asset.srv.close();
  }

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
    const env = { TERMCP_DATA_DIR: dir, TERMCP_API: api.url };
    // Selecting is not installing, so the refusal has to be provoked by the thing
    // that does install: the launch. Selecting a release with no digest is fine —
    // `.version` is one line, and there is nothing to verify about a line.
    const chosen = await runWrapper([asset.url], null, 60000, env, ['use', 'v9.9.0']);
    assert.equal(chosen.status, 0, 'selecting must work whatever the release publishes: ' + chosen.stderr);
    assert.equal(fs.readFileSync(path.join(dir, '.version'), 'utf8').trim(), 'v9.9.0');
    const run = await runWrapper([asset.url], null, 60000, env, []);
    assert.notEqual(run.status, 0, 'an unverifiable release must not install');
    assert.match(run.stderr, /no SHA-256 digest is published/, 'expected the refusal: ' + run.stderr);
    assert.ok(!fs.existsSync(path.join(dir, 'versions', 'v9.9.0')), 'nothing may be installed');

    // TERMCP_SKIP_VERIFY is the escape hatch: it downloads and installs anyway,
    // only checking length. The launch then fails for the usual reason — the
    // "binary" here is not an executable — which is why the assertion is about
    // what landed on disk rather than the exit code.
    const bypassed = await runWrapper([asset.url], null, 60000, Object.assign({ TERMCP_SKIP_VERIFY: '1' }, env), []);
    assert.match(bypassed.stderr, /installing v9\.9\.0 unchecked/, 'expected the unchecked install: ' + bypassed.stderr);
    assert.ok(fs.existsSync(path.join(dir, 'versions', 'v9.9.0')), 'the unchecked binary must land in place: ' + bypassed.stderr);
    console.log('ok: TERMCP_SKIP_VERIFY allows the install through unchecked');

    api.srv.close();
    asset.srv.close();
    fs.rmSync(dir, { recursive: true, force: true });
    console.log('ok: a release with no published digest is refused, not installed');
  }

  // 13. The wrapper's own MCP tool (`--mcp`): ONE tool whose `cmd` is a word from
  // the command line, so what an agent learns is what a person types. stdout
  // carries frames and nothing else, a refused command comes back as a tool error
  // instead of ending the server, and `list` is remembered so a polling agent
  // cannot spend GitHub's 60 requests an hour.
  {
    const dir = path.join(os.tmpdir(), `termcp-mcp-${process.pid}`);
    fs.rmSync(dir, { recursive: true, force: true });
    const body = Buffer.from('termcp fake release\n'.repeat(64));
    const rel = (tag, prerelease = false) => ({
      tag_name: tag,
      draft: false,
      prerelease,
      assets: [{ name: ASSET, size: body.length, digest: `sha256:${sha(body)}` }],
    });
    // beta is published but not in the channel file, so it is the line that proves
    // the gate is on switching rather than on looking.
    const releases = [rel('v9.0.2'), rel('v9.0.2-rc.10', true), rel('nightly-20261002', true), rel('v9.0.3-beta.1', true)];
    let apiCalls = 0;
    const api = await releasesAPI(() => { apiCalls++; return releases; });
    const asset = await mirror(body, { tag: 'fake' });
    const mcp = mcpClient(dir, { TERMCP_API: api.url, TERMCP_MIRROR: asset.url }, ['use', '--mcp', '--checkupdate']);
    const call = (cmd) => mcp.request('tools/call', { name: 'use', arguments: cmd === undefined ? {} : { cmd } });
    const text = (res) => res.result.content[0].text;

    const init = await mcp.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
    assert.equal(init.result.protocolVersion, '2025-06-18', 'the client’s protocol version must come back');
    assert.match(init.result.instructions, /run `use --check` once/, '--checkupdate must reach the prompt: ' + init.result.instructions);
    mcp.notify('notifications/initialized');
    const tools = await mcp.request('tools/list');
    assert.equal(tools.result.tools.length, 1, 'one tool, not a pile: ' + JSON.stringify(tools.result.tools.map((t) => t.name)));
    assert.equal(tools.result.tools[0].name, 'use', 'the tool is named after the one word it takes');
    console.log('ok: `--mcp` serves one tool, and the handshake answers');

    // Status reads local files: an agent may ask as often as it likes.
    const before = await call();
    assert.match(text(before), /current: nothing selected/, 'expected an empty selection: ' + text(before));
    assert.match(text(before), /checking: stable \(/, 'a bare cmd must name what a check reports on: ' + text(before));
    assert.equal(apiCalls, 0, 'status must not touch the network: ' + mcp.stderr());

    const listed = await call('use --list');
    assert.match(text(listed), /stable\s+v9\.0\.2/, 'list must give each line’s newest tag: ' + text(listed));
    assert.match(text(listed), /rc\s+v9\.0\.2\s/, 'an rc line carries the final it was testing: ' + text(listed));
    assert.match(text(listed), /nightly\s+nightly-20261002/, 'a dated line orders as a string: ' + text(listed));
    assert.match(text(listed), /<- current line/, 'the line in .version must be marked: ' + text(listed));
    assert.equal(apiCalls, 1, 'list must fetch once');
    await call('use --list');
    assert.equal(apiCalls, 1, 'a second list must come from the cache, not GitHub');
    assert.ok(fs.existsSync(path.join(dir, '.releases-cache.json')), 'the list must be on disk');
    assert.ok(fs.existsSync(path.join(dir, '.check', 'lastcheck')), 'and when it was fetched, in its own file');
    // Given a line, `list` hands over its tags instead of a verdict, so the caller
    // can apply a rule of its own (rc only, never nightly) rather than this side
    // guessing which release it wants.
    const tags = await call('use --list --channel rc');
    assert.ok(!tags.result.isError, 'list --channel must work: ' + text(tags));
    // The line's newest is the final its rcs were testing, and it is listed first —
    // the same answer `check --channel rc` and `use --channel rc` give.
    assert.match(text(tags), /v9\.0\.2\s+<- newest on this line \(final\)/, 'the line’s newest must be marked: ' + text(tags));
    assert.match(text(tags), /v9\.0\.2-rc\.10/, 'every tag on the line must be listed: ' + text(tags));
    assert.ok(text(tags).indexOf('v9.0.2  ') < text(tags).indexOf('v9.0.2-rc.10'), 'newest first: ' + text(tags));
    assert.equal(apiCalls, 1, 'one line\'s tags come from the same list');
    const noLine = await call('use --list --channel preview');
    assert.equal(noLine.result.isError, true, 'a line with nothing on it must be refused');
    assert.match(text(noLine), /published lines: beta, nightly, rc, stable/, 'and must name the lines that exist: ' + text(noLine));
    console.log('ok: `list` names each line’s newest tag and remembers the answer');

    // `.check/channel` is a scope for `--check`, not a permission: it says which
    // lines a check reports on when it is not told, and refuses nothing. Written
    // here by hand because it is a preference, and a preference is a file.
    const channelFile = path.join(dir, '.check', 'channel');
    fs.mkdirSync(path.dirname(channelFile), { recursive: true });
    fs.writeFileSync(channelFile, ['# lines a check looks at when it is not told', 'rc', 'nightly', ''].join(String.fromCharCode(10)));
    const allowed = await call('use');
    assert.match(text(allowed), /checking: stable, nightly, rc/, 'status must list what a check reports on: ' + text(allowed));
    // A line the file does not name is not refused — it is simply not watched.
    const offScope = await call('use --channel beta');
    assert.ok(!offScope.result.isError, 'a line outside the file must still switch: ' + text(offScope));
    assert.match(text(offScope), /v9\.0\.3-beta\.1 selected/, 'and must switch to it: ' + text(offScope));
    // The line in use is always watched, whether or not the file names it.
    const backOnRc = await call('use v9.0.2-rc.10');
    assert.ok(!backOnRc.result.isError, 'switching back must work: ' + text(backOnRc));
    const onRc = await call('use');
    assert.match(text(onRc), /checking: rc, nightly/, 'and the line in use is watched too: ' + text(onRc));
    // Looking is never gated, and several lines can be looked at in one call.
    const peek = await call('use --list --channel beta');
    assert.ok(!peek.result.isError, 'listing a line outside the file must work: ' + text(peek));
    assert.match(text(peek), /v9\.0\.3-beta\.1/, 'and must list what is on it: ' + text(peek));
    const twoToSwitch = await call('use --channel rc,nightly');
    assert.ok(!twoToSwitch.result.isError, 'two lines must be a wider net, not a refusal: ' + text(twoToSwitch));
    assert.match(text(twoToSwitch), /selected/, 'and must switch: ' + text(twoToSwitch));
    assert.match(text(twoToSwitch), /\(channel rc or nightly\)/, 'and say which lines it chose from: ' + text(twoToSwitch));
    // Back on the rc line: the rest of the block reasons about it.
    const backOnRcAgain = await call('use v9.0.2-rc.10');
    assert.ok(!backOnRcAgain.result.isError, 'switching back must work: ' + text(backOnRcAgain));
    console.log('ok: the channel file is a check scope, not a permission; several lines mean the newest');

    const callsBeforeSwitch = apiCalls;
    const used = await call('use latest');
    assert.ok(!used.result.isError, 'use must succeed: ' + text(used));
    assert.match(text(used), /termcp v9\.0\.2 selected/, 'expected the switch report: ' + text(used));
    assert.equal(fs.readFileSync(path.join(dir, '.version'), 'utf8').trim(), 'v9.0.2', 'the switch must be recorded');
    assert.equal(apiCalls, callsBeforeSwitch + 1, 'a switch resolves against a fresh list, not the cache');
    const moved = await call('use --channel nightly');
    assert.ok(!moved.result.isError, '--channel must work in the tool: ' + text(moved));
    assert.equal(fs.readFileSync(path.join(dir, '.version'), 'utf8').trim(), 'nightly-20261002');
    console.log('ok: the tool switches versions by reusing `use`');

    // A refusal is a tool result, not a dead server.
    const missing = await call('use v9.9.9');
    assert.equal(missing.result.isError, true, 'a release nobody published must be a tool error');
    assert.match(text(missing), /no such release/, 'expected the 404 to say so: ' + text(missing));
    const bogus = await call('--nonsense');
    assert.equal(bogus.result.isError, true, 'an unknown option must be a tool error');
    assert.match(text(bogus), /--nonsense/, 'expected the word named: ' + text(bogus));
    // `--rm` needs installed releases, and selecting one no longer installs it —
    // the download belongs to a launch — so they are put here the way a launch
    // would have put them.
    for (const t of ['v9.0.2', 'nightly-20261002']) {
      const p = path.join(dir, 'versions', t, process.platform === 'win32' ? 'termcp.exe' : 'termcp');
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, '');
    }
    // rm is the same function on both doors: one release goes, the selected one
    // is refused.
    const dropSelected = await call(`use --rm ${fs.readFileSync(path.join(dir, '.version'), 'utf8').trim()}`);
    assert.equal(dropSelected.result.isError, true, 'the selected version must not be removable');
    assert.match(text(dropSelected), /is the selected version/, 'expected the refusal: ' + text(dropSelected));
    const dropped = await call('use --rm v9.0.2');
    assert.ok(!dropped.result.isError, 'rm must work over MCP: ' + text(dropped));
    assert.match(text(dropped), /removed v9\.0\.2/, 'expected the report: ' + text(dropped));
    assert.ok(!fs.existsSync(path.join(dir, 'versions', 'v9.0.2')), 'the directory must be gone');
    const alive = await mcp.request('ping');
    assert.ok(alive.result, 'the server must still answer after two refusals');
    assert.deepEqual(mcp.stray, [], 'stdout must carry frames and nothing else');
    console.log('ok: a refused command is a tool error, and the server stays up');

    // `check` is the update question with a day-long memory: a repeat inside the
    // window answers from disk and says how old it is; --force spends the request.
    // .version is on the nightly line by now, so that is the line it judges.
    const lastCheckPath = path.join(dir, '.check', 'lastcheck');
    const callsBefore = apiCalls;
    const upToDate = await call('use --check');
    assert.ok(!upToDate.result.isError, 'check must work: ' + text(upToDate));
    assert.match(text(upToDate), /nightly\s+up to date \(nightly-20261002\)/, 'expected the verdict: ' + text(upToDate));
    assert.match(text(upToDate), /checked .+\(`use --check --force` asks GitHub now; the window is 1d from default\)/, 'expected the age and the window: ' + text(upToDate));
    assert.equal(apiCalls, callsBefore, 'a check inside the day must not ask GitHub');
    await call('use --check --force');
    assert.equal(apiCalls, callsBefore + 1, '--force must ask GitHub anyway');
    // Age the record past the window and the next check fetches on its own. The
    // timestamp is a file of its own, so this is a one-line edit rather than
    // surgery on a few hundred KB of JSON.
    fs.writeFileSync(lastCheckPath, new Date(Date.now() - 25 * 3600000).toISOString());
    const afterADay = await call('use --check');
    assert.equal(apiCalls, callsBefore + 2, 'a check older than a day must fetch');
    assert.match(text(afterADay), /checked just now/, 'a fresh fetch must say so: ' + text(afterADay));
    // And the verdict flips when there is something newer on the line.
    releases.unshift(rel('nightly-20261003', true));
    const behind = await call('use --check --force');
    assert.match(text(behind), /newer: nightly-20261003/, 'expected the newer tag: ' + text(behind));
    assert.match(text(behind), /switch with `use nightly-20261003`/, 'expected the pointer: ' + text(behind));
    releases.shift();
    // Every line the file names is reported, not just the one in use — and nothing
    // else is, because the file is what says which lines are worth looking at. A
    // line nobody is running is not "behind" (there is nothing to update), so it
    // is reported as a newest tag and not judged.
    const both = await call('use --check --force');
    assert.match(text(both), /nightly\s+up to date \(nightly-20261002\)  <- current line/, 'the line in use must be judged: ' + text(both));
    assert.match(text(both), /rc\s+newest: v9\.0\.2/, 'the lines the file names must be reported: ' + text(both));
    assert.ok(!/stable/.test(text(both)), 'a line the file does not name is not reported: ' + text(both));
    assert.ok(!/behind/.test(text(both)), 'nothing may be called behind after the newest is installed: ' + text(both));
    assert.equal(apiCalls, callsBefore + 4, '--force is the only thing that spends a request');
    // A line can also be asked about without writing anything down.
    const named = await call('use --check --channel stable');
    assert.match(text(named), /stable\s+newest: v9\.0\.2/, 'a named line must be reported: ' + text(named));
    assert.equal(apiCalls, callsBefore + 4, 'and naming it costs no extra request');
    console.log('ok: `--check` answers from the cache, ages out on its timestamp, and covers the lines named');

    // `--delay` is the other half: how long a check may reuse its answer. It has an
    // option because it grants nothing; the file above does not, because it does.
    const delayFile = path.join(dir, '.check', 'delay');
    const window = await call('use --delay 6h');
    assert.ok(!window.result.isError, '--delay must work: ' + text(window));
    assert.equal(fs.readFileSync(delayFile, 'utf8').trim(), '6h');
    assert.match(text(window), /reuse window: 6h/, 'expected the window reported: ' + text(window));
    const nowWindow = await call('use --check');
    assert.match(text(nowWindow), /the window is 6h from delay file/, 'the window must be named: ' + text(nowWindow));
    const restored = await call('use --delay default');
    assert.match(text(restored), /reuse window: 1d \(from default\)/, 'default must restore it: ' + text(restored));
    assert.ok(!fs.existsSync(delayFile), 'and must remove the file rather than blank it');
    const unknownDelay = await call('use --delay 1w');
    assert.ok(unknownDelay.result.isError, '1w must be refused');
    assert.match(text(unknownDelay), /takes an interval like 30m, 6h or 2d, not 1w/, 'expected the reason: ' + text(unknownDelay));
    console.log('ok: `--delay` records how long a check may reuse its answer');

    // An agent can point every launch at a command too — that is the point of
    // `--bin` living in the tool as well as at the shell: an MCP config's env is
    // written by hand and read at connect time, and no tool call can reach it.
    const devBuild = path.join(dir, 'dev-build.js');
    fs.writeFileSync(devBuild, 'console.log("DEV-BUILD-ARGV " + JSON.stringify(process.argv.slice(2)));');
    // Quoted, because this door has no shell and this machine's node path has a
    // space in it: an unquoted call is refused with the reason, not silently cut.
    const unquoted = await call('use --bin ' + process.execPath + ' ' + devBuild);
    assert.ok(unquoted.result.isError, 'an unquoted path with a space must be refused');
    assert.match(text(unquoted), /needs quotes/, 'expected the fix named: ' + text(unquoted));
    const pointed = await call(`use --bin "${process.execPath}" ${devBuild}`);
    assert.ok(!pointed.result.isError, '--bin must work over MCP: ' + text(pointed));
    assert.match(text(pointed), /launching: .*dev-build\.js \(from \.bin\)/, 'expected the report: ' + text(pointed));
    const binStatus = await call('use');
    assert.match(text(binStatus), /launching: .*dev-build\.js/, 'status must report it: ' + text(binStatus));
    const binCheck = await call('use --check');
    assert.match(text(binCheck), /note: launches run .*dev-build\.js/, 'check must not answer as if a release ran: ' + text(binCheck));
    const unset = await call('use --bin off');
    assert.ok(!unset.result.isError, '--bin off must work: ' + text(unset));
    assert.ok(!fs.existsSync(path.join(dir, '.bin')), 'and must remove the file');
    console.log('ok: the tool can point launches at a command, and says so afterwards');

    // --checkupdate changes what the agent is TOLD, not what it can do: `check` is
    // always callable, and the flag adds the standing order to go look and report.
    const plain = mcpClient(dir, { TERMCP_API: api.url });
    const plainInit = await plain.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
    const plainTools = await plain.request('tools/list');
    assert.ok(!/run `use --check` once/.test(plainInit.result.instructions), 'a plain server must not order a check: ' + plainInit.result.instructions);
    assert.ok(!/run `use --check` once/.test(plainTools.result.tools[0].description), 'and must not say it in the tool: ' + plainTools.result.tools[0].description);
    const plainCheck = await plain.request('tools/call', { name: 'use', arguments: { cmd: 'use --check' } });
    assert.ok(!plainCheck.result.isError, 'check must work without the flag: ' + plainCheck.result.content[0].text);
    assert.equal(await plain.close(), 0);
    console.log('ok: `check` is always callable; `--checkupdate` adds the order to go and look');

    // The cache is spent by the clock, so an exhausted or unreachable API still
    // has an answer — and TERMCP_CACHE_MINUTES=0 refuses to use it at all.
    api.srv.close();
    const cached = await call('use --list');
    assert.ok(!cached.result.isError, 'a cached list must outlive the API: ' + text(cached));
    assert.equal(await mcp.close(), 0, 'stdin closing must end the server with 0');
    const fresh = mcpClient(dir, { TERMCP_API: api.url, TERMCP_CACHE_MINUTES: '0' });
    const gone = await fresh.request('tools/call', { name: 'use', arguments: { cmd: 'use --list' } });
    assert.equal(gone.result.isError, true, 'with caching off and no API, list must fail');
    assert.match(gone.result.content[0].text, /unreachable|answered/, 'expected a clear reason: ' + gone.result.content[0].text);
    assert.equal(await fresh.close(), 0, 'a refusal must not become the exit code');
    console.log('ok: the cached list is reused, and TERMCP_CACHE_MINUTES=0 bypasses it');

    asset.srv.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // 14. `--kill` is the one action that runs a command, and until here the suite
  // only ever saw it refuse: every other case had nothing installed. What it must
  // do is spawn what is already on disk — the selected release, or the --bin
  // command — with `daemon stop` appended, and hand back what that command said.
  // And it must not run anything at all when there is nothing installed to run.
  {
    const dir = path.join(os.tmpdir(), `termcp-kill-${process.pid}`);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    const marker = path.join(dir, 'ran.txt');
    const say = path.join(dir, 'say.js');
    // A command that leaves a trace, so "nothing was spawned" is a fact and not an
    // absence of output.
    fs.writeFileSync(say,
      `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran');`
      + `console.log('KILL-ARGV ' + JSON.stringify(process.argv.slice(2)));`);
    const run = (args) => runWrapper(null, null, 60000, { TERMCP_DATA_DIR: dir }, args);
    const versionFile = path.join(dir, '.version');

    // Nothing selected: refused before anything is spawned.
    const nothing = await run(['use', '--kill']);
    assert.notEqual(nothing.status, 0, '--kill with nothing selected must refuse');
    assert.match(nothing.stderr, /nothing is selected/, 'expected the reason: ' + nothing.stderr);
    assert.ok(!fs.existsSync(marker), 'nothing may be spawned when nothing is selected');

    // Selected but not installed — the case `use latest` produces, because
    // selecting does not install. Refused, and still nothing spawned.
    fs.writeFileSync(versionFile, 'v9.9.9\n');
    const missing = await run(['use', '--kill']);
    assert.notEqual(missing.status, 0, '--kill must refuse a version that is not installed');
    assert.match(missing.stderr, /v9\.9\.9 is not installed/, 'expected the version named: ' + missing.stderr);
    assert.ok(!fs.existsSync(marker), 'a version that was never installed must not be run');

    // A command is on disk (the same line `--bin` stores), so `--kill` runs it with
    // the daemon flags appended — the only place on this surface a process starts.
    const pointed = await run(['use', '--bin', process.execPath, say]);
    assert.equal(pointed.status, 0, '--bin must store the command: ' + pointed.stderr);
    const killed = await run(['use', '--kill', '--port', '19000']);
    assert.equal(killed.status, 0, '--kill must succeed: ' + killed.stderr);
    assert.match(killed.stdout, /KILL-ARGV \["daemon","stop","--port","19000"\]/, 'expected daemon stop with the flags: ' + killed.stdout);
    assert.ok(fs.existsSync(marker), 'the command must have run');

    // The same on the MCP door: the tool reuses the one function, so a command
    // reachable at the shell is reachable there — and a refusal is still a tool
    // error rather than a dead server.
    fs.rmSync(marker, { force: true });
    const mcp = mcpClient(dir, {});
    await mcp.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
    const overMcp = await mcp.request('tools/call', { name: 'use', arguments: { cmd: 'use --kill' } });
    assert.ok(!overMcp.result.isError, '--kill over MCP must work: ' + overMcp.result.content[0].text);
    assert.match(overMcp.result.content[0].text, /KILL-ARGV \["daemon","stop"\]/, 'expected daemon stop: ' + overMcp.result.content[0].text);
    assert.ok(fs.existsSync(marker), 'the tool must have run the command');
    // Take the command away again: the selected release is still not installed, so
    // the tool must refuse — and must not have spawned anything.
    fs.rmSync(marker, { force: true });
    await mcp.request('tools/call', { name: 'use', arguments: { cmd: 'use --bin off' } });
    const refused = await mcp.request('tools/call', { name: 'use', arguments: { cmd: 'use --kill' } });
    assert.equal(refused.result.isError, true, 'nothing installed must be a tool error: ' + refused.result.content[0].text);
    assert.match(refused.result.content[0].text, /is not installed/, 'expected the reason: ' + refused.result.content[0].text);
    assert.ok(!fs.existsSync(marker), 'a refusal must not spawn anything');
    const alive = await mcp.request('ping');
    assert.ok(alive.result, 'the server must still answer after a refusal');
    assert.equal(await mcp.close(), 0);
    fs.rmSync(dir, { recursive: true, force: true });
    console.log('ok: `--kill` runs the command on disk (both doors) and refuses when nothing is installed');
  }

  // Restore a real install so the next run is cheap.
  fs.writeFileSync(VERSION_FILE, remembered + '\n');
  console.log('all checks passed');
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
