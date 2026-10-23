#!/usr/bin/env node
'use strict';
// termcp wrapper: resolve the termcp binary for this platform, then hand it your
// argv and your stdio. Nothing else — the binary owns the terminal, the Web UI,
// and its own MCP endpoint.
//
// Version resolution, in order:
//   1. $TERMCP_VERSION           — explicit pin, never consults or writes .version
//   2. <data dir>/.version       — the version remembered from the last resolve
//   3. latest release            — resolved from the GitHub API, then remembered
// Binaries live in <data dir>/versions/<version>/termcp and are skipped when
// already present, so a run costs one stat once installed.
//
// Checksums always come from the GitHub API (a few KB, authoritative) while the
// bytes come from whichever source measures fastest — mirrors included. The
// final sha256 is what makes a mirror untrusted-but-usable.
//
// One command-line word belongs to this wrapper and never reaches the binary:
//   use <tag>|latest [--channel <name>]
//                  make that release the one launches run, then exit. `latest`
//                  means the newest release on the line .version is already on;
//                  --channel moves to another line for that one command; a tag
//                  is any release, newer or older.
// A line is named by its tags (`v0.2.8` stable, `v0.2.8-rc.1` rc, `v0.3.0-beta.2`
// beta, `nightly-20261002` nightly), so no channel is hard-coded here and a new
// line needs no change.
// Nothing checks for updates on its own, and nothing records a channel:
// `.version` holds the tag, the tag says which line it is on, and a launch reads
// it and touches no network. A version already on disk switches instantly and
// offline — which is also how a downgrade works.
//
// Env: TERMCP_VERSION (pin, or "latest" to refresh), TERMCP_BIN (use this
//      binary, skip everything), TERMCP_MIRROR (comma-separated prefixes),
//      TERMCP_DATA_DIR (termcp's data directory; defaults to ~/.termcp),
//      TERMCP_SKIP_DOWNLOAD, TERMCP_API (GitHub API base; defaults to
//      https://api.github.com), TERMCP_SKIP_VERIFY (install a release that has
//      no digest to check against).
//
// Cache location: the data directory itself, exactly as termcp resolves it
// (config.DefaultDataDir) — $TERMCP_DATA_DIR when set, else ~/.termcp. The
// wrapper adds only `versions/<version>/termcp` and `.version` inside it, so
// `TERMCP_DATA_DIR=/opt/termcp termcp ...` moves both.
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const DATA_DIR = (process.env.TERMCP_DATA_DIR || '').trim() || path.join(os.homedir(), '.termcp');
// Install a release that publishes no digest to check against. The check itself
// is never skipped: a digest that disagrees with the bytes is corruption, and
// that download fails with or without this.
const SKIP_VERIFY = !!process.env.TERMCP_SKIP_VERIFY;
const VERSIONS_DIR = path.join(DATA_DIR, 'versions');
const VERSION_FILE = path.join(DATA_DIR, '.version');
const REPO = 'open-mcp-ai/termcp';
// GitHub API base. TERMCP_API exists so the channel resolution can be tested
// against a local server instead of whatever GitHub published this morning.
const API = ((process.env.TERMCP_API || '').trim() || 'https://api.github.com').replace(/\/+$/, '');
const ASSETS = {
  win32: { x64: 'termcp-windows-amd64.exe', arm64: 'termcp-windows-arm64.exe' },
  darwin: { x64: 'termcp-darwin-amd64', arm64: 'termcp-darwin-arm64' },
  linux: { x64: 'termcp-linux-amd64', arm64: 'termcp-linux-arm64' },
};

// Release mirrors: prefix + full GitHub URL. Tried *with* github.com, not
// instead of it — direct GitHub is sometimes the fastest of the lot.
const MIRRORS = [
  'https://gh-proxy.com',
  'https://ghproxy.net',
  'https://ghfast.top',
  'https://hub.gitmirror.com',
  'https://gh.llkk.cc',
];

const PROBE_MS = 5000;          // per-source measurement window
const PROBE_BYTES = 524288;     // ...capped at this many bytes
const FAST_BYTES = 204800;      // first source to reach this wins, no waiting
const STALL_MS = 15000;         // no bytes for this long -> give up on this source

