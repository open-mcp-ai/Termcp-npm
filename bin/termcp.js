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
// The wrapper owns one word, `use`, and every action it can take is an option of
// that word. Everything else on the line belongs to the binary, so a command is
// recognised in one place and there is one vocabulary to learn.
//
// NOTHING here downloads. Selecting, listing, checking, tuning, pointing and
// stopping are all things a launch does not need; the thirteen megabytes belong to
// the launch that needs them, which is also what makes an offline switch and a
// downgrade work. A tag that is not on disk is still checked for existence — one
// API call, because a typo should not wait for a launch to be noticed — and an
// explicit tag already on disk costs nothing at all.
//
//   use [<tag>|latest] [--channel <name>[,<name>]]
//                  make that release the one launches run, then exit. `latest`
//                  means the newest release on the line .version is already on;
//                  --channel moves to another line for that one command, and
//                  naming several means the newest of them — a switch lands on one
//                  release, so two lines are a wider net, not an ambiguous
//                  question; a tag is any release, newer or older. Bare, it reports
//                  what launches and what is on disk, from local files only —
//                  offline, free.
//   use --bin <command> | --bin off
//                  write a launch command into `.bin` and launch THAT instead of
//                  a release: a developer's own build, a wrapper script,
//                  anything, arguments included. With no `.bin` the default flow
//                  runs, which is what `--bin off` restores. TERMCP_BIN is the
//                  same thing for one run and outranks the file.
//   use --mcp [--checkupdate]
//                  serve this wrapper's own MCP tool on stdio and launch
//                  nothing: the agent manages termcp's version itself. ONE tool,
//                  `termcp`, whose `cmd` argument is this same line — so the
//                  command line stays the only vocabulary there is to learn.
//                  --checkupdate adds nothing to the tool and everything to the
//                  prompt: the description then tells the agent to run `--check`
//                  and mention a newer release to its owner, so nobody has to ask
//                  whether an update exists.
//   use --list [--channel <name>[,<name>]]
//                  the newest release on each line, with the tag a switch would
//                  land on. Remembered for a few minutes (TERMCP_CACHE_MINUTES).
//   use --check [--force] [--channel <name>[,<name>]]
//                  is anything newer than what launches would run? One row per
//                  line asked for — else per line `.check/channel` names, else
//                  just the line in use — answered from the remembered list while
//                  it is younger than the delay (`.check/delay`, else
//                  TERMCP_CHECK_HOURS, else a day); --force spends the request
//                  anyway. Several lines at once is the point: watching rc and
//                  nightly is one question, not two.
//   use --delay <30m|6h|2d>
//                  how long `--check` may reuse a fetched list. How often to look
//                  is a rate limit, not a permission, so the agent may set it;
//                  which lines exist to look at is the reader's, so that one is a
//                  file.
//   use --kill [flags]
//                  stop the running instance: the binary's own `daemon stop`,
//                  which ends a background daemon and leaves a manually started
//                  instance alone. Whatever connects next starts the release
//                  .version selects, so this is how a switch takes effect.
//   use --rm <tag> delete one installed release. The selected one is refused.
//
// Every option refuses an argument it does not read, and --channel with no value is
// an error rather than the empty line: a word silently dropped is a different
// question answered, and `use --channel` used to install the line already in use.
// A tag and --channel together are refused too — the tag already names its line.
// `--channel` takes a list everywhere, because a list has one answer: to LOOK at
// several lines (`--check`, `--list`) it is several rows, and to SWITCH it is the
// newest of them — a switch lands on one release either way.
//
// A line is named by its tags (`v0.2.8` stable, `v0.2.8-rc.1` rc, `v0.3.0-beta.2`
// beta, `nightly-20261002` nightly), so no channel is hard-coded here and a new
// line needs no change. `.check/channel` names lines too, but only as a scope: it
// is what `--check` reports on when it is not told which lines to look at, and
// nothing is refused because of it. A switch goes where it is asked to go.
// Naming a tag is not gated either, and never was: a tag says which line it is on,
// and meaning it is the point.
//
// Nothing checks for updates on its own, and nothing records a channel for the
// version in use: `.version` holds the tag, the tag says which line it is on, and a
// launch reads it and touches no network. A version already on disk switches
// instantly and offline — which is also how a downgrade works. Which lines to LOOK
// at, and how often, are different facts, not derivable from anything, so they are
// files.
//
// Env: TERMCP_VERSION (pin, or "latest" to refresh), TERMCP_BIN (use this
//      binary, skip everything), TERMCP_MIRROR (comma-separated prefixes),
//      TERMCP_DATA_DIR (termcp's data directory; defaults to ~/.termcp),
//      TERMCP_SKIP_DOWNLOAD, TERMCP_API (GitHub API base; defaults to
//      https://api.github.com), TERMCP_SKIP_VERIFY (install a release that has
//      no digest to check against), TERMCP_CACHE_MINUTES (how long `list`
//      reuses a fetched release list; 0 asks GitHub every time),
//      TERMCP_CHECK_HOURS (how long `check` trusts that list; 0 always checks).
//
// Cache location: the data directory itself, exactly as termcp resolves it
// (config.DefaultDataDir) — $TERMCP_DATA_DIR when set, else ~/.termcp. The
// wrapper adds only `versions/<version>/termcp`, `.version`, `.bin`,
// `.releases-cache.json` and `.check/{channel,delay,lastcheck}` inside it, so
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
// A command to launch instead of a release — a local build, most of the time.
// One line, so it can be read, diffed, and set with an echo like the rest.
const BIN_FILE = path.join(DATA_DIR, '.bin');
const CACHE_FILE = path.join(DATA_DIR, '.releases-cache.json');
// What `check` watches, one fact per file: a small file is readable at a glance,
// diffable, and settable with `echo rc > .../channel` — which is also what makes
// it shared: every agent on this machine reads the same directory, where each
// one's own context would have remembered a different answer.
// What `--check` looks at when it is not told: one channel per line, blank lines
// and `#` comments ignored. It is a scope, not a permission — an empty or absent
// file means "just the line in use", and no line is refused anywhere, so nothing
// here can be widened or narrowed into a limit. `.check/delay` is the same kind of
// fact — how often to look — and has an option because it too grants nothing.
const CHECK_DIR = path.join(DATA_DIR, '.check');
const CHECK_CHANNEL = path.join(CHECK_DIR, 'channel');
const CHECK_DELAY = path.join(CHECK_DIR, 'delay');
const CHECK_LAST = path.join(CHECK_DIR, 'lastcheck');
// `stable` is the `v1.2.3` shape: a tag with no suffix. It is always allowed, so a
// machine with no `.check/channel` can still move along the line it is on, and
// `rc` has to be asked for explicitly.
const STABLE = 'stable';
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

