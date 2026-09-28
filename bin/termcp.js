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
// Env: TERMCP_VERSION (pin, or "latest" to refresh), TERMCP_BIN (use this
//      binary, skip everything), TERMCP_MIRROR (comma-separated prefixes),
//      TERMCP_DATA_DIR (termcp's data directory; defaults to ~/.termcp),
//      TERMCP_SKIP_DOWNLOAD.
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
const VERSIONS_DIR = path.join(DATA_DIR, 'versions');
const VERSION_FILE = path.join(DATA_DIR, '.version');
const REPO = 'open-mcp-ai/termcp';
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

const die = (msg) => { console.error(`termcp: ${msg}`); process.exit(1); };
const mbps = (bps) => (bps >= 1048576 ? `${(bps / 1048576).toFixed(1)} MB/s` : `${Math.round(bps / 1024)} KB/s`);

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
  } catch (e) {
    console.error(`termcp: could not write ${VERSION_FILE}: ${e.message}`);
  }
  process.env.TERMCP_VERSION = tag; // so anything we spawn sees the same pin
}

// Official metadata for one release: tag, and this asset's sha256 digest and
// size. `version` pins a release; without it the newest published one is used.
async function releaseMeta(asset, version) {
  const slug = version ? `tags/${normalizeTag(version)}` : 'latest';
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases/${slug}`, {
      headers: { 'User-Agent': 'termcp-npm' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return { offline: true };
    const release = await res.json();
    const found = (release.assets || []).find((a) => a.name === asset);
    const [algo, hex] = String((found && found.digest) || '').split(':');
    return {
      tag: release.tag_name,
      sha256: algo === 'sha256' && /^[0-9a-f]{64}$/.test(hex) ? hex : null,
      size: (found && found.size) || 0,
    };
  } catch {
    return { offline: true };
  }
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
  const results = await Promise.all(sources.map((url, i) => probe(url, `${part}.probe${i}`, { onFast, controllers })));
  results.sort((a, b) => b.got - a.got);
  const won = winner || (results[0] && results[0].url);
  for (const r of results) {
    const line = r.got > 0
      ? `${String(Math.round(r.got / 1024)).padStart(4)} KB in ${r.secs.toFixed(1)}s (${mbps(r.speed)})`
      : 'no data';
    console.error(`termcp: ${r.url === won ? '→' : ' '} ${line} ${r.url}`);
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
      if (Date.now() - last > 2000) {
        last = Date.now();
        const have = offset + got;
        process.stderr.write(`\rtermcp: ${(have / 1048576).toFixed(1)} MB${known ? ` ${((have / known) * 100).toFixed(0)}%` : ''}   `);
      }
    }
    process.stderr.write('\r');
    await new Promise((r, j) => out.end((e) => (e ? j(e) : r())));
    if (size && offset + got > size) throw new Error(`source sent more than the file has (${offset + got} > ${size})`);
    return offset + got;
  } catch (e) {
    out.destroy();
    throw e;
  } finally {
    clearTimeout(stall);
  }
}

// Verify what landed against the official digest, then move it into place.
async function verify(part, dest, sha256, total) {
  const size = fs.statSync(part).size;
  if (total && size !== total) throw new Error(`incomplete: ${size}/${total} bytes`);
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

// Which version to run: the pin, else what we last resolved, else the newest
// release. `remember` says the tag came from GitHub and belongs in .version — a
// pin is never written there.
async function resolveVersion(asset) {
  const requested = (process.env.TERMCP_VERSION || '').trim();
  if (requested && requested !== 'latest') return { tag: normalizeTag(requested), remember: false, meta: null };

  if (!requested) {
    const remembered = readVersionFile();
    if (remembered) return { tag: normalizeTag(remembered), remember: false, meta: null };
  }

  // No pin, or an explicit `latest`: ask GitHub for the newest release.
  const meta = await releaseMeta(asset);
  if (meta.tag) return { tag: meta.tag, remember: true, meta };

  // Offline. Stay on something already here instead of failing: the remembered
  // version first, then whatever is installed. A network is needed only to
  // fetch a release we have never seen, and that cannot work right now anyway.
  const fallback = readVersionFile() || installedTags()[0];
  if (fallback) {
    console.error(`termcp: GitHub unreachable, staying on ${normalizeTag(fallback)}`);
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
async function binary() {
  if (process.env.TERMCP_BIN) return process.env.TERMCP_BIN;
  if (process.env.TERMCP_SKIP_DOWNLOAD) {
    if (process.env.TERMCP_WRAPPER_DEPTH) {
      die('the termcp on PATH is this npm wrapper itself; set TERMCP_BIN to a real binary');
    }
    const found = onPath();
    if (!found) {
      die(`TERMCP_SKIP_DOWNLOAD is set and no termcp${process.platform === 'win32' ? '.exe' : ''} on PATH; set TERMCP_BIN`);
    }
    return found;
  }

  const asset = assetName();
  const { tag, remember, meta: initial } = await resolveVersion(asset);
  const dest = binaryPath(tag);
  if (fs.existsSync(dest)) {
    // Already installed: no version check, no network. Still record the tag when
    // this run resolved it (first run, or an explicit `latest`), otherwise a
    // later run would fall back to the stale .version.
    if (remember) rememberVersion(tag);
    return dest;
  }

  // Need the release's digest (and size) before fetching bytes.
  const meta = initial && initial.tag ? initial : await releaseMeta(asset, tag);
  if (meta.offline) {
    console.error(`termcp: GitHub API unreachable, downloading ${tag} unverified`);
  } else if (!meta.sha256) {
    console.error(`termcp: no digest for ${asset} in ${tag} — downloading unverified`);
  }

  const canonical = `https://github.com/${REPO}/releases/download/${tag}/${asset}`;
  const configured = (process.env.TERMCP_MIRROR || '').split(',').map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean);
  const sources = [...(configured.length ? configured : MIRRORS).map((m) => `${m}/${canonical}`), canonical];

  const { sha256, size } = meta;
  const part = `${dest}.${process.pid}.part`;
  console.error(`termcp: installing ${tag} for ${process.platform}/${process.arch}; probing ${sources.length} sources…`);
  const ranked = await measureAll(sources, part);

  // Keep the winner's probed bytes; the rest is fetched from where it stopped.
  const winner = ranked[0];
  if (winner.got > 0) fs.renameSync(winner.part, part);
  for (const r of ranked) if (r.url !== winner.url) { try { fs.unlinkSync(r.part); } catch {} }

  try {
    let lastError;
    for (const r of ranked) {
      try {
        const have = await resume(r.url, part, size);
        if (size && have < size) throw new Error(`source stopped early: ${have}/${size} bytes`);
        await verify(part, dest, sha256, size);
        if (remember) rememberVersion(tag);
        return dest;
      } catch (e) {
        lastError = e;
        console.error(`termcp: ${e.message} — ${fs.existsSync(part) ? fs.statSync(part).size : 0} bytes so far, next source`);
      }
    }
    throw new Error(`all ${ranked.length} sources failed (last: ${lastError && lastError.message})`);
  } finally {
    try { fs.unlinkSync(part); } catch {}
  }
}

(async () => {
  const bin = await binary();
  // The depth marker stops a PATH lookup from re-entering this wrapper.
  const depth = String((Number(process.env.TERMCP_WRAPPER_DEPTH) || 0) + 1);
  const child = spawn(bin, process.argv.slice(2), {
    stdio: 'inherit',
    env: Object.assign({}, process.env, { TERMCP_WRAPPER_DEPTH: depth }),
  });
  child.on('error', (e) => die(`cannot run ${bin}: ${e.message}`));
  process.exitCode = await new Promise((r) => child.on('exit', (code, sig) => r(code == null ? (sig ? 1 : 0) : code)));
})().catch((e) => die(e.message));