// `die` reports and stops the run without calling `process.exit`: exiting while
// an in-flight fetch closes its handle trips a libuv assertion on Windows (the
// message prints, then the process aborts with 0xC0000409 instead of exiting 1).
// Throwing a sentinel unwinds to the top-level catch, and the process ends on its
// own — immediately, since by then the fetch is done.
class Stop extends Error {}
const die = (msg) => {
  try { fs.writeSync(2, `termcp: ${msg}\n`); } catch {}
  process.exitCode = 1;
  throw new Stop(msg);
};
const log = (step, message) => {
  try { fs.writeSync(2, `termcp: [${step}] ${message}\n`); } catch {}
};
const mbps = (bps) => (bps >= 1048576 ? `${(bps / 1048576).toFixed(1)} MB/s` : `${Math.round(bps / 1024)} KB/s`);
function sourceName(url) {
  if (url.startsWith(`https://github.com/${REPO}/releases/`)) return 'GitHub';
  try { return new URL(url).host; } catch { return 'configured mirror'; }
}

function assetName() {
  const name = (ASSETS[process.platform] || {})[process.arch];
  if (!name) die(`no prebuilt binary for ${process.platform}/${process.arch}; build from https://github.com/${REPO}`);
  return name;
}

// "0.2.3" and "v0.2.3" are the same release; a branch or tag name is passed
// through untouched so it resolves the same way GitHub does.
function normalizeTag(version) {
  const v = String(version).trim();
  if (/^v?\d/.test(v)) return `v${v.replace(/^v/, '')}`;
  return v;
}

function binaryPath(tag) {
  const file = process.platform === 'win32' ? 'termcp.exe' : 'termcp';
  return path.join(VERSIONS_DIR, tag, file);
}

function readVersionFile() {
  try {
    const v = fs.readFileSync(VERSION_FILE, 'utf8').trim();
    return v || null;
  } catch {
    return null;
  }
}

function rememberVersion(tag) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(VERSION_FILE, tag + '\n');
    log('version', `remembered ${tag} for future runs`);
  } catch (e) {
    log('version', `could not remember ${tag}: ${e.message}`);
  }
  process.env.TERMCP_VERSION = tag; // so anything we spawn sees the same pin
}

// --- the channel -------------------------------------------------------------
// A channel is a line of releases, and its tags name it, so the list is not
// closed: `v0.2.8` is stable, `v0.2.9-rc.2` is rc, `v0.3.0-beta.1` is beta,
// `nightly-20261002` is nightly. Nothing records which one you are on — the tag
// in .version already says it — and a new line needs no change here.
function channelOf(tag) {
  if (!tag) return 'stable';
  const name = normalizeTag(tag);
  const key = versionKey(name);
  if (key) return key.pre.length ? key.pre[0].toLowerCase() : 'stable';
  const word = /^([A-Za-z][A-Za-z0-9]*)(?:[-_.].*)?$/.exec(name);
  return word ? word[1].toLowerCase() : 'stable';
}