const PROBE_MS = 5000;          // per-source measurement windowconst PROBE_BYTES = 524288;     // ...capped at this many bytes
const FAST_BYTES = 204800;      // first source to reach this wins, no waiting
const STALL_MS = 15000;         // no bytes for this long -> give up on this source
// How many tags `list --channel` prints before summarising the rest. Enough to
// pick a downgrade from, short enough not to fill a context with releases nobody
// is choosing between.
const LIST_TAGS = 20;

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
// other status is the API answering (404 = no such release). The timeout is sized
// for the biggest reply here — `releases?per_page=100` is a few hundred KB, and 8s
// was short enough that a slow link read as "GitHub is unreachable".
async function apiJSON(pathname) {
  try {
    const res = await fetch(`${API}/repos/${REPO}/${pathname}`, {
      headers: { 'User-Agent': 'termcp-npm' },
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) return { ok: false, status: res.status };
    return { ok: true, body: await res.json() };
  } catch (e) {
    // The reason belongs in the log: "unreachable" with nothing after it is the
    // message that takes an hour to chase.
    log('api', `${pathname}: ${e && e.message ? e.message : e}`);
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

// One page of the release list, drafts dropped. Every channel question is this
// one request, which is why `list` remembers it.
// ponytail: one page of 100 releases is the window these tags are read from; a
// line that has not published in 100 releases reads as empty. Paginate if such a
// line ever needs resolving.
async function fetchReleases() {
  const r = await apiJSON('releases?per_page=100');
  if (!r.ok) return { ok: false, status: r.status };
  return { ok: true, list: (Array.isArray(r.body) ? r.body : []).filter((rel) => rel && !rel.draft && rel.tag_name) };
}

// The tags a line resolves over, newest first: its own tags plus the final each of
// its pre-releases was testing — once `v0.2.8` ships, someone on `v0.2.8-rc.4` has
// nothing left to test. ONE function, so `list`, `check` and `use` cannot disagree
// about what a line contains; comparing the candidates as versions is what makes
// the final outrank its own rcs, and a hotfix on an older line cannot win by being
// published later.
// ponytail: promotion matches the numeric triple only. That covers the rc of the
// version being tested, which is the case that happens.
function lineCandidates(list, channel) {
  const tested = new Set(list
    .filter((rel) => channelOf(rel.tag_name) === channel)
    .map((rel) => versionKey(rel.tag_name))
    .filter(Boolean)
    .map((key) => key.core.join('.')));
  return list
    .filter((rel) => {
      const key = versionKey(rel.tag_name);
      return channelOf(rel.tag_name) === channel
        || (key && !key.pre.length && tested.has(key.core.join('.')));
    })
    .map((rel) => rel.tag_name)
    .sort((a, b) => compareTagNames(b, a));
}

// The newest release across several lines: each line's own newest first, so a
// final still outranks its own rcs, then whichever of those published last — the
// list is in that order already, so the first one found is the answer. Naming
// several lines is not a question to be asked back: it is one tag either way.
function pickOnLines(list, asset, channels) {
  const picks = channels.map((c) => lineCandidates(list, c)[0]).filter(Boolean);
  if (!picks.length) {
    return { empty: true, lines: [...new Set(list.map((rel) => channelOf(rel.tag_name)))].sort() };
  }
  const wanted = new Set(picks);
  return assetDigest(list.find((rel) => wanted.has(rel.tag_name)), asset);
}

// The newest release on a line, out of a list already in hand.
function pickOnLine(list, asset, channel) {
  const tags = lineCandidates(list, channel);
  if (!tags.length) {
    // Nothing on that line: the lines that do exist are what the answer can be.
    return { empty: true, lines: [...new Set(list.map((rel) => channelOf(rel.tag_name)))].sort() };
  }
  return assetDigest(list.find((rel) => rel.tag_name === tags[0]), asset);
}

// The newest release on a channel, with its digest. A switch resolves against a
// fresh list: a stale answer here would report a move that never happened.
async function channelMeta(asset, channels) {
  const r = await fetchReleases();
  if (!r.ok) return { offline: true, status: r.status };
  return pickOnLines(r.list, asset, [].concat(channels));
}

// The same list, remembered on disk. `list` reads it for a few minutes: that is
// the call an agent makes over and over, and GitHub answers 60 unauthenticated
// requests an hour per IP — a polling agent spends that in minutes. `check` reads
// the same file with a day-long window, because "is there anything newer" does
// not change minute to minute.
function cacheTTL() {
  const minutes = Number(process.env.TERMCP_CACHE_MINUTES);
  return (Number.isFinite(minutes) ? Math.max(0, minutes) : 10) * 60000;
}

// --- what `check` watches -----------------------------------------------------
// Three facts, one file each: which line to judge, how long an answer may be
// reused, and when the list was last fetched. `lastcheck` is the one piece of
// state, and it is the only place the fetch time is written — the list file holds
// the list and nothing else, so the two cannot disagree.
function readSmall(file) {
  try {
    const text = fs.readFileSync(file, 'utf8').trim();
    return text || null;
  } catch {
    return null;
  }
}
function writeSmall(file, text) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (text == null) fs.rmSync(file, { force: true });
    else fs.writeFileSync(file, text + '\n');
  } catch {}
}

// The lines `.check/channel` names: one per line, lower-cased, blank lines and
// `#` comments ignored so the file can explain itself. It is a SCOPE, not a
// permission: it says which lines `--check` reports on when it is not told, and
// nothing anywhere is refused because of it. A switch goes where it is asked to
// go — a line that has nothing published says so at the point of resolution, in
// the words of the thing that looked.
function allowedChannels() {
  const lines = (readSmall(CHECK_CHANNEL) || '')
    .split('\n')
    .map((l) => l.replace(/#.*$/, '').trim().toLowerCase())
    .filter(Boolean);
  return [...new Set(lines)].sort();
}

// A command line into words, with double quotes keeping a path that has spaces in
// it together. Not a shell: no variables, no globs, no escapes, no pipes — just
// the words, which is all a launch command needs to be.
function commandWords(line) {
  const out = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m;
  while ((m = re.exec(line))) out.push(m[1] !== undefined ? m[1] : m[2]);
  return out;
}

// "30m", "6h", "2d", or a bare number of hours. null for anything else, which is
// what makes a word like `rc` a channel rather than a delay.
const DELAY_UNITS = { m: 60000, h: 3600000, d: 86400000 };
function parseDelay(text) {
  const m = /^(\d+(?:\.\d+)?)([mhd]?)$/.exec(String(text == null ? '' : text).trim().toLowerCase());
  if (!m) return null;
  return Number(m[1]) * (DELAY_UNITS[m[2] || 'h']);
}
const delayText = (ms) => {
  const hours = ms / 3600000;
  return hours % 24 === 0 && hours >= 24 ? `${hours / 24}d` : hours >= 1 ? `${+hours.toFixed(2)}h` : `${Math.round(ms / 60000)}m`;
};

// The window `--check` may reuse an answer inside. The delay file wins, then the
// environment, then a day.
function checkWindow() {
  const watched = parseDelay(readSmall(CHECK_DELAY));
  if (watched != null) return { ms: watched, from: 'delay file' };
  const hours = Number(process.env.TERMCP_CHECK_HOURS);
  if (Number.isFinite(hours)) return { ms: Math.max(0, hours) * 3600000, from: 'TERMCP_CHECK_HOURS' };
  return { ms: 86400000, from: 'default' };
}

function lastFetched() {
  const at = Date.parse(readSmall(CHECK_LAST) || '');
  return Number.isFinite(at) ? at : 0;
}

// The release list, and when it was fetched (`.check/lastcheck`). The list file
// holds the list and nothing else, so the two cannot disagree, and a person can
// read the timestamp without parsing a few hundred KB of JSON. An older file that
// wrapped both is ignored rather than migrated: the cost is one request, once.
function readCache() {
  try {
    const list = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    if (Array.isArray(list)) return { list, at: lastFetched() };
  } catch {}
  return null;
}
function writeCache(list) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(list));
    writeSmall(CHECK_LAST, new Date().toISOString());
  } catch {}
}
async function cachedReleases() {
  const ttl = cacheTTL();
  const hit = ttl > 0 ? readCache() : null;
  if (hit && hit.at && Date.now() - hit.at < ttl) return { ok: true, list: hit.list, at: hit.at };
  const r = await fetchReleases();
  if (!r.ok) return r;
  if (ttl > 0) writeCache(r.list);
  return { ok: true, list: r.list, at: Date.now() };
}

// --- the standing check --------------------------------------------------------
// With `--checkupdate` the server keeps the shared cache warm while it runs, so
// the handshake can answer "is anything newer" by reading a file. It is the same
// cache `use --check` reads and writes, behind the same window, so the two cannot
// disagree and GitHub is asked at most once per window.
//
// NEVER ON THE HANDSHAKE'S PATH. A client waits for that reply, and a check that
// takes twenty seconds is a client that times out; the verdict is read from disk,
// and this loop is what puts it there.
async function refreshUpdateCache() {
  try {
    const { ms } = checkWindow();
    const hit = readCache();
    if (hit && hit.at && Date.now() - hit.at < ms) return; // still inside the window
    const r = await fetchReleases();
    if (r.ok) writeCache(r.list);
  } catch {
    // A server that cannot reach GitHub still serves; the next tick tries again.
  }
}

// One tick per window: the first at startup (from the cache when it is fresh), the
// next when that answer goes stale. A window of 0 means "ask every time", which
// for a background loop becomes a one-minute floor rather than a spin.
function scheduleChecks() {
  const { ms } = checkWindow();
  const timer = setTimeout(async () => {
    await refreshUpdateCache();
    scheduleChecks();
  }, Math.max(ms, 60000));
  // A client that closes stdin must still end this process: a pending timer is not
  // a reason to stay alive.
  if (timer.unref) timer.unref();
}