// One GitHub API call. `ok: false` with status 0 means the network failed; any
// other status is the API answering (404 = no such release).
async function apiJSON(pathname) {
  try {
    const res = await fetch(`${API}/repos/${REPO}/${pathname}`, {
      headers: { 'User-Agent': 'termcp-npm' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return { ok: false, status: res.status };
    return { ok: true, body: await res.json() };
  } catch {
    return { ok: false, status: 0 };
  }
}

// One release's metadata for this asset: tag, sha256 digest, size.
function assetDigest(release, asset) {
  const found = (release.assets || []).find((a) => a.name === asset);
  const [algo, hex] = String((found && found.digest) || '').split(':');
  return {
    tag: release.tag_name,
    sha256: algo === 'sha256' && /^[0-9a-f]{64}$/.test(hex) ? hex : null,
    size: (found && found.size) || 0,
  };
}

// Official metadata for one release.
async function releaseMeta(asset, tag) {
  const r = await apiJSON(`releases/tags/${normalizeTag(tag)}`);
  if (!r.ok) return { offline: true, status: r.status };
  return assetDigest(r.body, asset);
}

// vX.Y.Z with the pre-release identifiers split out, or null for a tag that is
// not a version at all (`nightly-20261002`, a dev build, a branch name).
function versionKey(tag) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/.exec(String(tag).trim());
  if (!m) return null;
  return { core: [+m[1], +m[2], +m[3]], pre: m[4] ? m[4].split('.') : [] };
}

// Semver order between two tags versionKey accepted. The numeric triple first,
// then the pre-release identifiers: a version without one is newest (v0.2.8 >
// v0.2.8-rc.4), and identifiers compare numerically when both are numbers, so
// rc.9 < rc.10 — string comparison gets that backwards.
function compareTags(a, b) {
  const x = versionKey(a);
  const y = versionKey(b);
  for (let i = 0; i < 3; i++) if (x.core[i] !== y.core[i]) return x.core[i] < y.core[i] ? -1 : 1;
  // A version without a pre-release is newer than any of its own pre-releases:
  // v0.2.8 > v0.2.8-rc.10.
  if (!x.pre.length || !y.pre.length) {
    if (x.pre.length === y.pre.length) return 0;
    return x.pre.length ? -1 : 1;
  }
  for (let i = 0; i < Math.min(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === q) continue;
    const pn = /^\d+$/.test(p);
    const qn = /^\d+$/.test(q);
    if (pn && qn) return Number(p) < Number(q) ? -1 : 1;
    if (pn !== qn) return pn ? -1 : 1; // a numeric identifier sorts before an alphanumeric one
    return p < q ? -1 : 1;
  }
  if (x.pre.length === y.pre.length) return 0;
  return x.pre.length < y.pre.length ? -1 : 1;
}

// Order within one line: version-shaped tags compare as versions (rc.9 < rc.10),
// anything else as a string, which is exactly what a dated `nightly-20261002`
// means.
// ponytail: one page of 100 releases is the window these tags are read from; a
// line that has not published in 100 releases reads as empty. Paginate if such a
// line ever needs resolving.
function compareTagNames(a, b) {
  if (versionKey(a) && versionKey(b)) return compareTags(a, b);
  return a < b ? -1 : a > b ? 1 : 0;
}

// The newest release on a channel, with its digest. A pre-release line also
// carries the final it was testing — once `v0.2.8` ships, someone on
// `v0.2.8-rc.4` has nothing left to test — so the line is its own tags plus the
// plain release of the same version. Comparing the candidates as versions is what
// makes the final outrank its own rcs, and a hotfix on an older line cannot win
// by being published later.
// ponytail: promotion matches the numeric triple only. That covers the rc of the
// version being tested, which is the case that happens.
async function channelMeta(asset, channel) {
  const r = await apiJSON('releases?per_page=100');
  if (!r.ok) return { offline: true, status: r.status };
  const list = (Array.isArray(r.body) ? r.body : []).filter((rel) => rel && !rel.draft && rel.tag_name);
  const tested = new Set(list
    .filter((rel) => channelOf(rel.tag_name) === channel)
    .map((rel) => versionKey(rel.tag_name))
    .filter(Boolean)
    .map((key) => key.core.join('.')));
  let pick = null;
  for (const rel of list) {
    const key = versionKey(rel.tag_name);
    const onLine = channelOf(rel.tag_name) === channel
      || (key && !key.pre.length && tested.has(key.core.join('.')));
    if (!onLine) continue;
    if (!pick || compareTagNames(rel.tag_name, pick.tag_name) > 0) pick = rel;
  }
  if (!pick) {
    // Nothing on that line: the lines that do exist are what the answer can be.
    return { empty: true, lines: [...new Set(list.map((rel) => channelOf(rel.tag_name)))].sort() };
  }
  return assetDigest(pick, asset);
}

// Measure one source: ranged GET, bytes streamed into its own temp file so the
// winner's head can be kept instead of re-downloaded. Resolves early the moment
// it has FAST_BYTES, otherwise on the deadline with whatever arrived.
function probe(url, part, { onFast, controllers }) {
  const ac = new AbortController();
  controllers.set(url, ac);
  const started = Date.now();
  fs.mkdirSync(path.dirname(part), { recursive: true });
  const out = fs.createWriteStream(part, { mode: 0o600 });
  let got = 0;
  let fast = false;
  const deadline = setTimeout(() => { if (got < FAST_BYTES) ac.abort(); }, PROBE_MS);
  return (async () => {
    try {
      const res = await fetch(url, { headers: { Range: `bytes=0-${PROBE_BYTES - 1}` }, signal: ac.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      for await (const chunk of res.body) {
        got += chunk.length;
        if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
        if (got >= FAST_BYTES && !fast) { fast = true; onFast(url); }
        if (got >= PROBE_BYTES) break;
      }
    } catch {
      // aborted or failed: the bytes that made it are still a valid head
    } finally {
      clearTimeout(deadline);
      await new Promise((r) => (out.writableEnded ? r() : out.end(r)));
      controllers.delete(url);
    }
    const secs = Math.max((Date.now() - started) / 1000, 0.001);
    return { url, part, got, secs, speed: got / secs };
  })();
}

// Probe every source in parallel; return them fastest-first. First source to
// FAST_BYTES wins outright and the rest are aborted (their partial files are
// dropped). Otherwise the one with the most bytes in the window wins.
async function measureAll(sources, part) {
  const controllers = new Map();
  let winner = null;
  const onFast = (url) => {
    if (winner) return;
    winner = url;
    for (const [u, ac] of controllers) if (u !== url) ac.abort();
  };
  const results = await Promise.all(sources.map((url, i) =>
    probe(url, `${part}.probe${i}`, { onFast, controllers }).then((result) => ({ ...result, index: i + 1 }))));
  results.sort((a, b) => b.got - a.got);
  const won = winner || (results[0] && results[0].url);
  results.sort((a, b) => Number(b.url === won) - Number(a.url === won) || b.got - a.got);
  for (const r of results) {
    const line = r.got > 0
      ? `${String(Math.round(r.got / 1024)).padStart(4)} KB in ${r.secs.toFixed(1)}s (${mbps(r.speed)})`
      : 'no data';
    log('probe', `${r.index}/${sources.length} ${sourceName(r.url)}: ${line}${r.url === won ? ' — selected' : ''}`);
  }
  return results;
}

// Fetch the remainder into `part`, resuming at its current size. Appending is
// safe across sources because every source serves the same file — the final
// checksum is what proves it. Returns the completed size, or throws so the
// caller can hand over to the next source and carry on from the same offset.
async function resume(url, part, total) {
  const offset = fs.existsSync(part) ? fs.statSync(part).size : 0;
  if (total && offset >= total) return offset;
  const ac = new AbortController();
  let stall = setTimeout(() => ac.abort(new Error(`no data for ${STALL_MS / 1000}s`)), STALL_MS);
  const out = fs.createWriteStream(part, { flags: offset ? 'a' : 'w', mode: 0o600 });
  let showedProgress = false;
  try {
    const res = await fetch(url, {
      headers: offset ? { Range: `bytes=${offset}-` } : {},
      signal: ac.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    if (offset && res.status !== 206) throw new Error('this source ignores Range, cannot resume from it');
    const range = /\/(\d+)/.exec(res.headers.get('content-range') || '');
    const size = range ? Number(range[1]) : (Number(res.headers.get('content-length')) || 0) + offset;
    const known = total || size;
    let got = 0;
    let last = 0;
    for await (const chunk of res.body) {
      clearTimeout(stall);
      stall = setTimeout(() => ac.abort(new Error(`no data for ${STALL_MS / 1000}s`)), STALL_MS);
      got += chunk.length;
      if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
      if (process.stderr.isTTY && Date.now() - last > 2000) {
        last = Date.now();
        showedProgress = true;
        const have = offset + got;
        process.stderr.write(`\rtermcp: ${(have / 1048576).toFixed(1)} MB${known ? ` ${((have / known) * 100).toFixed(0)}%` : ''}   `);
      }
    }
    if (showedProgress) process.stderr.write('\n');
    await new Promise((r, j) => out.end((e) => (e ? j(e) : r())));
    if (size && offset + got > size) throw new Error(`source sent more than the file has (${offset + got} > ${size})`);
    return offset + got;
  } catch (e) {
    if (showedProgress) process.stderr.write('\n');
    out.destroy();
    throw e;
  } finally {
    clearTimeout(stall);
  }
}

// Verify what landed against the official digest, then move it into place. The
// digest is known before the first byte is fetched unless TERMCP_SKIP_VERIFY
// allowed the download through; a digest that disagrees with the bytes is always
// a failure, because that is corruption, not a missing check.
async function verify(part, dest, sha256, total) {
  const landed = fs.statSync(part).size;
  if (total && landed !== total) throw new Error(`incomplete: ${landed}/${total} bytes`);
  if (sha256) {
    const hash = crypto.createHash('sha256');
    await new Promise((resolve, reject) => {
      fs.createReadStream(part).on('data', (d) => hash.update(d)).on('error', reject).on('end', resolve);
    });
    const got = hash.digest('hex');
    if (got !== sha256) throw new Error(`checksum mismatch (expected ${sha256.slice(0, 12)}…, got ${got.slice(0, 12)}…)`);
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.chmodSync(part, 0o755);
  fs.renameSync(part, dest);
}

// Installed versions, newest first — used to stay runnable when GitHub is
// unreachable. mtime is enough: it is whatever was downloaded last.
function installedTags() {
  const file = process.platform === 'win32' ? 'termcp.exe' : 'termcp';
  try {
    return fs.readdirSync(VERSIONS_DIR)
      .map((d) => { try { return { d, t: fs.statSync(path.join(VERSIONS_DIR, d, file)).mtimeMs }; } catch { return null; } })
      .filter(Boolean)
      .sort((a, b) => b.t - a.t)
      .map((x) => x.d);
  } catch {
    return [];
  }
}

// Which version to run: the `use` target, else the pin, else what we last
// resolved, else the newest release on the line .version is already on (or the
// one --channel named for this run). `remember` says the tag came from GitHub and
// belongs in .version — a pin and a `use` target are never written there here, so
// the caller decides.
async function resolveVersion(asset, forceTag, channel) {
  // `use <tag>` is an argument typed on the spot, so it outranks an ambient
  // TERMCP_VERSION pin. It outranks the remembered version for the same reason.
  if (forceTag) {
    const tag = normalizeTag(forceTag);
    log('version', `installing requested release ${tag}`);
    return { tag, remember: false, meta: null };
  }

  const requested = (process.env.TERMCP_VERSION || '').trim();
  if (requested && requested !== 'latest') {
    const tag = normalizeTag(requested);
    log('version', `using pinned release ${tag}`);
    return { tag, remember: false, meta: null };
  }

  if (!requested) {
    const remembered = readVersionFile();
    if (remembered) {
      const tag = normalizeTag(remembered);
      log('version', `using remembered release ${tag}`);
      return { tag, remember: false, meta: null };
    }
  }

  // No pin, or an explicit `latest`: ask GitHub for the newest release on the
  // line this is already on — or the one --channel names for this run.
  const line = channel || channelOf(readVersionFile());
  log('version', line === 'stable'
    ? 'checking GitHub for the latest release'
    : `checking GitHub for the latest ${line} release`);
  const meta = await channelMeta(asset, line);
  if (meta.tag) {
    log('version', `latest ${line} release is ${meta.tag}`);
    return { tag: meta.tag, remember: true, meta };
  }
  if (meta.empty) {
    const lines = meta.lines.length ? `; published lines: ${meta.lines.join(', ')}` : '';
    die(`no release is published on the ${line} channel${lines}`);
  }

  // Offline. Stay on something already here instead of failing: the remembered
  // version first, then whatever is installed. A network is needed only to
  // fetch a release we have never seen, and that cannot work right now anyway.
  const fallback = readVersionFile() || installedTags()[0];
  if (fallback) {
    log('version', `GitHub unreachable, staying on ${normalizeTag(fallback)}`);
    return { tag: normalizeTag(fallback), remember: false, meta: { offline: true } };
  }
  die('GitHub is unreachable and no termcp version is installed; set TERMCP_VERSION to a release you can fetch');
}

// The first real `termcp` executable on PATH, or null. On Windows only `.exe`
// can be spawned (an extensionless file is not a runnable image, and npm's
// `termcp.cmd` shim would come back here as this very wrapper).
function onPath() {
  const file = process.platform === 'win32' ? 'termcp.exe' : 'termcp';
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, file);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {}
  }
  return null;
}

// Resolve the binary, downloading the release asset on first use.
//
// forceTag makes the answer exactly that tag: `use <tag>` means "make this one
// current now", and silently falling back to the remembered version would
// report a switch that never happened. `channel` names the line for this run,
// and is undefined for a launch, which then reads it off .version.
async function binary(forceTag, channel) {
  if (process.env.TERMCP_BIN) {
    log('binary', 'using TERMCP_BIN override');
    return process.env.TERMCP_BIN;
  }
  if (process.env.TERMCP_SKIP_DOWNLOAD) {
    log('binary', 'looking for an installed termcp on PATH');
    if (process.env.TERMCP_WRAPPER_DEPTH) {
      die('the termcp on PATH is this npm wrapper itself; set TERMCP_BIN to a real binary');
    }
    const found = onPath();
    if (!found) {
      die(`TERMCP_SKIP_DOWNLOAD is set and no termcp${process.platform === 'win32' ? '.exe' : ''} on PATH; set TERMCP_BIN`);
    }
    log('binary', 'using termcp from PATH');
    return found;
  }

  const asset = assetName();
  const { tag, remember, meta: initial } = await resolveVersion(asset, forceTag, channel);
  const dest = binaryPath(tag);
  if (fs.existsSync(dest)) {
    // Already installed: no version check, no network. Still record the tag when
    // this run resolved it (first run, or an explicit `latest`), otherwise a
    // later run would fall back to the stale .version.
    if (remember) rememberVersion(tag);
    log('cache', `using installed ${tag} for ${process.platform}/${process.arch}`);
    return dest;
  }

  // Need the release's digest (and size) before fetching bytes. Without the
  // digest there is nothing to check the bytes against, and a mirror is exactly
  // the party that could hand over something else — so the download is refused
  // rather than installed on trust, unless TERMCP_SKIP_VERIFY asks for it.
  if (!(initial && initial.tag)) log('metadata', `checking release ${tag} for ${asset}`);
  const meta = initial && initial.tag ? initial : await releaseMeta(asset, tag);
  if (meta.offline && meta.status === 404) {
    die(`no such release: ${tag} (run \`termcp use latest\` to move to the newest on this line)`);
  }
  if (meta.offline) {
    if (!SKIP_VERIFY) {
      die(`cannot verify ${tag}: the GitHub API is unreachable, so there is no SHA-256 to check against (TERMCP_SKIP_VERIFY=1 installs unchecked)`);
    }
    log('metadata', `GitHub API unreachable and TERMCP_SKIP_VERIFY is set; installing ${tag} unchecked`);
  } else if (!meta.sha256) {
    if (!SKIP_VERIFY) {
      die(`cannot verify ${tag}: no SHA-256 digest is published for ${asset} (TERMCP_SKIP_VERIFY=1 installs unchecked)`);
    }
    log('metadata', `no SHA-256 digest for ${asset} and TERMCP_SKIP_VERIFY is set; installing ${tag} unchecked`);
  } else {
    log('metadata', `SHA-256 available for ${asset}${meta.size ? ` (${(meta.size / 1048576).toFixed(1)} MB)` : ''}`);
  }

  const canonical = `https://github.com/${REPO}/releases/download/${tag}/${asset}`;
  const configured = (process.env.TERMCP_MIRROR || '').split(',').map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean);
  const sources = [...(configured.length ? configured : MIRRORS).map((m) => `${m}/${canonical}`), canonical];

  const { sha256, size } = meta;
  const part = `${dest}.${process.pid}.part`;
  log('probe', `measuring ${sources.length} sources for ${tag} (${process.platform}/${process.arch})`);
  const ranked = await measureAll(sources, part);

  // Keep the winner's probed bytes; the rest is fetched from where it stopped.
  const winner = ranked[0];
  if (winner.got > 0) fs.renameSync(winner.part, part);
  for (const r of ranked) if (r.url !== winner.url) { try { fs.unlinkSync(r.part); } catch {} }

  try {
    let lastError;
    for (const [index, r] of ranked.entries()) {
      try {
        const offset = fs.existsSync(part) ? fs.statSync(part).size : 0;
        log('download', `${offset ? 'resuming' : 'starting'} from ${sourceName(r.url)} (${index + 1}/${ranked.length})${offset ? ` at ${(offset / 1048576).toFixed(1)} MB` : ''}`);
        const have = await resume(r.url, part, size);
        if (size && have < size) throw new Error(`source stopped early: ${have}/${size} bytes`);
        log('download', `received ${(have / 1048576).toFixed(1)} MB`);
        log('verify', sha256 ? 'checking file size and SHA-256' : 'checking file size only (TERMCP_SKIP_VERIFY)');
        await verify(part, dest, sha256, size);
        log('install', `installed ${tag} for ${process.platform}/${process.arch}`);
        if (remember) rememberVersion(tag);
        return dest;
      } catch (e) {
        lastError = e;
        log('download', `${sourceName(r.url)} failed: ${e.message} (${fs.existsSync(part) ? fs.statSync(part).size : 0} bytes saved)${index + 1 < ranked.length ? '; trying next source' : ''}`);
      }
    }
    throw new Error(`all ${ranked.length} sources failed (last: ${lastError && lastError.message})`);
  } finally {
    try { fs.unlinkSync(part); } catch {}
  }
}

// The wrapper's own command-line surface, taken off argv before anything else
// sees it. --channel is the only flag it owns, and both spellings are accepted:
// `--channel=rc` cannot swallow the next word by accident.
// The verb is only a verb when it leads: a positional argument must lead the
// binary too (its own parser takes the subcommand off the front), so there is no
// other place `use` could mean anything.
function takeWrapperArgs(argv) {
  const rest = [];
  let channel = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--channel') {
      channel = String(argv[++i] == null ? '' : argv[i]);
      continue;
    }
    if (arg.startsWith('--channel=')) {
      channel = arg.slice('--channel='.length);
      continue;
    }
    rest.push(arg);
  }
  const verb = rest[0] === 'use' ? rest[0] : null;
  return { argv: rest, verb, tag: verb ? rest[1] : null, channel };
}

// `use <tag>|latest [--channel C]`: make that release the one launches run, then
// exit — the binary is never started, this is the installer. Every version lands
// in versions/<tag>/, so picking one that is already there is an instant, offline
// switch; that is also how a downgrade works. Nothing is written about the
// channel: --channel decides this one resolution and is then forgotten.
// A bare `use` with no arguments shows what is running and how to move.
async function runUse({ tag, channel }) {
  if (channel !== null) channel = channel.trim().toLowerCase();
  if (tag && tag.startsWith('-')) die(`use takes a version or --channel, not ${tag}`);
  if (!tag && channel === null) {
    const current = readVersionFile();
    const line = channelOf(current);
    if (!current) {
      console.log('termcp is not installed yet (run `termcp use latest`)');
    } else {
      console.log(`termcp ${current} (channel ${line})`);
    }
    console.log('usage: termcp use <tag> | termcp use latest | termcp use --channel <name>');
    return;
  }
  if (process.env.TERMCP_BIN) die('TERMCP_BIN is set; use does not apply to an externally supplied binary');
  if (process.env.TERMCP_SKIP_DOWNLOAD) die('TERMCP_SKIP_DOWNLOAD is set; use would download nothing');
  if (channel !== null) log('channel', `resolving on the ${channel} line`);
  const explicit = !!tag && tag !== 'latest';
  // No tag means "the newest one on the channel", which is exactly what
  // TERMCP_VERSION=latest asks for; without this the resolver would answer with
  // the remembered version and report a switch it never made.
  if (!explicit) process.env.TERMCP_VERSION = 'latest';
  // A Stop from inside `binary` is already reported; anything else is a real
  // failure worth printing once.
  const bin = await binary(explicit ? tag : null, channel).catch((e) => {
    if (e instanceof Stop) throw e;
    die(e.message);
  });
  // An explicit tag is deliberately NOT remembered by binary(), so `use` — which
  // means "make this the version termcp runs from now on" — records it here.
  // The no-tag path goes through rememberVersion() inside binary().
  const installed = path.basename(path.dirname(bin));
  if (explicit) rememberVersion(installed);
  console.log(`termcp ${installed} ready at ${bin} (channel ${channel || channelOf(installed)})`);
  console.log('restart any running termcp instance to use it');
}

(async () => {
  const { argv, verb, tag, channel } = takeWrapperArgs(process.argv.slice(2));
  if (verb) return runUse({ tag, channel });
  // The binary's own parser would answer a stray `update` with a directive error
  // nobody can act on; the word people mean is `use latest`.
  if (argv[0] === 'update') die('`update` is not a command; use `termcp use latest`');
  if (channel !== null) die('--channel only applies to `termcp use --channel …`');

  // Installing here can take seconds, and a client impatient enough to kill this
  // process mid-download loses nothing: the bytes land in a .part file and
  // .version is only rewritten once the checksum verified, so the next launch
  // resumes or re-fetches and no half-installed version is ever run.
  const bin = await binary(null, null);
  log('launch', 'starting termcp');
  // The depth marker stops a PATH lookup from re-entering this wrapper.
  const depth = String((Number(process.env.TERMCP_WRAPPER_DEPTH) || 0) + 1);
  const child = spawn(bin, argv, {
    stdio: 'inherit',
    env: Object.assign({}, process.env, { TERMCP_WRAPPER_DEPTH: depth }),
  });
  child.on('error', (e) => { try { die(`cannot run ${bin}: ${e.message}`); } catch {} });
  process.exitCode = await new Promise((r) => child.on('exit', (code, sig) => r(code == null ? (sig ? 1 : 0) : code)));
})().catch((e) => {
  if (e instanceof Stop) return; // already reported, and the exit code is set
  try { die(e.message); } catch {}
});