// What the handshake says about updates, from files only — never a request. Null
// when there is nothing to say (no `--checkupdate`, or a cache that cannot be read).
function updateNote() {
  try {
    const hit = readCache();
    if (!hit) return 'update: no check has run yet.';
    const when = `checked ${ageOf(hit.at)}`;
    const current = readVersionFile();
    if (!current) return `update: nothing is selected yet (${when}).`;
    const tag = normalizeTag(current);
    const line = channelOf(tag);
    const pick = pickOnLine(hit.list, assetName(), line);
    if (!pick.tag) return `update: nothing is published on ${line} (${when}).`;
    return compareTagNames(pick.tag, tag) > 0
      ? `update: ${pick.tag} is newer on ${line} than the current ${tag} (${when}).`
      : `update: ${tag} is the newest on ${line} (${when}).`;
  } catch {
    return null;
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
    log('version', `using requested release ${tag}`);
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
  // line this is already on — or the ones --channel names for this run.
  const lines = [].concat(channel && channel.length ? channel : channelOf(readVersionFile()));
  log('version', lines.join(' and ') === 'stable'
    ? 'checking GitHub for the latest release'
    : `checking GitHub for the latest ${lines.join(' or ')} release`);
  const meta = await channelMeta(asset, lines);
  if (meta.tag) {
    log('version', `latest ${lines.join(' or ')} release is ${meta.tag}`);
    return { tag: meta.tag, remember: true, meta };
  }
  if (meta.empty) {
    const lines_ = meta.lines.length ? `; published lines: ${meta.lines.join(', ')}` : '';
    die(`no release is published on the ${lines.join(' or ')} channel${lines_}`);
  }

  // Offline. Stay on something already here instead of failing: the remembered
  // version first, then whatever is installed. A network is needed only to
  // fetch a release we have never seen, and that cannot work right now anyway.
  const fallback = readVersionFile() || installedTags()[0];
  if (fallback) {
    // A status means the API answered and refused (its 60/hour, usually) — a
    // different problem from no network, and worth saying which one it is.
    const why = meta.status ? `GitHub answered ${meta.status}` : 'GitHub unreachable';
    log('version', `${why}, staying on ${normalizeTag(fallback)}`);
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
// What a launch runs when it is not a release. TERMCP_BIN is one path for one
// run, and outranks the file; `.bin` is the remembered one and may be a command
// line, which is what makes a local build reachable: `bin go run ./cmd`.
function launchOverride() {
  const pinned = (process.env.TERMCP_BIN || '').trim();
  if (pinned) return { cmd: pinned, args: [], from: 'TERMCP_BIN' };
  const line = readSmall(BIN_FILE);
  if (!line) return null;
  const words = commandWords(line);
  if (!words.length) return null;
  return { cmd: words[0], args: words.slice(1), from: '.bin' };
}

// What a launch runs, as a command plus its arguments: a release is one path with
// no arguments, an override may be a whole command line. Every door goes through
// here, so `kill` stops the instance that was started the same way a launch would
// have started it.
async function launchSpec(forceTag, channel) {
  const override = launchOverride();
  if (override) {
    log('binary', `using ${override.from}: ${[override.cmd].concat(override.args).join(' ')}`);
    return override;
  }
  return { cmd: await binary(forceTag, channel), args: [], from: 'release' };
}

async function binary(forceTag, channel) {
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
  // Every probe file goes, including the winner's when it brought nothing: the
  // comparison is against the file that was KEPT, not against the winner's URL, so
  // a probe that produced no bytes cannot leave an empty `.probeN` behind.
  const winner = ranked[0];
  const keep = winner.got > 0 ? winner.part : null;
  if (keep) fs.renameSync(keep, part);
  for (const r of ranked) if (r.part !== keep) { try { fs.unlinkSync(r.part); } catch {} }

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
// sees it. --channel and --mcp are the only flags it owns, and both spellings of
// --channel are accepted: `--channel=rc` cannot swallow the next word by accident.
// The verb is only a verb when it leads: a positional argument must lead the
// binary too (its own parser takes the subcommand off the front), so there is no
// other place `use` could mean anything.
// The wrapper owns one word, and every action is an option of it. Two modes on one
// line is two requests; there is no rule for combining them, so it is refused
// rather than resolved by precedence.
const USE_MODES = {
  '--bin': 'bin',
  '--mcp': 'mcp',
  '--list': 'list',
  '--check': 'check',
  '--delay': 'delay',
  '--kill': 'kill',
  '--rm': 'rm',
};
const isMode = (word) => Object.prototype.hasOwnProperty.call(USE_MODES, word);

// `use …` in, `{ mode, argv }` out. A leading `use` is what the command line always
// has and the MCP tool may omit, so it is dropped when present — the same one line
// for both doors rather than a rule each caller has to remember.
//
// `--bin` owns the rest of the line: a launch command is a command line, and
// `--port 19000` inside one belongs to the command, not to this parser.
function parseUse(argv) {
  const rest = argv[0] === 'use' ? argv.slice(1) : argv.slice();
  const at = rest.findIndex(isMode);
  if (at < 0) {
    if (rest.includes('--checkupdate')) die(CHECKUPDATE_ONLY);
    return { mode: 'select', argv: rest };
  }
  if (at !== 0) die(`${rest[at]} must come first; ${rest[0]} is part of a different request`);
  const mode = USE_MODES[rest[at]];
  if (mode === 'bin') return { mode, argv: rest.slice(1) };
  const args = rest.slice(1);
  const other = args.find(isMode);
  if (other) die(`${rest[at]} and ${other} are two different requests; one at a time`);
  if (mode !== 'mcp' && args.includes('--checkupdate')) die(CHECKUPDATE_ONLY);
  // `--channel` is read by three options and no others. Everywhere else it used to
  // be forwarded to the binary, which answered "unknown arguments" only after
  // resolving and possibly downloading a release — a refusal that costs a download.
  const reads = mode === 'list' || mode === 'check' || mode === 'select';
  if (!reads && args.some((a) => a === '--channel' || a.startsWith('--channel='))) die(CHANNEL_ONLY);
  return { mode, argv: args };
}
const CHANNEL_ONLY = '`--channel` only applies to `use`, `use --list` and `use --check`';
const CHECKUPDATE_ONLY = '`--checkupdate` only applies to `use --mcp`; there it adds a prompt to check for a newer release';

// `--channel <name>[,<name>…]` off the front of a mode's arguments, and nothing
// else: a flag with no value used to become the empty line, which every reader
// then treated as "no --channel at all" — `use --channel` resolved the current
// line and installed it, and `--list --channel` listed everything. Silently
// answering a different question is worse than refusing.
//
// Several names are allowed because a list has one answer either way: several lines
// can be LOOKED at (`--check`, `--list`), and a switch takes the newest of them —
// it lands on one release no matter how many lines were named.
function takeChannel(argv) {
  const rest = [];
  const channels = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    let value = null;
    if (arg === '--channel') value = argv[++i];
    else if (arg.startsWith('--channel=')) value = arg.slice('--channel='.length);
    else { rest.push(arg); continue; }
    const names = String(value == null ? '' : value)
      .split(',').map((n) => n.trim().toLowerCase()).filter(Boolean);
    if (!names.length) die('--channel needs a line name (e.g. --channel rc)');
    channels.push(...names);
  }
  return { argv: rest, channels: [...new Set(channels)] };
}

// `use <tag>|latest [--channel C]`: make that release the one launches run, then
// exit — the binary is never started, and neither is a download: this selects, it
// does not install. Every version lands in versions/<tag>/, so picking one that is
// already there is an instant, offline switch; that is also how a downgrade works.
// Nothing is written about the channel: --channel decides this one resolution and
// is then forgotten. A bare `use` with no arguments shows what is selected and how
// to move.
//
// Returns the report instead of printing it, because the same call answers the
// MCP tool, whose stdout is the protocol and can hold nothing else.
async function selectLines(argv) {
  const { argv: words, channels } = takeChannel(argv);
  const tag = words[0] || null;
  if (words.length > 1) die(`use takes one version, not ${words[1]}`);
  if (tag && tag.startsWith('-')) die(`use takes a version or --channel, not ${tag}`);
  if (!tag && !channels.length) return statusLines();
  const channel = channels.length ? channels : null;
  if (process.env.TERMCP_BIN) die('TERMCP_BIN is set; use does not apply to an externally supplied binary');
  if (launchOverride()) die('a launch command is set; `use --bin off` goes back to releases before `use` means anything');
  if (process.env.TERMCP_SKIP_DOWNLOAD) die('TERMCP_SKIP_DOWNLOAD is set; use would download nothing');
  if (channel) log('channel', `resolving on the ${channel.join(' or ')} line`);
  const explicit = !!tag && tag !== 'latest';
  // The tag already names its line, so a --channel beside one is either a
  // misunderstanding or a typo — and echoing it back ("v0.2.3 (channel rc)" for a
  // stable tag) would confirm the misunderstanding instead of fixing it. Refused
  // here, before the download, so nothing is installed on the way to the error.
  if (explicit && channel) die(`--channel applies to \`use latest\`, not to ${tag}: a tag already names its line (${channelOf(normalizeTag(tag))})`);
  // No tag means "the newest one on the channel", which is exactly what
  // TERMCP_VERSION=latest asks for; without this the resolver would answer with
  // the remembered version and report a switch it never made.
  if (!explicit) process.env.TERMCP_VERSION = 'latest';
  // `use` SELECTS; it does not install. What a launch runs is one line in
  // `.version`, so the command that only says WHICH bytes has no business fetching
  // them — thirteen megabytes belong to the launch that needs them. A tag already
  // on disk costs nothing at all: no request, no network, which is also what makes
  // an offline switch and a downgrade work.
  const asset = assetName();
  const resolved = await resolveVersion(asset, explicit ? tag : null, channel).catch((e) => {
    if (e instanceof Stop) throw e;
    die(e.message);
  });
  const chosen = resolved.tag;
  const dest = binaryPath(chosen);
  const here = fs.existsSync(dest);
  // A tag that is not here yet is checked for existence, because a typo would
  // otherwise stay silent until a launch said only "no such release" — in a
  // client's log, to whoever is not the person who typed it. One API call, not a
  // download, and an API that cannot answer is not held against the tag: deciding
  // whether the bytes are really there is the launch's problem, not this one's.
  if (!here) {
    const meta = resolved.meta && resolved.meta.tag ? resolved.meta : await releaseMeta(asset, chosen);
    if (meta.offline && meta.status === 404) {
      die(`no such release: ${chosen} (\`termcp use --list\` shows what is published)`);
    }
  }
  rememberVersion(chosen);
  return [
    `termcp ${chosen} selected (channel ${channel ? channel.join(' or ') : channelOf(chosen)})`,
    here ? `already installed at ${dest}` : 'not on disk yet; the next launch installs it',
    'a running instance keeps the old binary until it is stopped and started again',
  ];
}

// --- the MCP tool ------------------------------------------------------------
// `--mcp` serves this wrapper over stdio as ONE tool, `termcp`, whose `cmd`
// argument is a word from the surface above — so the command line stays the only
// vocabulary, and the tool list stays one entry long. stdout is the protocol
// channel: every tool answers with text, every log goes to stderr, and a refused
// command comes back as isError instead of ending the process.
// Two MCP servers can be mounted side by side, and they are not the same thing:
// termcp's own serves `term` — run a command — while this one serves `use`, named
// after the one word it recognises. So a call reads like the line it is:
// `use(cmd: "--list")` is `termcp use --list`. Nothing here invents a second
// vocabulary, or a second name for a word the command line already has.
const MCP_TOOL = 'use';
const MCP_PROTOCOL = '2025-06-18'; // echoed back when the client does not name one
const MCP_USAGE = 'empty for what launches and what is on disk | <tag>|latest [--channel <name>[,<name>]] | '
  + '--list [--channel <name>[,<name>]] | --check [--force] [--channel <name>[,<name>]] | '
  + '--delay <30m|6h|2d|default> | --bin <command>|off | --kill [daemon flags] | --rm <tag>';

// What the agent is told. The tool description is the command space; the
// instructions are the standing order, and --checkupdate is the whole of what it
// adds: a server that tells the agent to go look for a newer release and say so,
// so the owner is told without having asked.
const MCP_INSTRUCTIONS = 'Manages which termcp release launches run: what is selected, which line that is, '
  + 'and moving between releases. It never starts termcp. Every action is an option of `use`, the one '
  + 'word this tool and the command line share.';
// `--checkupdate` is the standing check, and it costs the agent nothing: the
// server keeps the shared cache warm while it runs, and the handshake states what
// the file says. It does not add a tool, and it does not ask anyone to make a call.
const MCP_CHECKUPDATE = ' This server also checks for newer releases in the background while it runs, and '
  + 'states what it found — in the handshake, in this description, and on the end of a tool result when the '
  + 'command did not already answer it. So nothing here asks you to spend a call asking. If it names a newer '
  + 'release, tell the user and let them decide; do not switch unless they ask. `use --check --force` '
  + 'asks GitHub now, and `use --delay <30m|6h|2d>` sets how long an answer may be reused.';

const mcpTools = (checkUpdate, note) => [{
  name: MCP_TOOL,
  description:
    'Manage which termcp release launches run. `cmd` is the same line the CLI takes, minus the leading '
    + '`use` (both are accepted): empty reports what launches, which line that is, and what is installed; '
    + '`<tag>|latest [--channel <name>[,<name>]]` selects it — a tag may be older, so this '
    + 'downgrades as well as upgrades, and several lines means the newest release on any of them. '
    + 'Selecting does not download: the bytes arrive on the next launch. '
    + '`--list [--channel <name>[,<name>]]` gives the newest release on each line, or '
    + 'the named lines\' tags newest first; `--check [--force] [--channel <name>[,<name>]]` asks whether '
    + 'anything is newer, one row per line named (else per line the channel file names, else just the '
    + 'line in use), answered from a list fetched within the delay unless --force; `--delay '
    + '<30m|6h|2d|default>` sets how long that answer may be reused; `--bin <command>|off` launches that '
    + 'command instead of any release — a developer\'s own build, arguments included — and `off` restores '
    + 'the default flow; `--kill [daemon flags]` stops the running instance, so a client that reconnects '
    + 'starts the selected release; `--rm <tag>` deletes an installed release, refusing the selected one.'
    // The tool list is the other half of what the agent sees at connect time, so the
    // standing verdict belongs here too: an agent that reads the tool and never
    // re-reads the handshake still learns there is a newer release.
    + (checkUpdate ? MCP_CHECKUPDATE + (note ? ' ' + note : '') : ''),
  inputSchema: {
    type: 'object',
    properties: { cmd: { type: 'string', description: `The same line the command line takes: ${MCP_USAGE}` } },
    additionalProperties: false,
  },
}];

// What launches run, and what is on disk — read from local files, so an agent may
// ask as often as it likes without spending a request. An override is reported
// first and unmistakably: it is the answer to "what would run", and a status line
// that named the selected release instead would be describing something else.
function statusLines() {
  const override = launchOverride();
  const current = readVersionFile();
  const installed = installedTags();
  const lines = [];
  if (override) {
    lines.push(`launching: ${[override.cmd].concat(override.args).join(' ')} (${override.from}; no release is used)`);
  }
  if (!current) {
    lines.push('current: nothing selected (the next launch installs the newest stable release)');
  } else {
    lines.push(`current: ${current} (channel ${channelOf(current)})`);
    if (!installed.includes(normalizeTag(current))) lines.push(`note: ${current} is not on disk; the next launch installs it`);
  }
  // What `--check` reports on when it is not told: the line in use, plus whatever
  // the file adds. A scope, not a permission — nothing is refused because of it,
  // so this is the whole of what it decides.
  const extra = allowedChannels();
  const scope = [current ? channelOf(current) : STABLE].concat(extra).filter((c, i, a) => a.indexOf(c) === i);
  lines.push(`checking: ${scope.join(', ')}${extra.length
    ? ` (from ${CHECK_CHANNEL})`
    : ' (`use --check --channel <name>[,<name>]` or ' + CHECK_CHANNEL + ' adds more)'}`);
  lines.push(installed.length ? `installed: ${installed.join(', ')}` : 'installed: none');
  return lines;
}

// `--bin`: run something other than a release — a build from the checkout next
// door, a wrapper script, anything. The point is a developer being able to say
// `use --bin go run ./cmd` once and have every client and agent on this machine
// launch that, instead of each one remembering it or each MCP config setting an
// env var that a tool call can never reach.
//
// Asking with no command reports instead of clearing: nothing here is destroyed by
// a question, and the word that clears has to be said on purpose.
function binLines(argv) {
  const words = argv.map((a) => String(a).trim()).filter(Boolean);
  if (!words.length) return binStatus();
  if (words.length === 1 && ['off', 'none', 'clear', '-'].includes(words[0])) {
    writeSmall(BIN_FILE, null);
    return ['launching: the selected release again'].concat(binStatus());
  }
  // A word with a space in it — `C:\Program Files\nodejs\node.exe` — has to be
  // quoted on the way in: the stored line is split again on the way out, and
  // without the quotes the launcher is handed `C:\Program` and reports a typo in
  // the path that is not one. A quote inside a word has no representation here, so
  // it is refused rather than stored in a form that would not read back.
  const bad = words.find((w) => w.includes('"'));
  if (bad) die(`--bin cannot store a word containing a quote: ${bad}`);
  const command = words.map((w) => (/\s/.test(w) ? `"${w}"` : w)).join(' ');
  const parsed = commandWords(command);
  if (!parsed.length) die('--bin needs a command');
  // A command spelled as a path is checked, because a typo there is silent until
  // some later launch says only "cannot run" — in a client's log, to whoever is
  // not the person who typed it. A bare name is left alone: whether it resolves
  // depends on the PATH of whoever launches, which is not this process's to judge.
  const head = parsed[0];
  if ((head.includes('/') || head.includes('\\')) && !fs.existsSync(head)) {
    // The likeliest reason a path is not there is that it was cut in half at a
    // space, so the fix is named alongside the failure instead of left to be
    // guessed — the words around it are already lost by this point.
    die(`no such file: ${head} (a path with a space in it needs quotes)`);
  }
  writeSmall(BIN_FILE, command);
  return binStatus();
}

function binStatus() {
  const override = launchOverride();
  const lines = [];
  if (!override) {
    lines.push('launching: the selected release (no command is set)');
  } else {
    lines.push(`launching: ${[override.cmd].concat(override.args).join(' ')} (from ${override.from})`);
    if (override.from === '.bin') lines.push(`remembered in ${BIN_FILE}; \`use --bin off\` goes back to releases`);
    else lines.push('TERMCP_BIN outranks .bin for this process');
  }
  if (override) lines.push('switching and removing releases still work, but no release is launched while this is set');
  return lines;
}

const ageOf = (at) => {
  const minutes = Math.round((Date.now() - at) / 60000);
  if (minutes < 1) return 'just now';
  return minutes < 120 ? `${minutes} min ago` : `${Math.round(minutes / 60)} h ago`;
};

// `check [--channel C]`: is there anything newer than what launches would run? The
// one question nobody wants to answer with a request every time — an agent may ask
// per turn, and GitHub gives an IP 60 an hour.
//
// Without --channel it judges the line `.version` is already on, because a newer
// rc is not an update to a stable install. With it, it judges the line named —
// "is there something newer on rc" is a question about another line, and the
// answer says so rather than pretending it is an upgrade.
//
// The answer is remembered for a day (TERMCP_CHECK_HOURS) and a repeat inside that
// window answers from disk, saying how old it is. `force` spends the request
// anyway: that is the agent deciding it cares now, which is the one judgement this
// side cannot make for it. A cache too old to trust is not an answer, so it is
// fetched; and a fetch that fails while a cache exists still answers, marked.
// `--check [--force]`: is there anything newer than what launches would run, on
// every line the reader allowed? The one question nobody wants to answer with a
// request every time — an agent may ask per turn, and GitHub gives an IP 60 an
// hour.
//
// It reports one row per line asked for rather than asking about one, because
// watching several lines is the whole point: `.check/channel` is the default set,
// and `--channel rc,nightly` says so for one call. The line in use is always
// reported too, even when it is not named: it is what is running, and leaving it
// out would answer a narrower question than the one asked. A tag that is not a
// published release is said to be exactly that rather than "up to date", which
// would be an answer to something else.
//
// The answer is remembered for the delay (`.check/delay`, else
// TERMCP_CHECK_HOURS, else a day) and a repeat inside that window answers from
// disk, saying how old it is. `force` spends the request anyway: that is the agent
// deciding it cares now, which is the one judgement this side cannot make for it.
// A cache too old to trust is not an answer, so it is fetched; and a fetch that
// fails while a cache exists still answers, marked.
async function checkLines({ argv, channels }) {
  const stray = argv.find((a) => a !== '--force' && a !== '-f');
  if (stray) die(`--check takes --force and --channel, not ${stray}`);
  const force = argv.length > 0;
  const current = readVersionFile();
  if (!current) return ['current: nothing selected (the first launch installs the newest stable release)'];
  const tag = normalizeTag(current);
  const mine = channelOf(tag);

  const { ms: window, from } = checkWindow();
  const hit = readCache();
  let list = null;
  let at = 0;
  let fromCache = false;
  if (!force && window > 0 && hit && hit.at && Date.now() - hit.at < window) {
    ({ list, at } = hit);
    fromCache = true;
  } else {
    const r = await fetchReleases();
    if (r.ok) {
      writeCache(r.list);
      list = r.list;
      at = Date.now();
    } else if (hit) {
      ({ list, at } = hit); // a stale answer beats no answer, as long as it says so
      fromCache = true;
    } else {
      die(r.status ? `GitHub answered ${r.status}; try again later` : 'GitHub is unreachable; try again later');
    }
  }

  const lines = [`current: ${tag} (channel ${mine})`];
  // A launch command means no release is running, so every verdict below is about
  // the selection and not about what a launch would do. Saying so is the
  // difference between an answer and a plausible-looking wrong one.
  const override = launchOverride();
  if (override) lines.push(`note: launches run ${[override.cmd].concat(override.args).join(' ')} (${override.from}), not any release`);
  const known = list.some((rel) => rel.tag_name === tag);
  if (!known) lines.push(`note: ${tag} is not a published release — a local build, or one that was withdrawn`);
  // Which lines to report on: the ones named, else the ones the file names, else
  // just the line in use. A file that says nothing is not a rule, and the line you
  // are standing on is always worth a verdict.
  const wanted = channels.length ? channels : allowedChannels();
  const shown = [mine].concat(wanted.filter((c) => c !== mine));
  const width = Math.max(...shown.map((c) => c.length));
  let behind = false;
  for (const line of shown) {
    const pick = pickOnLine(list, assetName(), line);
    const where = line === mine ? '  <- current line' : '';
    if (pick.empty) { lines.push(`  ${line.padEnd(width)}  nothing published${where}`); continue; }
    // Only the line in use can be "behind": a newer tag on a line nobody is
    // running is not an update to anything. It is not "up to date" either —
    // comparing a tag on one line with a tag on another compares two unrelated
    // names — so every other line gets a newest tag and no verdict.
    const newer = compareTagNames(pick.tag, tag) > 0;
    if (newer && line === mine) behind = true;
    const verdict = line !== mine
      ? `newest: ${pick.tag}`
      : pick.tag === tag || !newer
        ? `up to date (${pick.tag})`
        : `newer: ${pick.tag} — switch with \`use ${pick.tag}\``;
    lines.push(`  ${line.padEnd(width)}  ${verdict}${where}`);
  }
  if (behind) lines.push('a running instance keeps the old binary until it is stopped and started again');
  lines.push(fromCache
    ? `checked ${ageOf(at)} (\`use --check --force\` asks GitHub now; the window is ${delayText(window)} from ${from})`
    : 'checked just now');
  return lines;
}

// `--delay`: how long `--check` may reuse a fetched list. It decides how often to
// look, which is a rate limit and not a permission, so it is an option like every
// other thing this wrapper can be told to do.
function delayLines(argv) {
  const words = argv.map((a) => String(a).trim()).filter(Boolean);
  if (!words.length) return delayStatus();
  if (words.length > 1) die(`--delay takes one interval, not ${words[1]}`);
  const word = words[0];
  if (word === 'off' || word === 'none' || word === 'default' || word === '-') {
    writeSmall(CHECK_DELAY, null);
    return ['reuse window: the default again'].concat(delayStatus());
  }
  const ms = parseDelay(word);
  if (ms == null) die(`--delay takes an interval like 30m, 6h or 2d, not ${word}`);
  writeSmall(CHECK_DELAY, delayText(ms));
  return delayStatus();
}

function delayStatus() {
  const { ms, from } = checkWindow();
  const at = lastFetched();
  const lines = [`reuse window: ${delayText(ms)}${from === 'delay file' ? '' : ` (from ${from})`}`];
  if (at) {
    const due = at + ms - Date.now();
    lines.push(`last fetch: ${ageOf(at)}; ${due > 0 ? `next check may reuse it for another ${delayText(due)}` : 'a check now would ask GitHub'}`);
  } else {
    lines.push('last fetch: never — a check now asks GitHub');
  }
  return lines;
}

// Every line that has published a release, with the tag a switch would land on —
// or, given a line, its tags newest first, so a caller can filter for itself
// instead of asking this side to guess which release it wants.
// Same pickOnLine the switch uses, so the list cannot promise one release and the
// switch install another.
async function listLines({ argv: words, channels: asked }) {
  if (words.length) die(`--list takes --channel <name>, not ${words[0]}`);
  const asset = assetName();
  const r = await cachedReleases();
  if (!r.ok) die(r.status ? `GitHub answered ${r.status}; try again later` : 'GitHub is unreachable; try again later');
  const channels = [...new Set(r.list.map((rel) => channelOf(rel.tag_name)))].sort();
  if (!channels.length) die('no release is published');
  const current = readVersionFile();
  const mine = channelOf(current);
  if (asked.length) {
    const lines = [];
    for (const wanted of asked) {
      const tags = lineCandidates(r.list, wanted);
      if (!tags.length) die(`no release is published on the ${wanted} line (published lines: ${channels.join(', ')})`);
      const pick = pickOnLine(r.list, asset, wanted);
      lines.push(`${wanted} line, newest first (fetched ${ageOf(r.at)}):`);
      for (const t of tags.slice(0, LIST_TAGS)) {
        lines.push(`  ${t}${t === pick.tag ? '  <- newest on this line' : ''}${channelOf(t) === wanted ? '' : ' (final)'}${t === normalizeTag(current) ? '  <- current' : ''}`);
      }
      if (tags.length > LIST_TAGS) lines.push(`  … and ${tags.length - LIST_TAGS} more`);
    }
    lines.push('switch with `use <tag>`');
    return lines;
  }
  const width = Math.max(...channels.map((c) => c.length));
  const lines = [`newest release on each line (fetched ${ageOf(r.at)}):`];
  for (const channel of channels) {
    const pick = pickOnLine(r.list, asset, channel);
    if (!pick.tag) continue;
    lines.push(`  ${channel.padEnd(width)}  ${pick.tag}${channel === mine ? '  <- current line' : ''}`);
  }
  lines.push('switch with `use <tag>`, or `use latest` for the newest on the current line');
  lines.push('`list --channel <name>[,<name>]` gives one line\'s tags, newest first');
  return lines;
}

// `kill`: the binary's own `daemon stop`, run as a command rather than re-asked
// over HTTP here — it knows the port, the credential, and the difference between
// a daemon and a manually started instance, and says so in the same words it
// would if you typed it. The instance that stops is the one a client is talking
// to, so the connection drops; reconnecting starts the selected release.
// What is on disk to run, without fetching anything. A launch may install; a
// command that only STOPS something may not — an instance that is running was
// started from a binary that is already here, so a missing one means nothing was
// started. Fetching thirteen megabytes to tell a process it does not exist would
// be this layer doing work nobody asked for.
function installedSpec() {
  const override = launchOverride();
  if (override) {
    log('binary', `using ${override.from}: ${[override.cmd].concat(override.args).join(' ')}`);
    return override;
  }
  const tag = readVersionFile();
  if (!tag) die('nothing is selected, so no release instance was started');
  const dest = binaryPath(normalizeTag(tag));
  if (!fs.existsSync(dest)) {
    die(`${normalizeTag(tag)} is not installed, so no instance was started from it (a launch installs it)`);
  }
  return { cmd: dest, args: [], from: 'release' };
}

// `--kill [flags]`: the binary's own `daemon stop`, run as a command rather than
// re-asked over HTTP here — it knows the port, the credential, and the difference
// between a daemon and a manually started instance, and says so in the same words
// it would if you typed it. The instance that stops is the one a client is talking
// to, so the connection drops; reconnecting starts the selected release.
async function killLines(args) {
  // The rest of the line belongs to `daemon stop` — its host, port and credential
  // are the ones that decide which instance is addressed.
  const spec = installedSpec();
  const { code, out } = await run(spec.cmd, spec.args.concat(['daemon', 'stop'], args));
  const said = out.trim();
  if (code !== 0) die(said || `daemon stop exited ${code}`);
  return [
    said || 'termcp daemon: no output',
    `a client that reconnects starts ${readVersionFile() || 'the newest stable release'}`,
  ];
}

// `--rm <tag>`: delete one installed release. Only a tag that is really in
// versions/ can be named — the list comes from the directory itself, so nothing
// outside it is reachable by spelling. The selected release is refused: removing
// it would leave .version naming a binary that is not there, and the next launch
// would quietly download it again.
function rmLines(args) {
  const installed = installedTags();
  const want = String(args[0] || '').trim();
  if (args.length > 1) die(`--rm takes one version, not ${args[1]}`);
  const have = installed.length ? `installed: ${installed.join(', ')}` : 'nothing is installed';
  if (!want) die(`--rm takes a version (${have})`);
  const tag = installed.find((t) => t === want || t === normalizeTag(want));
  if (!tag) die(`${normalizeTag(want)} is not installed (${have})`);
  const current = readVersionFile();
  if (current && normalizeTag(current) === tag) die(`${tag} is the selected version; switch to another one first`);
  try {
    fs.rmSync(path.join(VERSIONS_DIR, tag), { recursive: true, force: true });
  } catch (e) {
    // Windows refuses to unlink a running image: an instance started from this
    // version is still holding it. Nothing is broken, so say what to do.
    die(`cannot remove ${tag}: ${e.message} (an instance started from it is probably still running; \`kill\` it first)`);
  }
  const left = installedTags();
  return [`removed ${tag}`, left.length ? `installed: ${left.join(', ')}` : 'installed: none'];
}

// Run one command of the surface above and return its lines. Nothing here prints:
// the CLI prints the lines, the MCP tool returns them as the tool's text.
// One command line, from either door, into lines of text. Nothing here prints:
// the CLI prints, the MCP tool returns them as the tool's text. `--mcp` is the one
// option that does not answer and return — it replaces the process with a server —
// so the callers deal with it and this refuses it.
async function runUse(argv) {
  const { mode, argv: args } = parseUse(argv);
  if (mode === 'mcp') die('`--mcp` starts the server; it is not something to ask for over one');
  if (mode === 'bin') return binLines(args);
  if (mode === 'delay') return delayLines(args);
  if (mode === 'list') return listLines(takeChannel(args));
  if (mode === 'check') return checkLines(takeChannel(args));
  if (mode === 'rm') return rmLines(args);
  if (mode === 'kill') return killLines(args);
  return selectLines(args);
}

// A child's whole output, for the one command whose answer is another process's.
// spawn can fail synchronously (Windows answers a file that is not an image with
// EINVAL), so the call itself is guarded, not just the error event.
function run(bin, args) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      return resolve({ code: 1, out: `cannot run ${bin}: ${e.message}\n` });
    }
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('error', (e) => resolve({ code: 1, out: `${out}cannot run ${bin}: ${e.message}\n` }));
    child.on('exit', (code) => resolve({ code: code == null ? 1 : code, out }));
  });
}

// A tool result, plus the standing verdict when the command did not already give
// it. `--check` and `--list` answer the update question themselves, so the tag they
// already printed is the marker: the note is for every other call, where the answer
// would otherwise wait for the next handshake. The words match the handshake's — a
// second prefix would read as a second kind of statement.
function withUpdateNote(lines, checkUpdate) {
  if (!checkUpdate) return lines; // a plain server says nothing about releases
  const note = updateNote();
  const newer = /^update: (\S+) is newer /.exec(note);
  if (!newer) return lines; // nothing newer, or nothing known yet: stay quiet
  if (lines.join('\n').includes(newer[1])) return lines;
  return lines.concat(note);
}

// The stdio loop: newline-delimited JSON-RPC 2.0, no SDK — the handshake, one
// tool, and nothing else is a dependency this package would pay for on every
// `npx`. Frames are handled in order (a switch and a kill must not interleave),
// notifications are never answered, and stdin closing ends the server.
function serveMcp({ checkUpdate }) {
  let pkg = { version: '0.0.0' };
  try { pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')); } catch {}
  let queue = Promise.resolve(); // one call at a time: a switch and a kill must not interleave
  // Built per request, not once at startup: the update sentence is what the files
  // say NOW, and a frozen copy would answer with yesterday's verdict for a server
  // that runs all day.
  const toolsNow = () => mcpTools(checkUpdate, checkUpdate ? updateNote() : null);
  if (checkUpdate) {
    // The standing check: ask once now (from the cache when it is fresh), then
    // once per window, so a long session notices a release published mid-session
    // without any agent spending a call on it.
    refreshUpdateCache();
    scheduleChecks();
  }
  const write = (msg) => { try { process.stdout.write(JSON.stringify(msg) + '\n'); } catch {} };
  const reply = (id, result) => write({ jsonrpc: '2.0', id, result });
  const fail = (id, code, message) => write({ jsonrpc: '2.0', id, error: { code, message } });

  async function call(id, params) {
    if (!params || params.name !== MCP_TOOL) return fail(id, -32602, `unknown tool: ${params && params.name}`);
    const cmd = params.arguments && params.arguments.cmd;
    if (cmd != null && typeof cmd !== 'string') return fail(id, -32602, 'cmd must be a string');
    try {
      // The same one word the command line has, split with quotes honoured — there
      // is no shell on this door, and a path with a space in it only survives that
      // way. A leading `use` is what a caller will type; without it the rest reads
      // as its arguments, so both forms reach the same parser rather than this door
      // having a grammar of its own.
      // The handshake and the tool description carry the standing verdict, but a
      // check can land after both — and the only other door into an agent's context
      // is a tool result. So a result that has not already answered the question
      // gets one line. It reads the same file: no request, no waiting.
      const lines = await runUse(commandWords(String(cmd == null ? '' : cmd)));
      reply(id, { content: [{ type: 'text', text: withUpdateNote(lines, checkUpdate).join('\n') }] });
    } catch (e) {
      // die() has already written the reason to stderr; the caller gets it as a
      // tool result, and the server stays up — a refusal is not a crash.
      reply(id, { content: [{ type: 'text', text: e && e.message ? e.message : String(e) }], isError: true });
    } finally {
      process.exitCode = 0; // die() set it for the CLI; this process is still alive
    }
  }

  function frame(line) {
    let msg;
    try { msg = JSON.parse(line); } catch { return fail(null, -32700, 'parse error'); }
    const method = msg && msg.method;
    if (typeof method !== 'string') return fail(msg && msg.id, -32600, 'invalid request');
    if (msg.id === undefined || msg.id === null) return; // a notification owes no answer
    const { id } = msg;
    if (method === 'initialize') {
      return reply(id, {
        protocolVersion: (msg.params && msg.params.protocolVersion) || MCP_PROTOCOL,
        capabilities: { tools: {} },
        serverInfo: { name: 'termcp-wrapper', version: pkg.version },
        instructions: MCP_INSTRUCTIONS + (checkUpdate
          ? MCP_CHECKUPDATE + (() => { const note = updateNote(); return note ? ' ' + note : ''; })()
          : ''),
      });
    }
    if (method === 'ping') return reply(id, {});
    if (method === 'tools/list') return reply(id, { tools: toolsNow() });
    if (method === 'tools/call') { queue = queue.then(() => call(id, msg.params)).catch(() => {}); return; }
    return fail(id, -32601, `method not found: ${method}`);
  }

  let buffer = '';
  log('mcp', `serving the termcp tool on stdio${checkUpdate ? ' with checkupdate' : ''}`);
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line) frame(line);
    }
  });
}

(async () => {
  const raw = process.argv.slice(2);
  // One word is the wrapper's; everything else is the binary's. `use` is the only
  // thing taken before launching, so a command line that is not about managing
  // termcp behaves exactly as if this wrapper were not here — including one the
  // binary does not know, which is the binary's to refuse and not this layer's to
  // reinterpret.
  if (raw[0] !== 'use') return launch(raw);
  const { mode, argv } = parseUse(raw);
  if (mode === 'mcp') {
    // Serving replaces this process, so nothing else on the line may be read as
    // an argument: `use --mcp <tag>` would be a release nobody can act on.
    if (argv.some((w) => w !== '--checkupdate')) die('`use --mcp` takes --checkupdate and nothing else; name a release in the tool call');
    return serveMcp({ checkUpdate: argv.includes('--checkupdate') });
  }
  for (const line of await runUse(raw)) console.log(line);
})().catch((e) => {
  if (e instanceof Stop) return; // already reported, and the exit code is set
  try { die(e.message); } catch {}
});

async function launch(argv) {
  // Installing here can take seconds, and a client impatient enough to kill this
  // process mid-download loses nothing: the bytes land in a .part file and
  // .version is only rewritten once the checksum verified, so the next launch
  // resumes or re-fetches and no half-installed version is ever run.
  const spec = await launchSpec(null, null);
  log('launch', 'starting termcp');
  // The depth marker stops a PATH lookup from re-entering this wrapper.
  const depth = String((Number(process.env.TERMCP_WRAPPER_DEPTH) || 0) + 1);
  const child = spawn(spec.cmd, spec.args.concat(argv), {
    stdio: 'inherit',
    env: Object.assign({}, process.env, { TERMCP_WRAPPER_DEPTH: depth }),
  });
  child.on('error', (e) => { try { die(`cannot run ${spec.cmd}: ${e.message}`); } catch {} });
  process.exitCode = await new Promise((r) => child.on('exit', (code, sig) => r(code == null ? (sig ? 1 : 0) : code)));
}
