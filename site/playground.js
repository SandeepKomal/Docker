// In-browser playground: a modelled Docker engine with one fault per
// scenario. Visitors type docker commands to find and fix the fault and
// watch the containers, networks and image layers change. Nothing here
// talks to a real Docker daemon.
//
// The simulator (DQSim) has no DOM access so tests/check_playground.js can
// drive it under Node; the UI below it only renders what the simulator says.
"use strict";

(function (root) {
  const kB = 1e3, MB = 1e6, GB = 1e9, MiB = 1048576;
  const HOME = "/home/dev";
  const START = Date.UTC(2026, 9, 30, 9, 0, 0);

  // --- small helpers -----------------------------------------------------------

  // Sizes the way the docker CLI prints them: three significant digits, decimal units.
  function human(n) {
    const u = ["B", "kB", "MB", "GB", "TB"];
    let i = 0;
    while (n >= 1000 && i < 4) { n /= 1000; i++; }
    return `${Number(n.toPrecision(3))}${u[i]}`;
  }
  // BuildKit progress prints two decimals.
  function bytes2(n) {
    if (n < 1000) return `${Math.round(n)}B`;
    const u = ["kB", "MB", "GB"];
    let i = -1;
    while (n >= 1000 && i < 2) { n /= 1000; i++; }
    return `${n.toFixed(2)}${u[i]}`;
  }
  // Byte sizes for flags like --memory 512m (binary units, as Docker reads them).
  function parseBytes(v) {
    const m = /^(\d+(?:\.\d+)?)\s*([bkmgt]?)i?b?$/i.exec(String(v || ""));
    if (!m) return null;
    return Math.round(parseFloat(m[1]) * 1024 ** "bkmgt".indexOf((m[2] || "b").toLowerCase()));
  }
  // Like go-units HumanDuration, which docker ps uses.
  function duration(ms) {
    const s = Math.floor(ms / 1000);
    if (s < 1) return "Less than a second";
    if (s === 1) return "1 second";
    if (s < 60) return `${s} seconds`;
    const m = Math.floor(s / 60);
    if (m === 1) return "About a minute";
    if (m < 60) return `${m} minutes`;
    const h = Math.round(s / 3600);
    if (h === 1) return "About an hour";
    if (h < 48) return `${h} hours`;
    if (h < 24 * 14) return `${Math.floor(h / 24)} days`;
    if (h < 24 * 60) return `${Math.floor(h / 24 / 7)} weeks`;
    return `${Math.floor(h / 24 / 30)} months`;
  }
  const iso = (ms) => new Date(ms).toISOString().replace(/\.(\d{3})Z$/, ".$1000000Z");
  const stamp = (ms) => new Date(ms).toISOString().slice(0, 19).replace("T", " ").replace(/-/g, "/");
  function hash(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }
  // A stable 64-hex id for any string, so the same build gives the same image ID.
  function hexOf(str) {
    let x = hash(str) || 1, s = "";
    while (s.length < 64) {
      x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0;
      s += x.toString(16).padStart(8, "0");
    }
    return s;
  }

  // Split a command line like bash: quotes, &&, ||, ;, | and > redirects.
  function lex(line) {
    const out = [];
    let cur = "", q = null, has = false;
    const push = () => { if (cur || has) out.push({ w: cur }); cur = ""; has = false; };
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (q) {
        if (ch === q) q = null;
        else if (ch === "\\" && q === '"' && /["\\$`]/.test(line[i + 1] || "")) cur += line[++i];
        else cur += ch;
      } else if (ch === "'" || ch === '"') { q = ch; has = true; }
      else if (ch === "\\" && i + 1 < line.length) cur += line[++i];
      else if (/\s/.test(ch)) push();
      else if ((ch === "&" || ch === "|") && line[i + 1] === ch) { push(); out.push({ op: ch + ch }); i++; }
      else if (ch === ";" || ch === "|") { push(); out.push({ op: ch }); }
      else if (ch === ">") { push(); if (line[i + 1] === ">") { out.push({ op: ">>" }); i++; } else out.push({ op: ">" }); }
      else cur += ch;
    }
    if (q) return null;
    push();
    return out;
  }
  const words = (s) => (lex(s) || []).filter((t) => "w" in t).map((t) => t.w);

  // Paths
  function norm(p) {
    const parts = [];
    for (const s of String(p).split("/")) {
      if (!s || s === ".") continue;
      if (s === "..") parts.pop(); else parts.push(s);
    }
    return "/" + parts.join("/");
  }
  const join = (a, b) => (String(b).startsWith("/") ? norm(b) : norm(a + "/" + b));
  const inside = (p, d) => p === d || p.startsWith(d === "/" ? "/" : d + "/");
  function kids(fs, d) {
    const pre = d === "/" ? "/" : d + "/";
    const set = new Set();
    for (const p of Object.keys(fs)) if (p.startsWith(pre) && p !== d) set.add(p.slice(pre.length).split("/")[0]);
    return [...set].sort();
  }
  const under = (fs, d) => Object.keys(fs).filter((p) => inside(p, d));
  const entrySize = (e) => (e.dir ? e.size || 0 : e.size != null ? e.size : (e.text || "").length);
  const sizeUnder = (fs, d) => under(fs, d).reduce((n, p) => n + entrySize(fs[p]), 0);
  function stat(fs, p) {
    if (fs[p]) return fs[p];
    if (p === "/" || kids(fs, p).length) return { dir: true, uid: 0, gid: 0, mode: 0o755 };
    return null;
  }
  // Whether uid:gid may create files in a directory.
  function canWrite(st, uid, gid) {
    if (uid === 0) return true;
    const mode = st.mode == null ? 0o755 : st.mode;
    if (st.uid === uid) return Boolean(mode & 0o200);
    if (st.gid === gid) return Boolean(mode & 0o020);
    return Boolean(mode & 0o002);
  }
  function modeString(st) {
    const m = st.mode == null ? (st.dir ? 0o755 : 0o644) : st.mode;
    let s = st.dir ? "d" : "-";
    for (let shift = 6; shift >= 0; shift -= 3) {
      const b = (m >> shift) & 7;
      s += (b & 4 ? "r" : "-") + (b & 2 ? "w" : "-") + (b & 1 ? "x" : "-");
    }
    if (m & 0o1000) s = s.slice(0, 9) + (s[9] === "x" ? "t" : "T");
    return s;
  }

  // Columns the way docker's tabwriter lays them out: three spaces apart.
  function table(rows) {
    const w = rows[0].map((_, i) => Math.max(...rows.map((r) => String(r[i]).length)));
    return rows.map((r) => r.map((c, i) => (i === r.length - 1 ? String(c) : String(c).padEnd(w[i] + 3))).join("").trimEnd());
  }

  // Flags: "d|detach rm" are booleans, "name p|publish" take a value.
  function flagSpec(bools, vals, multi) {
    const spec = { bool: {}, val: {}, multi: new Set((multi || "").split(" ").filter(Boolean)) };
    for (const [list, into] of [[bools, spec.bool], [vals, spec.val]]) {
      for (const item of list.split(" ").filter(Boolean)) {
        const names = item.split("|");
        for (const n of names) into[n] = names[names.length - 1];
      }
    }
    return spec;
  }
  function parseFlags(args, spec, stopAtPositional) {
    const out = { flags: {}, pos: [] };
    const set = (k, v) => { if (spec.multi.has(k)) (out.flags[k] = out.flags[k] || []).push(v); else out.flags[k] = v; };
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (stopAtPositional && out.pos.length) { out.pos.push(a); continue; }
      if (a === "--") { out.pos.push(...args.slice(i + 1)); break; }
      if (a.startsWith("--")) {
        const eq = a.indexOf("=");
        const name = eq > 0 ? a.slice(2, eq) : a.slice(2);
        if (spec.val[name]) {
          const v = eq > 0 ? a.slice(eq + 1) : args[++i];
          if (v === undefined) return { error: `flag needs an argument: --${name}` };
          set(spec.val[name], v);
        } else if (spec.bool[name]) set(spec.bool[name], eq > 0 ? a.slice(eq + 1) !== "false" : true);
        else return { error: `unknown flag: --${name}` };
      } else if (a.startsWith("-") && a.length > 1) {
        for (let j = 1; j < a.length; j++) {
          const ch = a[j];
          if (spec.val[ch]) {
            let v = a.slice(j + 1).replace(/^=/, "");
            if (!v) v = args[++i];
            if (v === undefined) return { error: `flag needs an argument: '${ch}' in -${ch}` };
            set(spec.val[ch], v);
            break;
          }
          if (!spec.bool[ch]) return { error: `unknown shorthand flag: '${ch}' in ${a}` };
          set(spec.bool[ch], true);
        }
      } else out.pos.push(a);
    }
    return out;
  }

  // --- images in the registry --------------------------------------------------

  const NGINX_PAGE = ["<!DOCTYPE html>", "<html>", "<head>", "<title>Welcome to nginx!</title>", "<style>", "html { color-scheme: light dark; }",
    "body { width: 35em; margin: 0 auto;", "font-family: Tahoma, Verdana, Arial, sans-serif; }", "</style>", "</head>", "<body>",
    "<h1>Welcome to nginx!</h1>", "<p>If you see this page, the nginx web server is successfully installed and",
    "working. Further configuration is required.</p>", "", "<p>For online documentation and support please refer to",
    '<a href="http://nginx.org/">nginx.org</a>.<br/>', "Commercial support is available at", '<a href="http://nginx.com/">nginx.com</a>.</p>',
    "", "<p><em>Thank you for using nginx.</em></p>", "</body>", "</html>"].join("\n");
  const BINS = {
    alpine: ["sh", "ash", "ls", "cat", "echo", "id", "env", "printenv", "whoami", "hostname", "ping", "nslookup", "wget", "sleep", "true", "false", "mkdir", "chown", "chmod", "rm", "touch"],
    debian: ["sh", "bash", "ls", "cat", "echo", "id", "env", "printenv", "whoami", "hostname", "curl", "sleep", "true", "false", "mkdir", "chown", "chmod", "rm", "touch"]
  };
  const D = (uid = 0, mode = 0o755) => ({ dir: true, uid, gid: uid, mode });
  const BASE_FS = { "/bin": D(), "/etc": D(), "/home": D(), "/root": D(0, 0o700), "/tmp": D(0, 0o1777), "/usr": D(), "/var": D() };
  const nodeImage = (size, os, rootfs) => ({
    size, os, bins: ["node", "npm", "npx", "yarn"], users: { node: [1000, 1000] }, env: ["NODE_VERSION=22.11.0", "YARN_VERSION=1.22.22"],
    entrypoint: ["docker-entrypoint.sh"], cmd: ["node"], fs: { "/home/node": D(1000), "/usr/local/bin/node": { size: 118 * MB } },
    hist: [[rootfs, 0.5], ["RUN /bin/sh -c groupadd --gid 1000 node && useradd --uid 1000 --gid node --shell /bin/bash --create-home node # buildkit", 0.002],
      ["ENV NODE_VERSION=22.11.0", 0], ["RUN /bin/sh -c ARCH= && dpkgArch=\"$(dpkg --print-architecture)\" && curl -fsSLO --compressed \"https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-linux-$ARCH.tar.xz\" # buildkit", null],
      ["ENV YARN_VERSION=1.22.22", 0], ["RUN /bin/sh -c set -ex && curl -fsSLO --compressed \"https://yarnpkg.com/downloads/$YARN_VERSION/yarn-v$YARN_VERSION.tar.gz\" # buildkit", 0.004],
      ["COPY docker-entrypoint.sh /usr/local/bin/ # buildkit", 0], ['ENTRYPOINT ["docker-entrypoint.sh"]', 0], ['CMD ["node"]', 0]]
  });
  const BASES = {
    "node:22": nodeImage(1.12 * GB, "debian", "# debian.sh --arch 'amd64' out/ 'bookworm' '@1729555200'"),
    "node:22-slim": nodeImage(240 * MB, "debian", "# debian.sh --arch 'amd64' out/ 'bookworm' '@1729555200' (slim)"),
    "node:22-alpine": nodeImage(160 * MB, "alpine", "ADD alpine-minirootfs-3.20.3-x86_64.tar.gz / # buildkit"),
    "nginx:1.27": {
      size: 192 * MB, os: "debian", bins: ["nginx"], users: { nginx: [101, 101] }, env: ["NGINX_VERSION=1.27.3"], expose: [80], stop: "SIGQUIT",
      entrypoint: ["/docker-entrypoint.sh"], cmd: ["nginx", "-g", "daemon off;"],
      fs: { "/usr/share/nginx/html": D(), "/usr/share/nginx/html/index.html": { text: NGINX_PAGE }, "/usr/share/nginx/html/50x.html": { size: 497 }, "/etc/nginx/nginx.conf": { size: 644 } },
      hist: [["# debian.sh --arch 'amd64' out/ 'bookworm' '@1729555200'", 0.4], ["ENV NGINX_VERSION=1.27.3", 0], ["RUN /bin/sh -c set -x && groupadd --system --gid 101 nginx && useradd --system --gid nginx --no-create-home nginx && apt-get update # buildkit", null],
        ["COPY docker-entrypoint.sh / # buildkit", 0], ['ENTRYPOINT ["/docker-entrypoint.sh"]', 0], ["EXPOSE map[80/tcp:{}]", 0], ["STOPSIGNAL SIGQUIT", 0], ['CMD ["nginx" "-g" "daemon off;"]', 0]]
    },
    "alpine:3.20": { size: 7.8 * MB, os: "alpine", bins: [], cmd: ["/bin/sh"], hist: [["ADD alpine-minirootfs-3.20.3-x86_64.tar.gz / # buildkit", null], ['CMD ["/bin/sh"]', 0]] },
    "ubuntu:24.04": { size: 78.1 * MB, os: "debian", bins: [], cmd: ["/bin/bash"], hist: [["ADD file:7486147a645d8835a5181c79f00a3606c6b714c83bcbfcd8862221eb14690f9e in / ", null], ['CMD ["/bin/bash"]', 0]] },
    "redis:7.4": {
      size: 117 * MB, os: "debian", bins: ["redis-server", "redis-cli"], users: { redis: [999, 999] }, expose: [6379], entrypoint: ["docker-entrypoint.sh"], cmd: ["redis-server"],
      fs: { "/data": D(999) },
      hist: [["# debian.sh --arch 'amd64' out/ 'bookworm' '@1729555200'", 0.6], ["RUN /bin/sh -c set -eux; groupadd -r -g 999 redis; useradd -r -g redis -u 999 redis # buildkit", 0], ["ENV REDIS_VERSION=7.4.1", 0],
        ["RUN /bin/sh -c set -eux; apt-get update; apt-get install -y --no-install-recommends ca-certificates wget dpkg-dev gcc make # buildkit", null],
        ['ENTRYPOINT ["docker-entrypoint.sh"]', 0], ["EXPOSE map[6379/tcp:{}]", 0], ['CMD ["redis-server"]', 0]]
    }
  };
  const ALIASES = {
    "nginx:latest": "nginx:1.27", "node:latest": "node:22", "node:lts": "node:22", "node:22-bookworm": "node:22",
    "node:22-bookworm-slim": "node:22-slim", "alpine:latest": "alpine:3.20", "ubuntu:latest": "ubuntu:24.04", "redis:latest": "redis:7.4"
  };
  const normRef = (ref) => {
    let r = String(ref).replace(/^docker\.io\//, "").replace(/^library\//, "");
    if (!/:[^/]+$/.test(r) && !r.includes("@")) r += ":latest";
    return r;
  };
  const fullRef = (ref) => `docker.io/${ref.includes("/") ? "" : "library/"}${ref}`;

  // --- what programs do when they run ------------------------------------------

  const nodeTrace = (lines) => [...lines, "", "Node.js v22.11.0"];
  const APPS = {
    nginx: { port: 80, stopCode: 0, body: NGINX_PAGE, start: (x) => ({ logs: [`${stamp(x.e.now)} [notice] 1#1: using the "epoll" event method`, `${stamp(x.e.now)} [notice] 1#1: nginx/1.27.3`, `${stamp(x.e.now)} [notice] 1#1: start worker processes`] }) },
    redis: { port: 6379, stopCode: 0, start: () => ({ logs: ["1:M 30 Oct 2026 09:00:00.000 * Server initialized", "1:M 30 Oct 2026 09:00:00.000 * Ready to accept connections tcp"] }) },
    shop: { port: 3000, body: "shop: ok", start: (x) => x.module("express") || { logs: ["shop: listening on :3000"] } },
    api: {
      port: 8080, body: "api: ok (redis: PONG)",
      start(x) {
        const host = x.env.REDIS_HOST || "cache";
        const missing = x.module("ioredis");
        if (missing) return missing;
        const logs = [`api: connecting to redis at ${host}:6379`];
        const r = x.e.resolve(x.c, host);
        if (!r) return { code: 1, logs: nodeTrace([...logs, `Error: getaddrinfo ENOTFOUND ${host}`, "    at GetAddrInfoReqWrap.onlookupall [as oncomplete] (node:dns:120:26) {", "  errno: -3008,", "  code: 'ENOTFOUND',", "  syscall: 'getaddrinfo',", `  hostname: '${host}'`, "}"]) };
        if (!r.target || !r.target.proc.listens.includes(6379)) return { code: 1, logs: nodeTrace([...logs, `Error: connect ECONNREFUSED ${r.ip}:6379`, "    at TCPConnectWrap.afterConnect [as oncomplete] (node:net:1615:16)"]) };
        return { logs: [...logs, "api: redis says PONG", "api: listening on :8080"], via: r.via };
      }
    },
    uploader: {
      port: 8080, body: "uploader: ok",
      start(x) {
        const missing = x.module("busboy");
        if (missing) return missing;
        const dir = "/data/uploads";
        const st = stat(x.view, dir);
        const logs = [`uploader: storing files in ${dir}`];
        if (st && canWrite(st, x.uid, x.gid)) return { logs: [...logs, "uploader: listening on :8080"] };
        return { code: 1, logs: nodeTrace([...logs, "node:internal/fs/utils:351", "    throw err;", "    ^", "", `Error: ${st ? "EACCES: permission denied" : "ENOENT: no such file or directory"}, open '${dir}/.write-test'`, "    at Object.openSync (node:fs:573:18)", "    at Object.writeFileSync (node:fs:2348:35) {", `  errno: ${st ? -13 : -2},`, `  code: '${st ? "EACCES" : "ENOENT"}',`, "  syscall: 'open',", `  path: '${dir}/.write-test'`, "}"]) };
      }
    },
    report: {
      port: 8080, body: "report: ok",
      start(x) {
        const missing = x.module("csv-parse");
        if (missing) return missing;
        const logs = ["report: starting", "report: loading 1.2M rows into memory"];
        if (x.c.memory && x.c.memory < 300 * MB) return x.c.oomKillDisable ? { logs, hung: true } : { code: 137, oom: true, logs };
        return { logs: [...logs, "report: 1.2M rows loaded (296 MB)", "report: serving on :8080"] };
      }
    }
  };
  const NGINX_ENTRY = ["/docker-entrypoint.sh: /docker-entrypoint.d/ is not empty, will attempt to perform configuration", "/docker-entrypoint.sh: Looking for shell scripts in /docker-entrypoint.d/",
    "/docker-entrypoint.sh: Launching /docker-entrypoint.d/10-listen-on-ipv6-by-default.sh", "/docker-entrypoint.sh: Configuration complete; ready for start up"];
  const OCI = (bin) => `failed to create task for container: failed to create shim task: OCI runtime create failed: runc create failed: unable to start container process: error during container init: exec: "${bin}": executable file not found in $PATH: unknown`;

  // --- Dockerfiles -------------------------------------------------------------

  const INSTRUCTIONS = ["FROM", "RUN", "CMD", "LABEL", "MAINTAINER", "EXPOSE", "ENV", "ADD", "COPY", "ENTRYPOINT", "VOLUME", "USER", "WORKDIR", "ARG", "ONBUILD", "STOPSIGNAL", "HEALTHCHECK", "SHELL"];
  function parseDockerfile(text) {
    const out = [];
    let buf = null, start = 0;
    const lines = String(text).split(/\r?\n/);
    const finish = () => {
      const m = /^\s*(\S+)\s*([\s\S]*)$/.exec(buf);
      buf = null;
      const name = m[1].toUpperCase();
      if (!INSTRUCTIONS.includes(name)) return `dockerfile parse error on line ${start}: unknown instruction: ${m[1]}`;
      const raw = m[2].trim();
      out.push({ line: start, name, raw, text: `${name} ${raw}` });
      return null;
    };
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      if (/^\s*#/.test(l) || (buf === null && !l.trim())) continue;
      const cont = /\\\s*$/.test(l);
      const part = cont ? l.replace(/\\\s*$/, "") : l;
      if (buf === null) { buf = part; start = i + 1; } else buf += " " + part.trim();
      if (!cont) { const err = finish(); if (err) return { error: err }; }
    }
    if (buf !== null && buf.trim()) { const err = finish(); if (err) return { error: err }; }
    return { instrs: out };
  }
  // Exec form ["a", "b"] or shell form.
  function argvOf(raw) {
    if (raw.startsWith("[")) {
      try { const a = JSON.parse(raw); if (Array.isArray(a)) return a.map(String); } catch { /* shell form after all */ }
    }
    return ["/bin/sh", "-c", raw];
  }
  // Leading --flags of COPY, ADD and RUN.
  function instrFlags(raw) {
    const flags = {};
    let rest = raw;
    for (let m; (m = /^--([\w-]+)(?:=(\S*))?\s+/.exec(rest));) { flags[m[1]] = m[2] === undefined ? true : m[2]; rest = rest.slice(m[0].length); }
    return { flags, rest };
  }
  function globRe(p) {
    return new RegExp("^" + p.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*\/?/g, "\u0000").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]").replace(/\u0000/g, ".*") + "$");
  }
  // .dockerignore: patterns from the context root; the last match wins; ! re-includes.
  function ignoredBy(patterns) {
    const rules = patterns.map((p) => {
      const neg = p.startsWith("!");
      const clean = (neg ? p.slice(1) : p).trim().replace(/^\.?\//, "").replace(/\/+$/, "");
      return { neg, re: globRe(clean) };
    }).filter((r) => r.re.source !== "^$");
    return (rel) => {
      let hit = false;
      const parts = rel.split("/");
      for (const r of rules) {
        for (let i = 1; i <= parts.length; i++) if (r.re.test(parts.slice(0, i).join("/"))) { hit = !r.neg; break; }
      }
      return hit;
    };
  }

  // --- the engine ----------------------------------------------------------------

  class Engine {
    constructor(scenario) {
      this.scenario = scenario;
      this.now = START - 16 * 24 * 3600e3;
      this.cwd = HOME;
      this.images = {};
      this.tags = {};
      this.containers = [];
      this.volumes = {};
      this.networks = {};
      this.cache = new Map();
      this.lastBuild = null;
      this.netCount = 0;
      this.host = { "/home": D(), [HOME]: D(1000), "/srv": D(), "/tmp": D(0, 0o1777), "/etc": D() };
      for (const [p, e] of Object.entries(scenario.files || {})) this.host[p] = { uid: 1000, gid: 1000, mode: e.dir ? 0o755 : 0o644, v: 0, ...e };
      this.addNetwork("bridge", "bridge", "172.17.0.0/16");
      this.addNetwork("host", "host");
      this.addNetwork("none", "null");
      this.now = START;
      this.ready = false;
      for (const step of scenario.setup || []) {
        if (typeof step === "number") this.now += step * 60e3;
        else shell(this, step);
      }
      this.lastBuild = null;
      this.ready = true;
    }

    tick(ms) { this.now += ms; }
    id(seed) { return hexOf(`${this.scenario.id}|${seed}|${this.now}|${this.containers.length}|${Object.keys(this.images).length}`); }

    addNetwork(name, driver, subnet) {
      const user = driver === "bridge" && name !== "bridge";
      const n = this.netCount++;
      this.networks[name] = {
        name, driver, user, id: hexOf(`net|${name}|${this.scenario.id}`), created: this.now,
        subnet: subnet || (user ? `172.${17 + n - 2}.0.0/16` : null), next: 2
      };
      return this.networks[name];
    }

    // Registry images, made once per engine.
    registry(ref) {
      const r = normRef(ref);
      const key = ALIASES[r] || r;
      const b = BASES[key];
      if (!b) return null;
      this.bases = this.bases || {};
      if (this.bases[key]) return this.bases[key];
      const created = START - 16 * 24 * 3600e3;
      const known = b.hist.reduce((n, [, f]) => n + (f || 0) * b.size, 0);
      const layers = b.hist.map(([by, f], i) => ({
        id: f === 0 ? null : hexOf(`layer|${key}|${i}`), size: f === null ? b.size - known : Math.round((f || 0) * b.size), by, created,
        comment: /^# debian|^ADD file/.test(by) ? "debuerreotype 0.15" : "buildkit.dockerfile.v0"
      }));
      const img = {
        id: hexOf(`image|${key}`), digest: hexOf(`digest|${key}`), created, layers, os: b.os,
        bins: new Set([...BINS[b.os], ...b.bins]), users: { root: [0, 0], ...(b.users || {}) },
        fs: { ...BASE_FS, ...(b.fs || {}) },
        config: { Env: ["PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", ...(b.env || [])], Cmd: b.cmd, Entrypoint: b.entrypoint || null, WorkingDir: "", User: "", ExposedPorts: b.expose || [], StopSignal: b.stop || null }
      };
      this.bases[key] = img;
      return img;
    }
    imageSize(img) { return img.layers.reduce((n, l) => n + l.size, 0); }
    tagsOf(img) { return Object.keys(this.tags).filter((t) => this.tags[t] === img.id); }

    // A local image by tag, full or short ID.
    image(ref) {
      if (!ref) return null;
      const r = normRef(ref);
      if (this.tags[r]) return this.images[this.tags[r]];
      const id = String(ref).replace(/^sha256:/, "");
      if (/^[0-9a-f]{4,64}$/.test(id)) return Object.values(this.images).find((i) => i.id.startsWith(id)) || null;
      return null;
    }
    tag(ref, img) {
      const r = normRef(ref);
      const old = this.tags[r];
      this.tags[r] = img.id;
      this.images[img.id] = img;
    }
    pullLines(ref) {
      const r = normRef(ref);
      const img = this.registry(r);
      const [repo, tag] = r.split(":");
      if (!img) {
        const known = Object.keys(BASES).some((k) => k.startsWith(repo + ":"));
        return { error: known ? `manifest for ${r} not found: manifest unknown: manifest unknown`
          : `pull access denied for ${repo}, repository does not exist or may require 'docker login': denied: requested access to the resource is denied` };
      }
      const had = this.tags[r] === img.id;
      const lines = [`${tag}: Pulling from ${repo.includes("/") ? repo : "library/" + repo}`];
      if (!had) for (const l of img.layers.filter((x) => x.id)) lines.push(`${l.id.slice(0, 12)}: Pull complete`);
      lines.push(`Digest: sha256:${img.digest}`, `Status: ${had ? "Image is up to date" : "Downloaded newer image"} for ${r}`, fullRef(r));
      this.tag(r, img);
      return { lines };
    }

    container(name) {
      if (!name) return null;
      const n = String(name).replace(/^\//, "");
      return this.containers.find((c) => c.name === n) || (n.length >= 3 && /^[0-9a-f]+$/.test(n) ? this.containers.find((c) => c.id.startsWith(n)) : null) || null;
    }
    running(c) { return c.state === "running"; }

    // What a container sees at each path: the image, then its mounts on top.
    view(c) {
      const img = this.images[c.imageId];
      const fs = { ...img.fs };
      for (const m of [...c.mounts].sort((a, b) => a.dest.length - b.dest.length)) {
        for (const p of under(fs, m.dest)) delete fs[p];
        if (m.type === "tmpfs") { fs[m.dest] = D(0, 0o1777); continue; }
        const src = m.type === "bind" ? this.host : this.volumes[m.name].fs;
        const rootPath = m.type === "bind" ? m.source : "/";
        fs[m.dest] = m.type === "bind" ? stat(this.host, m.source) || D() : this.volumes[m.name].root;
        for (const p of under(src, rootPath)) if (p !== rootPath) fs[m.dest + p.slice(rootPath === "/" ? 0 : rootPath.length)] = src[p];
      }
      return fs;
    }

    userOf(c) {
      const img = this.images[c.imageId];
      const spec = c.user || img.config.User || "root";
      const [u, g] = spec.split(":");
      const known = img.users[u];
      if (/^\d+$/.test(u)) return { uid: Number(u), gid: g ? Number(g) : known ? known[1] : Number(u), name: Object.keys(img.users).find((k) => img.users[k][0] === Number(u)) };
      if (!known) return { error: `unable to find user ${u}: no matching entries in passwd file` };
      return { uid: known[0], gid: g ? Number(g) : known[1], name: u };
    }

    // Resolve a hostname from inside a container, as Docker's DNS and /etc/hosts would.
    resolve(c, name) {
      if (/^\d+\.\d+\.\d+\.\d+$/.test(name)) {
        const target = this.containers.find((o) => this.running(o) && Object.values(o.nets).some((n) => n.ip === name));
        return { ip: name, via: "ip", target };
      }
      if (name === "localhost" || name === c.hostname) return { ip: "127.0.0.1", via: "self", target: c };
      const link = c.links[name] && this.container(c.links[name]);
      if (link && this.running(link) && link.nets.bridge && link.nets.bridge.ip) return { ip: link.nets.bridge.ip, via: "link", target: link };
      for (const net of Object.keys(c.nets)) {
        if (!this.networks[net] || !this.networks[net].user) continue;
        for (const o of this.containers) {
          if (!this.running(o) || !o.nets[net] || !o.nets[net].ip) continue;
          if (o.name === name || o.nets[net].aliases.includes(name) || (name.length >= 12 && o.id.startsWith(name))) return { ip: o.nets[net].ip, via: "dns", target: o };
        }
      }
      return null;
    }

    // An HTTP request: from your machine (c null) or from inside a container.
    http(c, url) {
      const m = /^(?:(https?):\/\/)?([^/:\s]+)(?::(\d+))?(\/\S*)?$/.exec(url || "");
      if (!m) return { code: 3, text: `curl: (3) URL rejected: Malformed input to a URL function` };
      const host = m[2], port = Number(m[3] || (m[1] === "https" ? 443 : 80));
      const refused = (h) => ({ code: 7, text: `curl: (7) Failed to connect to ${h} port ${port} after 0 ms: Couldn't connect to server` });
      let target, cport = port;
      if (!c && /^(localhost|127\.0\.0\.1|0\.0\.0\.0)$/.test(host)) {
        target = this.containers.find((o) => this.running(o) && o.ports.some((p) => p.host === port));
        if (target) cport = target.ports.find((p) => p.host === port).cont;
        else target = this.containers.find((o) => this.running(o) && o.netMode === "host" && o.proc.listens.includes(port));
        if (!target) return refused(host);
        if (!target.proc.listens.includes(cport) && target.netMode !== "host") return { code: 56, text: "curl: (56) Recv failure: Connection reset by peer" };
      } else {
        const r = c ? this.resolve(c, host) : { target: this.containers.find((o) => this.running(o) && Object.values(o.nets).some((n) => n.ip === host)) };
        if (!r) return { code: 6, text: `curl: (6) Could not resolve host: ${host}` };
        target = r.target;
        if (!target || !target.proc.listens.includes(port)) return refused(host);
      }
      if (target.proc.hung) return { code: 28, text: "curl: (28) Operation timed out after 5001 milliseconds with 0 bytes received" };
      if (target.proc.app === "redis") return { code: 1, text: "curl: (1) Received HTTP/0.9 when not allowed" };
      return { code: 0, text: APPS[target.proc.app].body, app: target.proc.app };
    }

    // Start a container's main process; returns an error message or null.
    start(c) {
      const img = this.images[c.imageId];
      const who = this.userOf(c);
      if (who.error) return who.error;
      for (const p of c.ports) {
        const other = this.containers.find((o) => o !== c && this.running(o) && o.ports.some((q) => q.host === p.host));
        if (other) return `driver failed programming external connectivity on endpoint ${c.name} (${hexOf(c.id + p.host)}): Bind for 0.0.0.0:${p.host} failed: port is already allocated`;
      }
      for (const m of c.mounts) if (m.type === "volume") this.populate(m, img);
      const argv = [...(c.entrypoint || []), ...(c.cmd || [])];
      const r = this.process(c, argv, who);
      if (r.oci) { c.exitCode = 127; c.state = c.startedAt ? "exited" : "created"; return r.oci; }
      for (const [net, n] of Object.entries(c.nets)) {
        const nw = this.networks[net];
        if (nw && nw.subnet && !n.ip) n.ip = nw.subnet.replace(/0\.0\/16$/, `0.${nw.next++}`);
      }
      c.startedAt = this.now;
      c.logs.push(...r.logs);
      if (r.running) {
        c.state = "running";
        c.proc = { app: r.app, listens: r.listens || [], hung: r.hung, via: r.via };
        c.exitCode = 0;
        c.oom = false;
      } else this.exited(c, r.code, r.oom);
      return null;
    }
    exited(c, code, oom) {
      const restart = c.restart === "always" || c.restart === "unless-stopped" || (/^on-failure/.test(c.restart) && code !== 0);
      c.state = restart && !c.stopped ? "restarting" : "exited";
      c.exitCode = code;
      c.oom = Boolean(oom);
      c.finishedAt = this.now;
      c.proc = { listens: [] };
      if (c.state === "exited") for (const n of Object.values(c.nets)) n.ip = "";
      if (c.rm && c.state === "exited") this.remove(c, true);
    }
    remove(c, volumes) {
      this.containers = this.containers.filter((x) => x !== c);
      if (volumes) for (const m of c.mounts) if (m.anon) delete this.volumes[m.name];
    }
    // A new, empty volume takes a copy of what the image has at the mount path.
    populate(m, img) {
      const v = this.volumes[m.name];
      if (v.populated) return;
      v.populated = true;
      if (Object.keys(v.fs).length) return;
      for (const p of under(img.fs, m.dest)) if (p !== m.dest) v.fs[p.slice(m.dest.length)] = img.fs[p];
      if (img.fs[m.dest]) v.root = img.fs[m.dest];
    }
    volume(name, anon) {
      if (!this.volumes[name]) this.volumes[name] = { name, anon, fs: {}, root: D(), created: this.now };
      return this.volumes[name];
    }

    // Follow a command through entrypoint scripts and shells to the program that runs.
    process(c, argv, who) {
      const img = this.images[c.imageId];
      const logs = [];
      let a = [...argv];
      for (let guard = 0; guard < 8; guard++) {
        if (!a.length) return { oci: "no command specified" };
        const [bin, ...rest] = a;
        const base = bin.split("/").pop();
        if (base === "docker-entrypoint.sh") {
          if (img.bins.has("nginx")) { if (/^nginx/.test(rest[0] || "")) logs.push(...NGINX_ENTRY); a = rest; continue; }
          a = rest.length && !rest[0].startsWith("-") ? rest : [img.bins.has("redis-server") ? "redis-server" : "node", ...rest];
          continue;
        }
        if (!img.bins.has(base)) return { oci: OCI(bin) };
        if (/^(sh|bash|ash)$/.test(base)) {
          if (rest[0] === "-c") {
            const script = rest[1] || "";
            if (/(^|[^&])&\s*$/.test(script)) return { code: 0, logs };
            a = words(script.replace(/^\s*exec\s+/, "").replace(/\s*&&[\s\S]*$/, ""));
            if (!a.length) return { code: 0, logs };
            continue;
          }
          return c.interactive ? { running: true, logs, app: null } : { code: 0, logs };
        }
        if (base === "nginx") {
          const daemonOff = rest.join(" ").replace(/\s+/g, " ").includes("daemon off;");
          if (rest.includes("-v") || rest.includes("-t")) return { code: 0, logs: [...logs, rest.includes("-t") ? "nginx: configuration file /etc/nginx/nginx.conf test is successful" : "nginx version: nginx/1.27.3"] };
          if (!daemonOff) return { code: 0, logs };
          return this.app("nginx", c, logs, who);
        }
        if (base === "redis-server") return this.app("redis", c, logs, who);
        if (base === "sleep") return { running: true, logs, app: null };
        if (base === "node") {
          if (!rest.length || rest[0].startsWith("-")) return c.interactive ? { running: true, logs, app: null } : { code: 0, logs };
          const view = this.view(c);
          const script = join(c.workdir || img.config.WorkingDir || "/", rest[0]);
          const file = view[script] || view[script + ".js"];
          if (!file) return { code: 1, logs: nodeTrace([...logs, "node:internal/modules/cjs/loader:1228", "  throw err;", "  ^", "", `Error: Cannot find module '${script}'`, "    at Module._resolveFilename (node:internal/modules/cjs/loader:1225:15)", "    at Module._load (node:internal/modules/cjs/loader:1051:27) {", "  code: 'MODULE_NOT_FOUND',", "  requireStack: []", "}"]) };
          if (!file.app) return { code: 0, logs };
          return this.app(file.app, c, logs, who, view, script);
        }
        const r = ctool(this, c, a, who);
        if (r.na) return { code: 0, logs };
        return { code: r.code, logs: [...logs, ...r.lines.map((l) => l[0])] };
      }
      return { code: 0, logs };
    }
    app(name, c, logs, who, view, script) {
      const def = APPS[name];
      view = view || this.view(c);
      const env = Object.fromEntries([...this.images[c.imageId].config.Env, ...c.env].map((kv) => [kv.split("=")[0], kv.slice(kv.indexOf("=") + 1)]));
      const x = {
        e: this, c, view, uid: who.uid, gid: who.gid, env,
        // A require() that fails like Node does when node_modules is missing.
        module: (mod) => (view[(script || "").replace(/\/[^/]*$/, "") + "/node_modules"] ? null : {
          code: 1, logs: nodeTrace(["node:internal/modules/cjs/loader:1228", "  throw err;", "  ^", "", `Error: Cannot find module '${mod}'`, "Require stack:", `- ${script}`,
            "    at Module._resolveFilename (node:internal/modules/cjs/loader:1225:15)", "    at Module._load (node:internal/modules/cjs/loader:1051:27) {", "  code: 'MODULE_NOT_FOUND',", `  requireStack: [ '${script}' ]`, "}"])
        })
      };
      const r = def.start(x);
      if (r.code !== undefined) return { code: r.code, oom: r.oom, logs: [...logs, ...r.logs] };
      return { running: true, app: name, listens: [def.port], hung: r.hung, via: r.via, logs: [...logs, ...r.logs] };
    }
    stop(c, signal) {
      if (!this.running(c) && c.state !== "restarting") return;
      c.stopped = true;
      const def = APPS[c.proc.app];
      this.exited(c, signal === "KILL" ? 137 : def && def.stopCode !== undefined ? def.stopCode : c.proc.app ? 137 : 0, false);
    }
    // Would this image run? Used to check that a smaller image still works.
    trial(img) {
      const c = newContainer(this, { name: "trial", imageId: img.id, image: img.id, cmd: img.config.Cmd, entrypoint: img.config.Entrypoint, env: [], mounts: [], ports: [] });
      const who = this.userOf(c);
      if (who.error) return { ok: false, why: who.error };
      const r = this.process(c, [...(c.entrypoint || []), ...(c.cmd || [])], who);
      return { ok: Boolean(r.running && r.app), why: r.oci || r.logs.join("\n") };
    }
    writeFile(path, text) {
      const p = join(this.cwd, path);
      const old = this.host[p];
      if (old && old.text === text) return;
      this.host[p] = { uid: 1000, gid: 1000, mode: 0o644, ...(old || {}), text, size: undefined, v: ((old && old.v) || 0) + 1 };
    }
  }

  function newContainer(e, o) {
    const id = e.id(o.name);
    const nets = {};
    if (o.netMode !== "host" && o.netMode !== "none") nets[o.netMode || "bridge"] = { ip: "", aliases: o.aliases || [] };
    return {
      id, name: o.name, image: o.image, imageId: o.imageId, cmd: o.cmd, entrypoint: o.entrypoint, workdir: o.workdir || "", user: o.user || "",
      env: o.env, tty: Boolean(o.tty), interactive: Boolean(o.interactive), rm: Boolean(o.rm), ports: o.ports, mounts: o.mounts,
      netMode: o.netMode || "bridge", nets, links: o.links || {}, memory: o.memory || 0, memorySwap: o.memorySwap || 0, restart: o.restart || "no",
      oomKillDisable: Boolean(o.oomKillDisable), privileged: Boolean(o.privileged), readOnly: Boolean(o.readOnly),
      state: "created", exitCode: 0, oom: false, created: e.now, startedAt: 0, finishedAt: 0, logs: [], proc: { listens: [] }, hostname: id.slice(0, 12)
    };
  }

  // --- commands inside a container ---------------------------------------------

  function lsLines(fs, cwd, args, names) {
    const flags = args.filter((a) => /^-\w/.test(a)).join("");
    const paths = args.filter((a) => !/^-\w/.test(a));
    const out = [];
    let code = 0;
    for (const p of paths.length ? paths : ["."]) {
      const abs = join(cwd, p);
      const st = stat(fs, abs);
      if (!st) { out.push([`ls: cannot access '${p}': No such file or directory`, "warn"]); code = 2; continue; }
      let list = st.dir && !flags.includes("d") ? kids(fs, abs) : [p];
      if (st.dir && !flags.includes("d") && !flags.includes("a")) list = list.filter((n) => !n.startsWith("."));
      if (st.dir && !flags.includes("d") && flags.includes("a")) list = [".", "..", ...list];
      if (paths.length > 1) out.push([`${p}:`]);
      if (!/[ln]/.test(flags)) { if (list.length) out.push([list.join("  ")]); continue; }
      if (st.dir && !flags.includes("d")) out.push([`total ${list.length * 4}`]);
      for (const n of list) {
        const full = st.dir && !flags.includes("d") ? (n === "." ? abs : n === ".." ? join(abs, "..") : join(abs, n)) : abs;
        const s = stat(fs, full) || D();
        const own = (id) => (flags.includes("n") ? String(id || 0) : names(id || 0));
        const size = s.dir ? 4096 : entrySize(s);
        out.push([`${modeString(s)} ${s.dir ? 2 : 1} ${own(s.uid)} ${own(s.gid)} ${String(size).padStart(6)} Oct 30 09:00 ${n}`]);
      }
    }
    return { code, lines: out };
  }
  function catLines(fs, cwd, args, prog) {
    const out = [];
    let code = 0;
    for (const p of args.filter((a) => !a.startsWith("-"))) {
      const st = stat(fs, join(cwd, p));
      if (!st) { out.push([`${prog}: ${p}: No such file or directory`, "warn"]); code = 1; } else if (st.dir) { out.push([`${prog}: ${p}: Is a directory`, "warn"]); code = 1; } else if (st.text === undefined) out.push([`(${human(entrySize(st))} of data, not shown in the playground)`, "dim"]);
      else for (const l of st.text.replace(/\n$/, "").split("\n")) out.push([l]);
    }
    return { code, lines: out };
  }

  function ctool(e, c, argv, who) {
    const img = e.images[c.imageId];
    const [bin, ...a] = argv;
    const b = String(bin || "").split("/").pop();
    const say = (t, cls) => ({ code: cls === "warn" ? 1 : 0, lines: String(t).split("\n").map((l) => [l, cls || ""]) });
    if (!img.bins.has(b)) return { oci: `OCI runtime exec failed: exec failed: unable to start container process: exec: "${bin}": executable file not found in $PATH: unknown` };
    const view = e.view(c);
    const wd = c.workdir || img.config.WorkingDir || "/";
    const nameOf = (id) => Object.keys(img.users).find((k) => img.users[k][0] === id) || String(id);
    const target = a.filter((x) => !x.startsWith("-"));
    switch (b) {
      case "ls": return lsLines(view, wd, a, nameOf);
      case "cat": return catLines(view, wd, a, "cat");
      case "echo": return say(a.join(" "));
      case "true": case "sleep": return say("");
      case "false": return { code: 1, lines: [] };
      case "hostname": return say(c.hostname);
      case "whoami": return say(who.name || `whoami: unknown uid ${who.uid}`);
      case "id": {
        const n = (id) => (nameOf(id) === String(id) ? `${id}` : `${id}(${nameOf(id)})`);
        return say(`uid=${n(who.uid)} gid=${n(who.gid)} groups=${n(who.gid)}`);
      }
      case "env": case "printenv":
        return say([`HOSTNAME=${c.hostname}`, ...img.config.Env, ...c.env, `HOME=${who.uid === 0 ? "/root" : "/home/" + (who.name || "")}`].join("\n"));
      case "ping": {
        const host = target[target.length - 1];
        if (!host) return say("BusyBox v1.36.1 multi-call binary.\n\nUsage: ping [OPTIONS] HOST", "warn");
        const r = e.resolve(c, host);
        if (!r) return say(`ping: bad address '${host}'`, "warn");
        if (!r.target && r.via === "ip") return say(`PING ${host} (${host}): 56 data bytes\n\n--- ${host} ping statistics ---\n3 packets transmitted, 0 packets received, 100% packet loss`, "warn");
        return say([`PING ${host} (${r.ip}): 56 data bytes`, ...[0, 1, 2].map((i) => `64 bytes from ${r.ip}: seq=${i} ttl=64 time=0.0${8 + i} ms`), "", `--- ${host} ping statistics ---`, "3 packets transmitted, 3 packets received, 0% packet loss"].join("\n"));
      }
      case "nslookup": {
        const host = target[0] || "";
        const user = Object.keys(c.nets).some((n) => e.networks[n] && e.networks[n].user);
        const server = user ? "127.0.0.11" : "192.168.65.7";
        const r = e.resolve(c, host);
        const head = `Server:\t\t${server}\nAddress:\t${server}:53\n`;
        return r && r.via !== "link" ? say(`${head}\nNon-authoritative answer:\nName:\t${host}\nAddress: ${r.ip}`) : say(`${head}\n** server can't find ${host}: NXDOMAIN`, "warn");
      }
      case "wget": case "curl": {
        const url = target[target.length - 1];
        if (!url) return say(b === "curl" ? "curl: try 'curl --help' for more information" : "BusyBox v1.36.1 multi-call binary.\n\nUsage: wget [OPTIONS] URL", "warn");
        const r = e.http(c, url);
        if (r.code === 0) return say(r.text);
        if (b === "curl") return say(r.text, "warn");
        const host = (/^(?:https?:\/\/)?([^/:]+)/.exec(url) || [])[1];
        const res = e.resolve(c, host);
        return say(r.code === 6 ? `wget: bad address '${host}'` : r.code === 28 ? "wget: download timed out" : `wget: can't connect to remote host (${res ? res.ip : host}): Connection refused`, "warn");
      }
      default:
        return { na: true, code: 0, lines: [[`The playground runs ls, cat, id, env, ping, nslookup, wget and curl inside containers. Try: docker exec ${c.name} ls`, "na"]] };
    }
  }

  // --- docker ------------------------------------------------------------------

  const RUN_SPEC = flagSpec("d|detach i|interactive t|tty rm P|publish-all read-only privileged init oom-kill-disable help",
    "name p|publish v|volume e|env net|network m|memory memory-swap u|user restart entrypoint w|workdir link mount cpus pids-limit tmpfs cap-drop cap-add security-opt network-alias h|hostname l|label platform",
    "publish volume env link mount tmpfs cap-drop cap-add security-opt network-alias label");
  const fail = (lines, cls) => ({ code: 1, lines: (Array.isArray(lines) ? lines : [lines]).map((l) => [l, cls || "warn"]) });
  const ok = (lines, cls) => ({ code: 0, lines: (Array.isArray(lines) ? lines : [lines]).filter((l) => l !== null).map((l) => (Array.isArray(l) ? l : [l, cls || ""])) });
  const na = (text) => ({ code: 0, lines: [[text, "na"]] });
  const usage = (cmd, err) => fail([err, `See 'docker ${cmd} --help'.`]);
  const LAB = (what) => na(`${what} needs a real Docker host. Run it on your machine (Lab).`);

  function statusOf(e, c) {
    if (c.state === "running") return `Up ${duration(e.now - c.startedAt)}`;
    if (c.state === "restarting") return `Restarting (${c.exitCode}) ${duration(e.now - c.finishedAt)} ago`;
    if (c.state === "exited") return `Exited (${c.exitCode}) ${duration(e.now - c.finishedAt)} ago`;
    return "Created";
  }
  function portsOf(e, c) {
    if (c.state !== "running" && c.state !== "restarting") return "";
    const img = e.images[c.imageId];
    const pub = c.ports.map((p) => `${p.hostIp || "0.0.0.0"}:${p.host}->${p.cont}/tcp`);
    const v6 = c.ports.filter((p) => !p.hostIp).map((p) => `[::]:${p.host}->${p.cont}/tcp`);
    const exposed = (img.config.ExposedPorts || []).filter((p) => !c.ports.some((q) => q.cont === p)).map((p) => `${p}/tcp`);
    return c.netMode === "host" ? "" : [...pub, ...v6, ...exposed].join(", ");
  }
  const cmdOf = (c) => {
    const s = `"${[...(c.entrypoint || []), ...(c.cmd || [])].join(" ")}"`;
    return s.length > 22 ? s.slice(0, 20) + "…\"" : s;
  };

  // A tiny Go-template reader for --format: .Path, json .Path, index, range.
  function goValue(v) {
    if (v === null || v === undefined) return "<no value>";
    if (Array.isArray(v)) return `[${v.map(goValue).join(" ")}]`;
    if (typeof v === "object") return `map[${Object.keys(v).sort().map((k) => `${k}:${typeof v[k] === "object" && v[k] !== null ? "0xc000" + hexOf(k).slice(0, 6) : goValue(v[k])}`).join(" ")}]`;
    return String(v);
  }
  function template(fmt, data) {
    const out = [];
    const toks = String(fmt).split(/({{.*?}})/).filter((t) => t !== "");
    const walk = (dot, vars, path) => {
      if (path === ".") return dot;
      if (path.startsWith("$")) {
        const [v, ...rest] = path.split(".");
        return walk(vars[v], vars, rest.length ? "." + rest.join(".") : ".");
      }
      let cur = dot;
      for (const k of path.replace(/^\./, "").split(".")) {
        if (cur === null || typeof cur !== "object" || !(k in cur)) throw new Error(`template: :1: executing "" at <${path}>: map has no entry for key "${k}"`);
        cur = cur[k];
      }
      return cur;
    };
    const run = (i, dot, vars, emit) => {
      for (; i < toks.length; i++) {
        const t = toks[i];
        const m = /^{{-?\s*(.*?)\s*-?}}$/.exec(t);
        if (!m) { emit(t.replace(/\\n/g, "\n").replace(/\\t/g, "\t")); continue; }
        const act = m[1];
        if (act === "end") return i;
        let r;
        if ((r = /^range\s+(?:(\$\w+)\s*,\s*(\$\w+)\s*:=\s*)?(\S+)$/.exec(act))) {
          const coll = walk(dot, vars, r[3]) || [];
          let end = i;
          const entries = Array.isArray(coll) ? coll.map((v, k) => [k, v]) : Object.entries(coll);
          if (!entries.length) end = run(i + 1, dot, vars, () => {});
          for (const [k, v] of entries) end = run(i + 1, v, r[1] ? { ...vars, [r[1]]: k, [r[2]]: v } : vars, emit);
          i = end;
        } else if ((r = /^json\s+(\S+)$/.exec(act))) emit(JSON.stringify(walk(dot, vars, r[1])));
        else if ((r = /^index\s+(\S+)\s+"([^"]*)"$/.exec(act))) { const v = walk(dot, vars, r[1]); emit(goValue(v && v[r[2]])); }
        else if (/^[.$]/.test(act)) emit(goValue(walk(dot, vars, act)));
        else throw new Error(`template: :1: function "${act.split(" ")[0]}" not defined`);
      }
      return i;
    };
    run(0, data, {}, (s) => out.push(s));
    return out.join("");
  }

  function inspectContainer(e, c) {
    const img = e.images[c.imageId];
    const argv = [...(c.entrypoint || []), ...(c.cmd || [])];
    return {
      Id: c.id, Created: iso(c.created), Path: argv[0] || "", Args: argv.slice(1),
      State: { Status: c.state, Running: c.state === "running", Paused: false, Restarting: c.state === "restarting", OOMKilled: c.oom, Dead: false,
        Pid: c.state === "running" ? 4000 + (hash(c.id) % 900) : 0, ExitCode: c.exitCode, Error: "", StartedAt: c.startedAt ? iso(c.startedAt) : "0001-01-01T00:00:00Z", FinishedAt: c.finishedAt ? iso(c.finishedAt) : "0001-01-01T00:00:00Z" },
      Image: `sha256:${img.id}`, Name: `/${c.name}`, RestartCount: 0,
      HostConfig: {
        Binds: c.mounts.filter((m) => m.spec).map((m) => m.spec), NetworkMode: c.netMode,
        PortBindings: Object.fromEntries(c.ports.map((p) => [`${p.cont}/tcp`, [{ HostIp: p.hostIp || "", HostPort: String(p.host) }]])),
        RestartPolicy: { Name: c.restart, MaximumRetryCount: 0 }, AutoRemove: c.rm, Privileged: c.privileged, ReadonlyRootfs: c.readOnly,
        Memory: c.memory, MemorySwap: c.memorySwap, OomKillDisable: c.oomKillDisable
      },
      Mounts: c.mounts.map((m) => ({ Type: m.type, ...(m.type === "volume" ? { Name: m.name } : {}), Source: m.type === "bind" ? m.source : m.type === "volume" ? `/var/lib/docker/volumes/${m.name}/_data` : "", Destination: m.dest, Driver: m.type === "volume" ? "local" : undefined, Mode: m.ro ? "ro" : "", RW: !m.ro, Propagation: m.type === "bind" ? "rprivate" : "" })),
      Config: { Hostname: c.hostname, User: c.user || img.config.User, Tty: c.tty, OpenStdin: c.interactive, Env: [...img.config.Env, ...c.env], Cmd: c.cmd, Image: c.image,
        WorkingDir: c.workdir || img.config.WorkingDir, Entrypoint: c.entrypoint, ExposedPorts: Object.fromEntries((img.config.ExposedPorts || []).map((p) => [`${p}/tcp`, {}])) },
      NetworkSettings: {
        IPAddress: (c.nets.bridge && c.nets.bridge.ip) || "",
        Ports: Object.fromEntries(c.ports.map((p) => [`${p.cont}/tcp`, [{ HostIp: p.hostIp || "0.0.0.0", HostPort: String(p.host) }]])),
        Networks: Object.fromEntries(Object.entries(c.nets).map(([n, x]) => [n, { Aliases: x.aliases.length ? x.aliases : null, NetworkID: e.networks[n].id, Gateway: x.ip ? x.ip.replace(/\d+$/, "1") : "", IPAddress: x.ip, IPPrefixLen: x.ip ? 16 : 0, DNSNames: e.networks[n].user && x.ip ? [c.name, c.hostname, ...x.aliases] : null }]))
      }
    };
  }
  function inspectImage(e, img) {
    return {
      Id: `sha256:${img.id}`, RepoTags: e.tagsOf(img), RepoDigests: [], Created: iso(img.created), Os: "linux", Architecture: "amd64", Size: e.imageSize(img),
      Config: { User: img.config.User, ExposedPorts: Object.fromEntries((img.config.ExposedPorts || []).map((p) => [`${p}/tcp`, {}])), Env: img.config.Env, Cmd: img.config.Cmd, WorkingDir: img.config.WorkingDir, Entrypoint: img.config.Entrypoint, Labels: null },
      RootFS: { Type: "layers", Layers: img.layers.filter((l) => l.id).map((l) => `sha256:${l.id}`) }
    };
  }
  const inspectVolume = (v) => ({ CreatedAt: new Date(v.created).toISOString().replace(/\.\d+Z$/, "Z"), Driver: "local", Labels: v.anon ? { "com.docker.volume.anonymous": "" } : null, Mountpoint: `/var/lib/docker/volumes/${v.name}/_data`, Name: v.name, Options: null, Scope: "local" });
  function inspectNetwork(e, n) {
    return {
      Name: n.name, Id: n.id, Created: iso(n.created), Scope: "local", Driver: n.driver, EnableIPv6: false,
      IPAM: { Driver: "default", Options: null, Config: n.subnet ? [{ Subnet: n.subnet, Gateway: n.subnet.replace(/0\/16$/, "1") }] : [] },
      Internal: false, Attachable: false,
      Containers: Object.fromEntries(e.containers.filter((c) => c.nets[n.name] && c.nets[n.name].ip).map((c) => [c.id, { Name: c.name, IPv4Address: `${c.nets[n.name].ip}/16`, IPv6Address: "" }])),
      Options: n.name === "bridge" ? { "com.docker.network.bridge.default_bridge": "true", "com.docker.network.bridge.enable_icc": "true", "com.docker.network.bridge.name": "docker0" } : {}
    };
  }

  function parsePorts(e, specs, publishAll, img) {
    const ports = [];
    for (const s of specs || []) {
      const m = /^(?:(\d+\.\d+\.\d+\.\d+):)?(?:(\d*):)?(\d+)(?:\/(tcp|udp))?$/.exec(s);
      if (!m) return { error: `docker: Invalid containerPort: ${s.split(":").pop()}.` };
      ports.push({ hostIp: m[1] || "", host: m[2] ? Number(m[2]) : 32768 + ports.length, cont: Number(m[3]) });
    }
    if (publishAll) for (const p of img.config.ExposedPorts || []) if (!ports.some((q) => q.cont === p)) ports.push({ hostIp: "", host: 32768 + ports.length, cont: p });
    return { ports };
  }

  function parseMounts(e, f) {
    const mounts = [];
    for (const spec of f.volume || []) {
      const parts = spec.split(":");
      const ro = parts.length > 2 && /\bro\b/.test(parts[2]);
      if (parts.length === 1) {
        if (!spec.startsWith("/")) return { error: `docker: Error response from daemon: invalid volume specification: '${spec}'.` };
        const name = e.id("anon" + spec + mounts.length);
        mounts.push({ type: "volume", name, dest: norm(spec), anon: true });
        continue;
      }
      const [src, dest] = parts;
      if (!dest.startsWith("/")) return { error: `docker: Error response from daemon: invalid volume specification: '${spec}': invalid mount config for type "volume": invalid mount path: '${dest}' mount path must be absolute.` };
      if (/^[/.~]/.test(src)) {
        const source = join(e.cwd, src.replace(/^~/, HOME));
        if (!stat(e.host, source)) e.host[source] = D();
        mounts.push({ type: "bind", source, dest: norm(dest), ro, spec: `${source}:${norm(dest)}${ro ? ":ro" : ""}` });
      } else {
        if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]+$/.test(src)) return { error: `docker: Error response from daemon: create ${src}: "${src}" includes invalid characters for a local volume name, only "[a-zA-Z0-9][a-zA-Z0-9_.-]" are allowed. If you intended to pass a host directory, use absolute path.` };
        mounts.push({ type: "volume", name: src, dest: norm(dest), ro, spec: `${src}:${norm(dest)}${ro ? ":ro" : ""}` });
      }
    }
    for (const spec of f.mount || []) {
      const o = Object.fromEntries(spec.split(",").map((kv) => { const [k, v] = kv.split("="); return [k, v === undefined ? true : v]; }));
      const type = o.type || "volume";
      const dest = o.target || o.dst || o.destination;
      const source = o.source || o.src;
      if (!dest) return { error: "docker: invalid argument \"" + spec + "\" for \"--mount\" flag: target is required" };
      if (type === "bind") {
        const abs = join(e.cwd, source || "");
        if (!stat(e.host, abs)) return { error: `docker: Error response from daemon: invalid mount config for type "bind": bind source path does not exist: ${abs}` };
        mounts.push({ type, source: abs, dest: norm(dest), ro: Boolean(o.readonly || o.ro) });
      } else if (type === "tmpfs") mounts.push({ type, dest: norm(dest) });
      else mounts.push({ type: "volume", name: source || e.id("anon" + dest), dest: norm(dest), anon: !source, ro: Boolean(o.readonly || o.ro) });
    }
    for (const t of f.tmpfs || []) mounts.push({ type: "tmpfs", dest: norm(t.split(":")[0]) });
    return { mounts };
  }

  function dRun(e, args, create) {
    const verb = create ? "create" : "run";
    const p = parseFlags(args, RUN_SPEC, true);
    if (p.error) return usage(verb, p.error);
    const f = p.flags;
    const [ref, ...cmd] = p.pos;
    if (!ref) return fail([`docker: '${verb}' requires at least 1 argument.`, "", `Usage:  docker ${verb} [OPTIONS] IMAGE [COMMAND] [ARG...]`, "", `See 'docker ${verb} --help' for more information`]);
    const lines = [];
    const name = f.name || `${["quirky", "brave", "eager", "calm"][hash(e.now + ref) % 4]}_${["turing", "hopper", "lovelace", "ritchie"][hash(ref + e.containers.length) % 4]}`;
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]+$/.test(name)) return fail(`docker: Error response from daemon: Invalid container name (${name}), only [a-zA-Z0-9][a-zA-Z0-9_.-] are allowed.`);
    const taken = e.container(name);
    if (f.name && taken && taken.name === name) return fail([`docker: Error response from daemon: Conflict. The container name "/${name}" is already in use by container "${taken.id}". You have to remove (or rename) that container to be able to reuse that name.`, `See 'docker ${verb} --help'.`]);
    let memory = 0, memorySwap = 0;
    if (f.memory) {
      memory = parseBytes(f.memory);
      if (memory === null) return fail(`docker: invalid argument "${f.memory}" for "-m, --memory" flag: invalid size: '${f.memory}'`);
      if (memory > 0 && memory < 6 * MiB) return fail("docker: Error response from daemon: Minimum memory limit allowed is 6MB.");
      memorySwap = memory * 2;
    }
    if (f["memory-swap"] !== undefined) {
      if (!memory) return fail("docker: Error response from daemon: You should always set the Memory limit when using Memoryswap limit, see usage.");
      memorySwap = f["memory-swap"] === "-1" ? -1 : parseBytes(f["memory-swap"]);
      if (memorySwap !== -1 && memorySwap < memory) return fail("docker: Error response from daemon: Minimum memoryswap limit should be larger than memory limit, see usage.");
    }
    if (f.restart && !/^(no|always|unless-stopped|on-failure(:\d+)?)$/.test(f.restart)) return fail(`docker: Error response from daemon: invalid restart policy: unknown policy '${f.restart}'; use one of 'no', 'always', 'on-failure', or 'unless-stopped'.`);
    const netMode = f.network || "bridge";
    if (!e.networks[netMode]) return fail([`docker: Error response from daemon: network ${netMode} not found.`, `See 'docker ${verb} --help'.`]);
    const links = {};
    for (const l of f.link || []) {
      const [target, alias] = l.split(":");
      if (!e.container(target)) return fail(`docker: Error response from daemon: could not get container for ${target}: No such container: ${target}`);
      links[alias || target] = target;
    }
    let img = e.image(ref);
    if (!img) {
      lines.push([`Unable to find image '${normRef(ref)}' locally`, ""]);
      const r = e.pullLines(ref);
      if (r.error) return fail([...lines.map((l) => l[0]), `docker: Error response from daemon: ${r.error}`, "", `Run 'docker ${verb} --help' for more information`]);
      lines.push(...r.lines.slice(0, -1).map((l) => [l, "dim"]));
      img = e.image(ref);
    }
    const ports = parsePorts(e, f.publish, f["publish-all"], img);
    if (ports.error) return fail(ports.error);
    const m = parseMounts(e, f);
    if (m.error) return fail(m.error);
    const entry = f.entrypoint !== undefined ? (f.entrypoint ? [f.entrypoint] : []) : img.config.Entrypoint;
    const c = newContainer(e, {
      name, image: ref, imageId: img.id, cmd: cmd.length ? cmd : f.entrypoint !== undefined ? [] : img.config.Cmd, entrypoint: entry, workdir: f.workdir, user: f.user,
      env: (f.env || []).filter((x) => x.includes("=")), tty: f.tty, interactive: f.interactive, rm: f.rm, ports: ports.ports, mounts: m.mounts, netMode,
      aliases: f["network-alias"], links, memory, memorySwap, restart: f.restart, oomKillDisable: f["oom-kill-disable"], privileged: f.privileged, readOnly: f["read-only"]
    });
    for (const mt of c.mounts) if (mt.type === "volume") e.volume(mt.name, mt.anon);
    e.containers.push(c);
    if (create) return ok([...lines, c.id]);
    const err = e.start(c);
    if (err) return { code: 1, lines: [...lines, [`docker: Error response from daemon: ${err}.`, "warn"], ["", ""], [`Run 'docker run --help' for more information`, "warn"]] };
    if (f.detach) return ok([...lines, c.id]);
    lines.push(...c.logs.map((l) => [l, ""]));
    if (c.state === "running" && !f.interactive) lines.push(["(attached: a real terminal keeps showing the logs until you press Ctrl+C. Add -d to run it in the background.)", "dim"]);
    if (c.state === "running" && f.interactive) lines.push(["(the playground has no interactive shell; the container keeps running. Run commands with docker exec.)", "dim"]);
    return { code: c.state === "running" ? 0 : c.exitCode, lines };
  }

  function containersArg(e, names, cmd, each) {
    if (!names.length) return fail([`docker: '${cmd}' requires at least 1 argument.`, "", `See 'docker ${cmd} --help' for more information`]);
    const lines = [];
    let code = 0;
    for (const n of names) {
      const c = e.container(n);
      if (!c) { lines.push([`Error response from daemon: No such container: ${n}`, "warn"]); code = 1; continue; }
      const r = each(c, n);
      if (r) { lines.push(...r.lines); code = r.code || code; }
    }
    return { code, lines };
  }

  function dPs(e, args) {
    const p = parseFlags(args, flagSpec("a|all q|quiet no-trunc s|size l|latest", "f|filter format n|last", "filter"), false);
    if (p.error) return usage("ps", p.error);
    const f = p.flags;
    let list = [...e.containers].reverse().filter((c) => f.all || c.state === "running" || c.state === "restarting");
    for (const flt of f.filter || []) {
      const [k, v] = flt.split("=");
      list = list.filter((c) => (k === "status" ? c.state === v : k === "name" ? c.name.includes(v) : k === "ancestor" ? c.image === v : k === "exited" ? c.state === "exited" && String(c.exitCode) === v : true));
    }
    if (f.quiet) return ok(list.map((c) => c.id.slice(0, 12)));
    const row = (c) => ({ ID: c.id.slice(0, 12), Image: c.image, Command: cmdOf(c), CreatedAt: iso(c.created), RunningFor: `${duration(e.now - c.created)} ago`, Status: statusOf(e, c), Ports: portsOf(e, c), Names: c.name, State: c.state, Networks: Object.keys(c.nets).join(",") });
    if (f.format) {
      try {
        const fmt = f.format.replace(/^table\s*/, "");
        return ok(list.map((c) => template(fmt, row(c))), "row");
      } catch (err) { return fail(err.message); }
    }
    return { code: 0, lines: table([["CONTAINER ID", "IMAGE", "COMMAND", "CREATED", "STATUS", "PORTS", "NAMES"], ...list.map((c) => { const r = row(c); return [r.ID, r.Image, r.Command, r.RunningFor, r.Status, r.Ports, r.Names]; })]).map((l, i) => [l, i ? "row" : "head"]) };
  }

  function imageRows(e, filter) {
    const rows = [];
    for (const img of Object.values(e.images).sort((a, b) => b.created - a.created)) {
      const tags = e.tagsOf(img);
      for (const t of tags.length ? tags : ["<none>:<none>"]) {
        const [repo, tag] = t === "<none>:<none>" ? ["<none>", "<none>"] : [t.slice(0, t.lastIndexOf(":")), t.slice(t.lastIndexOf(":") + 1)];
        if (filter && repo !== filter && t !== normRef(filter)) continue;
        rows.push([repo, tag, img.id.slice(0, 12), `${duration(e.now - img.created)} ago`, human(e.imageSize(img)), img]);
      }
    }
    return rows;
  }
  function dImages(e, args) {
    const p = parseFlags(args, flagSpec("a|all q|quiet no-trunc digests", "f|filter format", "filter"), false);
    if (p.error) return usage("images", p.error);
    let rows = imageRows(e, p.pos[0]);
    if ((p.flags.filter || []).includes("dangling=true")) rows = rows.filter((r) => r[0] === "<none>");
    if (p.flags.quiet) return ok([...new Set(rows.map((r) => r[2]))]);
    if (p.flags.format) {
      try { return ok(rows.map((r) => template(p.flags.format.replace(/^table\s*/, ""), { Repository: r[0], Tag: r[1], ID: r[2], CreatedSince: r[3], Size: r[4] })), "row"); } catch (err) { return fail(err.message); }
    }
    return { code: 0, lines: table([["REPOSITORY", "TAG", "IMAGE ID", "CREATED", "SIZE"], ...rows.map((r) => r.slice(0, 5))]).map((l, i) => [l, i ? "row" : "head"]) };
  }

  function dHistory(e, args) {
    const p = parseFlags(args, flagSpec("no-trunc q|quiet H|human", "format", ""), false);
    if (p.error) return usage("history", p.error);
    const ref = p.pos[0];
    if (!ref) return fail(["docker: 'history' requires 1 argument.", "", "See 'docker history --help' for more information"]);
    const img = e.image(ref);
    if (!img) return fail(`Error response from daemon: No such image: ${normRef(ref)}`);
    const rows = [...img.layers].reverse().map((l, i) => {
      const by = l.by.length > 45 && !p.flags["no-trunc"] ? l.by.slice(0, 44) + "…" : l.by;
      return [i === 0 ? img.id.slice(0, 12) : "<missing>", `${duration(e.now - l.created)} ago`, by, human(l.size), l.comment];
    });
    if (p.flags.quiet) return ok(rows.map((r) => r[0]));
    return { code: 0, lines: table([["IMAGE", "CREATED", "CREATED BY", "SIZE", "COMMENT"], ...rows]).map((l, i) => [l, i ? "row" : "head"]) };
  }

  function dInspect(e, args, only) {
    const p = parseFlags(args, flagSpec("s|size", "f|format type", ""), false);
    if (p.error) return usage("inspect", p.error);
    if (!p.pos.length) return fail(["docker: 'inspect' requires at least 1 argument.", "", "See 'docker inspect --help' for more information"]);
    const type = only || p.flags.type;
    const objs = [];
    for (const n of p.pos) {
      const o = (!type || type === "container") && e.container(n) ? inspectContainer(e, e.container(n))
        : (!type || type === "image") && e.image(n) ? inspectImage(e, e.image(n))
          : (!type || type === "volume") && e.volumes[n] ? inspectVolume(e.volumes[n])
            : (!type || type === "network") && e.networks[n] ? inspectNetwork(e, e.networks[n]) : null;
      if (!o) {
        const what = { image: "image", volume: "volume", network: "network", container: "container" }[type];
        return { code: 1, lines: [...(p.flags.format ? [] : [["[]", ""]]), [what === "image" ? `Error response from daemon: No such image: ${normRef(n)}` : what === "network" ? `Error response from daemon: network ${n} not found` : what === "volume" ? `Error response from daemon: get ${n}: no such volume` : `Error: No such object: ${n}`, "warn"]] };
      }
      objs.push(o);
    }
    if (p.flags.format) {
      try { return ok(objs.map((o) => template(p.flags.format, o))); } catch (err) { return fail(err.message); }
    }
    return ok(JSON.stringify(objs, null, 4).split("\n"));
  }

  function dLogs(e, args) {
    const p = parseFlags(args, flagSpec("f|follow t|timestamps details", "n|tail since until", ""), false);
    if (p.error) return usage("logs", p.error);
    if (p.pos.length !== 1) return fail(["docker: 'logs' requires 1 argument.", "", "See 'docker logs --help' for more information"]);
    const c = e.container(p.pos[0]);
    if (!c) return fail(`Error response from daemon: No such container: ${p.pos[0]}`);
    let logs = c.logs;
    if (p.flags.tail && p.flags.tail !== "all") logs = logs.slice(-Number(p.flags.tail) || logs.length);
    const out = ok(logs.map((l) => (p.flags.timestamps ? `${iso(c.startedAt)} ${l}` : l)));
    if (p.flags.follow && c.state === "running") out.lines.push(["(following: a real terminal waits for new lines until Ctrl+C)", "dim"]);
    return out;
  }

  function dExec(e, args) {
    const p = parseFlags(args, flagSpec("d|detach i|interactive t|tty privileged", "u|user w|workdir e|env", "env"), true);
    if (p.error) return usage("exec", p.error);
    const [name, ...cmd] = p.pos;
    if (!name || !cmd.length) return fail(["docker: 'exec' requires at least 2 arguments.", "", "Usage:  docker exec [OPTIONS] CONTAINER COMMAND [ARG...]", "", "See 'docker exec --help' for more information"]);
    const c = e.container(name);
    if (!c) return fail(`Error response from daemon: No such container: ${name}`);
    if (c.state !== "running") return fail(`Error response from daemon: container ${c.id} is not running`);
    if (/^(\/bin\/)?(sh|bash|ash)$/.test(cmd[0]) && cmd.length === 1) return na(`The playground has no interactive shell. Run one command at a time, for example: docker exec ${c.name} ls -la`);
    if (cmd[0] === "sh" && cmd[1] === "-c") cmd.splice(0, 3, ...words(cmd[2] || ""));
    const who = p.flags.user ? e.userOf({ ...c, user: p.flags.user }) : e.userOf(c);
    if (who.error) return fail(`Error response from daemon: ${who.error}`);
    const r = ctool(e, c, cmd, who);
    return r.oci ? fail(r.oci) : r;
  }

  function dUpdate(e, args) {
    const p = parseFlags(args, flagSpec("", "m|memory memory-swap restart cpus pids-limit", ""), false);
    if (p.error) return usage("update", p.error);
    const f = p.flags;
    return containersArg(e, p.pos, "update", (c) => {
      const mem = f.memory !== undefined ? parseBytes(f.memory) : c.memory;
      if (mem === null) return fail(`invalid argument "${f.memory}" for "-m, --memory" flag: invalid size: '${f.memory}'`);
      let swap = f["memory-swap"] !== undefined ? (f["memory-swap"] === "-1" ? -1 : parseBytes(f["memory-swap"])) : c.memorySwap;
      if (f.memory !== undefined && f["memory-swap"] === undefined && c.memorySwap > 0 && mem > c.memorySwap) {
        return fail(`Error response from daemon: Cannot update container ${c.id}: Memory limit should be smaller than already set memoryswap limit, update the memoryswap at the same time`);
      }
      if (swap !== -1 && swap > 0 && swap < mem) return fail(`Error response from daemon: Cannot update container ${c.id}: Minimum memoryswap limit should be larger than memory limit, see usage`);
      if (mem && mem < 6 * MiB) return fail(`Error response from daemon: Cannot update container ${c.id}: Minimum memory limit allowed is 6MB`);
      if (!c.memory && mem && f["memory-swap"] === undefined) swap = mem * 2;
      c.memory = mem;
      c.memorySwap = swap;
      if (f.restart) c.restart = f.restart;
      return ok(c.name === p.pos.find((n) => e.container(n) === c) ? c.name : c.id.slice(0, 12));
    });
  }

  function dRmi(e, args) {
    const p = parseFlags(args, flagSpec("f|force no-prune", "", ""), false);
    if (p.error) return usage("rmi", p.error);
    if (!p.pos.length) return fail(["docker: 'rmi' requires at least 1 argument.", "", "See 'docker rmi --help' for more information"]);
    const lines = [];
    let code = 0;
    for (const ref of p.pos) {
      const img = e.image(ref);
      if (!img) { lines.push([`Error response from daemon: No such image: ${normRef(ref)}`, "warn"]); code = 1; continue; }
      const byTag = e.tags[normRef(ref)] === img.id;
      const tags = e.tagsOf(img);
      const user = e.containers.find((c) => c.imageId === img.id);
      if (user && !p.flags.force && (tags.length <= 1 || !byTag)) {
        lines.push([`Error response from daemon: conflict: unable to ${byTag ? `remove repository reference "${normRef(ref)}" (must force)` : `delete ${img.id.slice(0, 12)} (must be forced)`} - container ${user.id.slice(0, 12)} is using its referenced image ${img.id.slice(0, 12)}`, "warn"]);
        code = 1;
        continue;
      }
      for (const t of byTag ? [normRef(ref)] : tags) { delete e.tags[t]; lines.push([`Untagged: ${t}`, ""]); }
      if (!e.tagsOf(img).length && !user) {
        delete e.images[img.id];
        lines.push([`Deleted: sha256:${img.id}`, ""]);
      }
    }
    return { code, lines };
  }

  function dVolume(e, [sub, ...args]) {
    const p = parseFlags(args, flagSpec("f|force q|quiet a|all", "d|driver filter format", ""), false);
    if (p.error) return usage(`volume ${sub}`, p.error);
    if (sub === "ls" || sub === "list") {
      if (p.flags.quiet) return ok(Object.keys(e.volumes));
      return { code: 0, lines: table([["DRIVER", "VOLUME NAME"], ...Object.keys(e.volumes).sort().map((n) => ["local", n])]).map((l, i) => [l, i ? "row" : "head"]) };
    }
    if (sub === "create") {
      const name = p.pos[0] || e.id("vol");
      e.volume(name, !p.pos[0]);
      return ok(name);
    }
    if (sub === "inspect") return dInspect(e, args, "volume");
    if (sub === "rm" || sub === "remove") {
      const lines = [];
      for (const n of p.pos) {
        if (!e.volumes[n]) { lines.push([`Error response from daemon: get ${n}: no such volume`, "warn"]); continue; }
        const user = e.containers.find((c) => c.mounts.some((m) => m.name === n));
        if (user) { lines.push([`Error response from daemon: remove ${n}: volume is in use - [${user.id}]`, "warn"]); continue; }
        delete e.volumes[n];
        lines.push([n, ""]);
      }
      return { code: lines.some((l) => l[1]) ? 1 : 0, lines };
    }
    if (sub === "prune") return prune(e, "volume", p.flags);
    return usage("volume", `docker: unknown command: docker volume ${sub || ""}`.trim());
  }

  function dNetwork(e, [sub, ...args]) {
    const p = parseFlags(args, flagSpec("f|force q|quiet internal attachable", "d|driver subnet gateway alias filter format", "alias"), false);
    if (p.error) return usage(`network ${sub}`, p.error);
    const pos = p.pos;
    if (sub === "ls" || sub === "list") {
      if (p.flags.quiet) return ok(Object.values(e.networks).map((n) => n.id.slice(0, 12)));
      return { code: 0, lines: table([["NETWORK ID", "NAME", "DRIVER", "SCOPE"], ...Object.values(e.networks).sort((a, b) => a.name.localeCompare(b.name)).map((n) => [n.id.slice(0, 12), n.name, n.driver, "local"])]).map((l, i) => [l, i ? "row" : "head"]) };
    }
    if (sub === "create") {
      const name = pos[0];
      if (!name) return fail(["docker: 'network create' requires 1 argument.", "", "See 'docker network create --help' for more information"]);
      if (e.networks[name]) return fail(`Error response from daemon: network with name ${name} already exists`);
      const driver = p.flags.driver || "bridge";
      if (driver !== "bridge") return na(`The playground models bridge networks only. A ${driver} network needs a real Docker host (Lab).`);
      return ok(e.addNetwork(name, "bridge", p.flags.subnet).id);
    }
    if (sub === "inspect") return dInspect(e, args, "network");
    if (sub === "rm" || sub === "remove") {
      const lines = [];
      for (const n of pos) {
        const nw = e.networks[n];
        if (!nw) { lines.push([`Error response from daemon: network ${n} not found`, "warn"]); continue; }
        if (!nw.user) { lines.push([`Error response from daemon: ${n} is a pre-defined network and cannot be removed`, "warn"]); continue; }
        if (e.containers.some((c) => c.nets[n] && c.nets[n].ip)) { lines.push([`Error response from daemon: error while removing network: network ${n} id ${nw.id} has active endpoints`, "warn"]); continue; }
        for (const c of e.containers) delete c.nets[n];
        delete e.networks[n];
        lines.push([n, ""]);
      }
      return { code: lines.some((l) => l[1]) ? 1 : 0, lines };
    }
    if (sub === "connect" || sub === "disconnect") {
      const [net, name] = pos;
      if (!net || !name) return fail([`docker: 'network ${sub}' requires 2 arguments.`, "", `See 'docker network ${sub} --help' for more information`]);
      const nw = e.networks[net];
      if (!nw) return fail(`Error response from daemon: network ${net} not found`);
      const c = e.container(name);
      if (!c) return fail(`Error response from daemon: No such container: ${name}`);
      if (nw.driver === "host" || c.netMode === "host") return fail("Error response from daemon: container cannot be disconnected from host network or connected to host network");
      if (sub === "connect") {
        if (c.nets[net]) return fail(`Error response from daemon: endpoint with name ${c.name} already exists in network ${net}`);
        c.nets[net] = { ip: "", aliases: p.flags.alias || [] };
        if (c.state === "running") c.nets[net].ip = nw.subnet.replace(/0\.0\/16$/, `0.${nw.next++}`);
      } else {
        if (!c.nets[net]) return fail(`Error response from daemon: container ${c.id} is not connected to network ${net}`);
        delete c.nets[net];
      }
      return ok([]);
    }
    if (sub === "prune") return prune(e, "network", p.flags);
    return usage("network", `docker: unknown command: docker network ${sub || ""}`.trim());
  }

  // Disk use the way docker system df adds it up: shared layers count once.
  function diskUse(e) {
    const used = new Set(e.containers.map((c) => c.imageId));
    const layers = new Map(), active = new Map();
    for (const img of Object.values(e.images)) for (const l of img.layers) if (l.id) { layers.set(l.id, l.size); if (used.has(img.id)) active.set(l.id, l.size); }
    const sum = (m) => [...m.values()].reduce((a, b) => a + b, 0);
    const vols = Object.values(e.volumes);
    const volSize = (v) => Object.values(v.fs).reduce((n, x) => n + entrySize(x), 0);
    const cache = [...e.cache.values()];
    return {
      images: Object.keys(e.images).length, activeImages: used.size, imageSize: sum(layers), imageFree: sum(layers) - sum(active),
      containers: e.containers.length, running: e.containers.filter((c) => c.state === "running").length,
      volumes: vols.length, activeVolumes: vols.filter((v) => e.containers.some((c) => c.mounts.some((m) => m.name === v.name))).length,
      volumeSize: vols.reduce((n, v) => n + volSize(v), 0), cacheCount: cache.length, cacheSize: cache.reduce((n, x) => n + (x.layer.size || 0), 0)
    };
  }
  function prune(e, what, flags) {
    const warn = {
      container: "WARNING! This will remove all stopped containers.",
      image: flags.all ? "WARNING! This will remove all images without at least one container associated to them." : "WARNING! This will remove all dangling images.",
      volume: "WARNING! This will remove anonymous local volumes not used by at least one container.",
      network: "WARNING! This will remove all custom networks not used by at least one container.",
      builder: "WARNING! This will remove all dangling build cache.",
      system: "WARNING! This will remove:\n  - all stopped containers\n  - all networks not used by at least one container\n  - all dangling images\n  - unused build cache"
    }[what];
    if (!flags.force) return { code: 1, lines: [...warn.split("\n").map((l) => [l, ""]), ["Are you sure you want to continue? [y/N] ", ""], ["(the playground cannot answer prompts: add -f to confirm)", "na"]] };
    const lines = [];
    let freed = 0;
    if (what === "container" || what === "system") {
      const gone = e.containers.filter((c) => c.state === "exited" || c.state === "created");
      if (gone.length) lines.push(["Deleted Containers:", ""], ...gone.map((c) => [c.id, ""]), ["", ""]);
      for (const c of gone) e.remove(c, false);
    }
    if (what === "network" || what === "system") {
      for (const n of Object.values(e.networks)) if (n.user && !e.containers.some((c) => c.nets[n.name])) { delete e.networks[n.name]; lines.push([`Deleted Networks:\n${n.name}`, ""]); }
    }
    if (what === "image" || what === "system") {
      const used = new Set(e.containers.map((c) => c.imageId));
      for (const img of Object.values(e.images)) {
        if (used.has(img.id) || (!flags.all && e.tagsOf(img).length)) continue;
        for (const t of e.tagsOf(img)) { delete e.tags[t]; lines.push([`untagged: ${t}`, ""]); }
        delete e.images[img.id];
        freed += e.imageSize(img);
        lines.push([`deleted: sha256:${img.id}`, ""]);
      }
    }
    if (what === "volume") {
      for (const v of Object.values(e.volumes)) {
        if ((!v.anon && !flags.all) || e.containers.some((c) => c.mounts.some((m) => m.name === v.name))) continue;
        delete e.volumes[v.name];
        lines.push([v.name, ""]);
      }
    }
    if (what === "builder" || what === "system") {
      for (const x of e.cache.values()) freed += x.layer.size || 0;
      if (e.cache.size) lines.push([`ID${" ".repeat(26)}RECLAIMABLE\tSIZE`, ""]);
      e.cache.clear();
    }
    lines.push([`Total reclaimed space: ${human(freed)}`, ""]);
    return ok(lines);
  }

  // --- docker build ---------------------------------------------------------------

  const KNOWN_RUN = ["echo", "ls", "cat", "mv", "cp", "ln", "test", "[", "sed", "grep", "tar", "unzip", "yarn", "mvn", "gradle", "pip", "pip3", "python", "python3", "go", "make", "git", "curl", "wget", "apt", "update-ca-certificates", "npx", "node", "true", "set", "export", "groupmod", "usermod", "touch", "find", "xargs"];

  function runStep(st, cmdline, uid) {
    const before = st.fs;
    const fs = { ...before };
    const out = [];
    let secs = 0.4;
    let wd = st.cfg.WorkingDir || "/";
    for (const part of cmdline.split(/\s*(?:&&|;)\s*/).filter(Boolean)) {
      const w = words(part);
      const [cmd, ...a] = w;
      if (!cmd) continue;
      const opts = a.filter((x) => x.startsWith("-"));
      const pos = a.filter((x, i) => !x.startsWith("-") && !(/^-[ugGgh]$/.test(a[i - 1] || "") || /^--(uid|gid|ingroup|home|shell)$/.test(a[i - 1] || "")));
      const valueOf = (...keys) => { for (const k of keys) { const i = a.indexOf(k); if (i >= 0) return a[i + 1]; const eq = a.find((x) => x.startsWith(k + "=")); if (eq) return eq.split("=")[1]; } return undefined; };
      if (cmd === "cd") { wd = join(wd, a[0] || "/"); continue; }
      if (cmd === "npm" || cmd === "yarn") {
        const sub = cmd === "yarn" ? (a[0] || "install") : a[0];
        if (!st.bins.has(cmd)) return { code: 127, out: [`/bin/sh: ${cmd}: not found`] };
        if (/^(ci|install|i)$/.test(sub)) {
          const pkg = fs[join(wd, "package.json")];
          if (!pkg) return { code: 254, out: ["npm error code ENOENT", "npm error syscall open", `npm error path ${join(wd, "package.json")}`, `npm error errno -2`, `npm error enoent Could not read package.json: Error: ENOENT: no such file or directory, open '${join(wd, "package.json")}'`] };
          if (sub === "ci" && !fs[join(wd, "package-lock.json")]) return { code: 1, out: ["npm error code EUSAGE", "npm error", "npm error The `npm ci` command can only install with an existing package-lock.json or", "npm error npm-shrinkwrap.json with lockfileVersion >= 1. Run an install with npm@5 or", "npm error later to generate a package-lock.json file, then try again."] };
          const prod = opts.some((o) => /^--(omit=dev|only=prod(uction)?|production)$/.test(o));
          const deps = pkg.deps || { all: 2 * MB, prod: MB, count: [20, 10] };
          for (const p of under(fs, join(wd, "node_modules"))) delete fs[p];
          fs[join(wd, "node_modules")] = { dir: true, size: prod ? deps.prod : deps.all, uid, gid: uid, mode: 0o755, prod };
          const n = prod ? deps.count[1] : deps.count[0];
          secs = Math.max(1.2, (prod ? deps.prod : deps.all) / (9.5 * MB));
          out.push(`added ${n} packages, and audited ${n + 1} packages in ${Math.round(secs)}s`, "", "found 0 vulnerabilities");
          continue;
        }
        if (sub === "prune" && fs[join(wd, "node_modules")] && opts.some((o) => /^--(omit=dev|production)$/.test(o))) {
          const pkg = fs[join(wd, "package.json")] || {};
          fs[join(wd, "node_modules")] = { ...fs[join(wd, "node_modules")], size: (pkg.deps || { prod: MB }).prod, prod: true, whiteout: true };
          out.push("removed 348 packages, and audited 65 packages in 2s");
          continue;
        }
        continue;
      }
      if (/^(addgroup|groupadd)$/.test(cmd)) { st.groups[pos[pos.length - 1]] = Number(valueOf("-g", "--gid")) || 1001; fs["/etc/group"] = { size: 700 }; continue; }
      if (/^(adduser|useradd)$/.test(cmd)) {
        const name = cmd === "adduser" ? pos[0] : pos[pos.length - 1];
        const id = Number(valueOf("-u", "--uid")) || (opts.some((o) => /^-(S|r)$|^--system$/.test(o)) ? (cmd === "adduser" ? 100 : 999) : 1001);
        const grp = valueOf("-G", "-g", "--ingroup", "--gid");
        st.users[name] = [id, grp && st.groups[grp] !== undefined ? st.groups[grp] : /^\d+$/.test(grp || "") ? Number(grp) : id];
        fs["/etc/passwd"] = { size: 1200 };
        continue;
      }
      if (cmd === "mkdir") { for (const d of pos) fs[join(wd, d)] = D(uid); continue; }
      if (cmd === "chown" || cmd === "chmod") {
        const [spec, ...paths] = pos;
        for (const target of paths) {
          for (const p of under(fs, join(wd, target))) {
            if (cmd === "chown") {
              const [u, g] = spec.split(":");
              const uidN = /^\d+$/.test(u) ? Number(u) : (st.users[u] || [])[0];
              if (uidN === undefined) return { code: 1, out: [`chown: unknown user ${u}`] };
              fs[p] = { ...fs[p], uid: uidN, gid: g ? (/^\d+$/.test(g) ? Number(g) : st.groups[g] ?? uidN) : uidN };
            } else fs[p] = { ...fs[p], mode: /^[0-7]+$/.test(spec) ? parseInt(spec, 8) : fs[p].mode };
          }
        }
        continue;
      }
      if (cmd === "rm") {
        for (const target of pos) {
          const abs = join(wd, target);
          const re = abs.includes("*") ? globRe(abs) : null;
          for (const p of Object.keys(fs)) if (re ? re.test(p) : inside(p, abs)) delete fs[p];
        }
        continue;
      }
      if (cmd === "apk") {
        if (!st.bins.has("ash")) return { code: 127, out: ["/bin/sh: apk: not found"] };
        const pkgs = pos.slice(1);
        pkgs.forEach((x) => st.bins.add(x));
        fs[`/usr/lib/apk/${pkgs.join("-") || "none"}`] = { size: pkgs.length * 2.4 * MB };
        if (!opts.includes("--no-cache")) fs["/var/cache/apk/APKINDEX.tar.gz"] = { size: 2.5 * MB };
        out.push(`OK: ${pkgs.length * 3 + 7} MiB in ${pkgs.length + 15} packages`);
        continue;
      }
      if (cmd === "apt-get") {
        if (!st.bins.has("bash")) return { code: 127, out: ["/bin/sh: apt-get: not found"] };
        if (a[0] === "update") fs["/var/lib/apt/lists/deb.debian.org_debian_dists_bookworm_main"] = { size: 18.6 * MB };
        if (a[0] === "install") {
          const pkgs = pos.slice(1);
          pkgs.forEach((x) => st.bins.add(x));
          fs[`/usr/share/doc/${pkgs.join("-") || "none"}`] = { size: pkgs.length * (opts.includes("--no-install-recommends") ? 14 : 31) * MB };
        }
        continue;
      }
      if (!st.bins.has(cmd) && !KNOWN_RUN.includes(cmd)) return { code: 127, out: [`/bin/sh: ${cmd}: not found`] };
    }
    const changed = Object.keys(fs).filter((p) => fs[p] !== before[p]);
    const size = changed.reduce((n, p) => n + (fs[p].whiteout ? 1200 : entrySize(fs[p])), 0);
    return { code: 0, fs, size, out, secs };
  }

  function dBuild(e, args) {
    const p = parseFlags(args, flagSpec("no-cache q|quiet pull squash load push rm", "t|tag f|file build-arg target progress platform network", "tag build-arg"), false);
    if (p.error) return usage("buildx build", p.error);
    if (p.pos.length !== 1) return fail(['ERROR: "docker buildx build" requires exactly 1 argument.', "See 'docker buildx build --help'.", "", "Usage:  docker buildx build [OPTIONS] PATH | URL | -", "", "Start a build"]);
    if (p.flags.push || String(p.flags.platform || "").includes(",")) return LAB("Pushing or building for several platforms");
    if (p.flags.squash) return fail("WARNING: experimental flag squash is removed with BuildKit. You should squash inside build using a multi-stage Dockerfile for efficiency.");
    const ctx = join(e.cwd, p.pos[0]);
    if (!stat(e.host, ctx)) return fail(`ERROR: unable to prepare context: path "${p.pos[0]}" not found`);
    const dfName = p.flags.file || "Dockerfile";
    const df = e.host[join(p.flags.file ? e.cwd : ctx, dfName)];
    if (!df || df.dir) return fail(`ERROR: failed to solve: failed to read dockerfile: open ${dfName}: no such file or directory`);
    const parsed = parseDockerfile(df.text || "");
    if (parsed.error) return fail(`ERROR: failed to solve: ${parsed.error}`);
    for (const t of p.flags.tag || []) {
      if (!/^[a-z0-9][a-z0-9._/-]*(:[\w][\w.-]{0,127})?$/.test(t)) return fail(`ERROR: invalid tag "${t}": invalid reference format: repository name (${t.split(":")[0]}) must be lowercase`);
    }

    const stages = [];
    for (const ins of parsed.instrs) {
      if (ins.name === "FROM") {
        const m = /^(?:--platform=\S+\s+)?(\S+)(?:\s+as\s+(\S+))?$/i.exec(ins.raw);
        if (!m) return fail(`ERROR: failed to solve: dockerfile parse error on line ${ins.line}: FROM requires either one or three arguments`);
        stages.push({ from: m[1], name: m[2] ? m[2].toLowerCase() : null, instrs: [], index: stages.length });
      } else if (ins.name !== "ARG" || stages.length) {
        if (!stages.length) return fail(`ERROR: failed to solve: no build stage in current context`);
        stages[stages.length - 1].instrs.push(ins);
      }
    }
    if (!stages.length) return fail("ERROR: failed to solve: dockerfile contains no stages to build");
    const stageOf = (ref) => stages.find((s) => s.name === String(ref).toLowerCase()) || (/^\d+$/.test(ref) ? stages[Number(ref)] : null);
    let final = stages.length - 1;
    if (p.flags.target) {
      const t = stageOf(p.flags.target);
      if (!t) return fail(`ERROR: failed to solve: target stage "${p.flags.target}" could not be found`);
      final = t.index;
    }
    // BuildKit builds only the stages the target needs.
    const needed = new Set([final]);
    for (let i = final; i >= 0; i--) {
      if (!needed.has(i)) continue;
      const s = stages[i];
      if (stageOf(s.from) && stageOf(s.from).index < i) needed.add(stageOf(s.from).index);
      for (const ins of s.instrs) {
        const f = /--from=(\S+)/.exec(ins.raw);
        if (f && stageOf(f[1])) needed.add(stageOf(f[1]).index);
      }
    }

    // The build context: everything under the folder, minus .dockerignore.
    const ign = e.host[join(ctx, ".dockerignore")];
    const ignored = ignoredBy(ign && ign.text ? ign.text.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#")) : []);
    const context = {};
    for (const path of under(e.host, ctx)) {
      if (path === ctx) continue;
      const rel = path.slice(ctx.length + 1);
      if (!ignored(rel)) context["/" + rel] = e.host[path];
    }
    const ctxSize = Object.values(context).reduce((n, x) => n + entrySize(x), 0);

    const log = [];
    const row = (label, secs) => log.push([` => ${label}`.padEnd(77) + ` ${secs.toFixed(1)}s`, label.startsWith("ERROR") ? "warn" : label.startsWith("CACHED") ? "dim" : ""]);
    row("[internal] load build definition from " + dfName, 0);
    row(`=> transferring dockerfile: ${bytes2((df.text || "").length)}`, 0);
    const externals = [...needed].sort().map((i) => stages[i].from).filter((f) => !stageOf(f));
    for (const ref of [...new Set(externals)]) row(`[internal] load metadata for ${fullRef(normRef(ref))}`, 0.6);
    row("[internal] load .dockerignore", 0);
    row(`=> transferring context: ${bytes2(ign ? entrySize(ign) : 2)}`, 0);
    row("[internal] load build context", ctxSize / (80 * MB) + 0.1);
    row(`=> transferring context: ${bytes2(ctxSize)}`, ctxSize / (80 * MB));

    const results = {};
    const steps = [];
    let total = 1.2 + ctxSize / (80 * MB);
    let doneCount = 0;
    const stepTotal = [...needed].reduce((n, i) => n + 1 + stages[i].instrs.filter((x) => /^(RUN|COPY|ADD|WORKDIR)$/.test(x.name)).length, 0);
    const failWith = (label, out, msg) => {
      row(`ERROR ${label}`, 0.3);
      const lines = [[`[+] Building ${total.toFixed(1)}s (${doneCount}/${stepTotal + 3}) docker:default`, ""], ...log];
      if (out) lines.push(["------", ""], [` > ${label}:`, ""], ...out.map((l) => [`0.912 ${l}`, ""]), ["------", ""]);
      lines.push([`ERROR: failed to solve: ${msg}`, "warn"]);
      return { code: 1, lines };
    };

    for (const i of [...needed].sort((a, b) => a - b)) {
      const s = stages[i];
      const label = stages.length > 1 ? `${s.name || "stage-" + i} ` : "";
      const n = 1 + s.instrs.filter((x) => /^(RUN|COPY|ADD|WORKDIR)$/.test(x.name)).length;
      let k = 1;
      let st;
      const parent = stageOf(s.from);
      if (parent && parent.index < i) {
        const r = results[parent.index];
        st = { fs: r.fs, cfg: { ...r.cfg }, users: { ...r.users }, groups: { ...r.groups }, bins: new Set(r.bins), layers: [...r.layers], key: r.key, os: r.os };
      } else {
        const base = e.image(s.from) || e.registry(s.from);
        if (!base) return failWith(`[${label}1/${n}] FROM ${fullRef(normRef(s.from))}`, null, `${s.from}: failed to resolve source metadata for ${fullRef(normRef(s.from))}: pull access denied, repository does not exist or may require authorization: server message: insufficient_scope: authorization failed`);
        st = { fs: { ...base.fs }, cfg: JSON.parse(JSON.stringify(base.config)), users: { ...base.users }, groups: {}, bins: new Set(base.bins), layers: [...base.layers], key: `base:${base.id}`, os: base.os };
        row(`[${label}1/${n}] FROM ${fullRef(normRef(s.from))}@sha256:${(base.digest || base.id).slice(0, 64)}`, 0);
      }
      doneCount++;
      let cmdReset = false;
      for (const ins of s.instrs) {
        const { flags, rest } = instrFlags(ins.raw);
        let extra = "";
        let copied = null;
        if (ins.name === "COPY" || ins.name === "ADD") {
          const parts = rest.startsWith("[") ? argvOf(rest) : words(rest);
          if (parts.length < 2) return failWith(`[${label}${k + 1}/${n}] ${ins.text}`, null, `dockerfile parse error on line ${ins.line}: ${ins.name} requires at least two arguments, but only one was provided. Destination could not be determined`);
          const dest = parts.pop();
          let srcFs = context, srcName = "context";
          if (flags.from) {
            const fromStage = stageOf(flags.from);
            if (fromStage) { srcFs = results[fromStage.index].fs; srcName = fromStage.name; } else {
              const img = e.image(flags.from) || e.registry(flags.from);
              if (!img) return failWith(`[${label}${k + 1}/${n}] ${ins.text}`, null, `${flags.from}: failed to resolve source metadata for ${fullRef(normRef(flags.from))}: pull access denied, repository does not exist or may require authorization: server message: insufficient_scope: authorization failed`);
              srcFs = img.fs;
            }
          }
          const destAbs = join(st.cfg.WorkingDir || "/", dest);
          copied = {};
          for (const src of parts) {
            if (/^https?:\/\//.test(src)) { copied[dest.endsWith("/") ? join(destAbs, src.split("/").pop()) : destAbs] = { size: 1.2 * MB, uid: 0 }; continue; }
            const s0 = norm(flags.from ? src : "/" + src);
            const glob = /[*?[]/.test(s0);
            const hits = glob ? Object.keys(srcFs).filter((pth) => globRe(s0).test(pth)) : under(srcFs, s0);
            if (!hits.length && !(s0 === "/" && srcFs === context)) {
              return failWith(`[${label}${k + 1}/${n}] ${ins.text}`, [], `failed to compute cache key: failed to calculate checksum of ref ${hexOf(srcName).slice(0, 8)}::${hexOf(src).slice(0, 25)}: "${s0}": not found`);
            }
            const isDir = !glob && stat(srcFs, s0) && stat(srcFs, s0).dir;
            const intoDir = dest.endsWith("/") || parts.length > 1 || glob || isDir || dest === ".";
            for (const pth of hits) {
              const rel = isDir ? (s0 === "/" ? pth : pth.slice(s0.length)) : "/" + pth.split("/").pop();
              const target = isDir || intoDir ? norm(destAbs + "/" + rel) : destAbs;
              copied[target] = srcFs[pth];
            }
          }
          if (flags.chown) {
            const [u, g] = String(flags.chown).split(":");
            const uidN = /^\d+$/.test(u) ? Number(u) : (st.users[u] || [])[0];
            if (uidN === undefined) return failWith(`[${label}${k + 1}/${n}] ${ins.text}`, null, `unable to convert uid/gid chown string to host mapping: can't find uid for user ${u}: no such user: ${u}`);
            const gidN = g ? (/^\d+$/.test(g) ? Number(g) : st.groups[g] ?? (st.users[g] || [])[1] ?? uidN) : (st.users[u] || [uidN, uidN])[1];
            for (const t of Object.keys(copied)) copied[t] = { ...copied[t], uid: uidN, gid: gidN };
          }
          extra = Object.entries(copied).map(([t, x]) => `${t}:${entrySize(x)}:${x.v || 0}:${x.uid || 0}`).join(",");
        }
        st.key = hexOf(`${st.key}\n${ins.text}\n${extra}`);
        const isStep = /^(RUN|COPY|ADD|WORKDIR)$/.test(ins.name);
        const shown = isStep ? `[${label}${++k}/${n}] ${ins.name} ${ins.raw.replace(/\s+/g, " ")}` : null;
        const hit = !p.flags["no-cache"] && e.cache.get(st.key);
        let layer = null;
        if (hit) {
          st.fs = hit.fs;
          st.users = { ...hit.users };
          st.groups = { ...hit.groups };
          st.bins = new Set(hit.bins);
          layer = hit.layer;
          if (shown) { row(`CACHED ${shown}`, 0); steps.push({ text: `${ins.name} ${ins.raw}`, cached: true, stage: s.name }); doneCount++; }
        } else if (ins.name === "RUN") {
          const who = st.cfg.User ? (st.users[st.cfg.User.split(":")[0]] || [Number(st.cfg.User) || 0])[0] : 0;
          const r = runStep(st, rest.startsWith("[") ? argvOf(rest).slice(-1)[0] : rest, who);
          if (r.code) return failWith(shown, r.out, `process "/bin/sh -c ${rest}" did not complete successfully: exit code: ${r.code}`);
          st.fs = r.fs;
          layer = { id: hexOf(`layer|${st.key}`), size: r.size, by: `RUN /bin/sh -c ${rest} # buildkit` };
          row(shown, r.secs);
          total += r.secs;
          r.out.forEach((l, j) => log.push([`${(r.secs * (0.3 + j / 20)).toFixed(3)} ${l}`, "dim"]));
        } else if (copied) {
          const fs = { ...st.fs };
          for (const [t, x] of Object.entries(copied)) fs[t] = x;
          st.fs = fs;
          const size = Object.values(copied).reduce((a, x) => a + entrySize(x), 0);
          layer = { id: hexOf(`layer|${st.key}`), size, by: `${ins.name} ${rest} # buildkit` };
          const secs = Math.max(0.1, size / (90 * MB));
          row(shown, secs);
          total += secs;
        } else {
          if (ins.name === "WORKDIR") {
            const wd = join(st.cfg.WorkingDir || "/", ins.raw);
            if (!stat(st.fs, wd)) st.fs = { ...st.fs, [wd]: D() };
            row(shown, 0.1);
          }
          layer = { id: null, size: 0, by: ins.name === "EXPOSE" ? `EXPOSE map[${ins.raw.split(/\s+/).map((x) => (x.includes("/") ? x : x + "/tcp") + ":{}").join(" ")}]` : ins.name === "CMD" || ins.name === "ENTRYPOINT" ? `${ins.name} [${argvOf(ins.raw).map((x) => JSON.stringify(x)).join(" ")}]` : ins.text };
        }
        if (!hit) e.cache.set(st.key, { fs: st.fs, users: { ...st.users }, groups: { ...st.groups }, bins: [...st.bins], layer });
        if (!hit && shown) { steps.push({ text: `${ins.name} ${ins.raw}`, cached: false, stage: s.name }); doneCount++; }
        st.layers.push({ ...layer, created: e.now, comment: "buildkit.dockerfile.v0" });
        // Metadata: applied whether or not the step was cached.
        if (ins.name === "ENV") {
          const pairs = /^\S+=/.test(ins.raw) ? words(ins.raw).map((kv) => [kv.split("=")[0], kv.slice(kv.indexOf("=") + 1)]) : [[ins.raw.split(/\s+/)[0], ins.raw.replace(/^\S+\s+/, "")]];
          for (const [key, v] of pairs) st.cfg.Env = [...st.cfg.Env.filter((x) => !x.startsWith(key + "=")), `${key}=${v}`];
        }
        if (ins.name === "WORKDIR") st.cfg.WorkingDir = join(st.cfg.WorkingDir || "/", ins.raw);
        if (ins.name === "USER") st.cfg.User = ins.raw;
        if (ins.name === "CMD") st.cfg.Cmd = argvOf(ins.raw);
        if (ins.name === "ENTRYPOINT") { st.cfg.Entrypoint = argvOf(ins.raw); if (!cmdReset) st.cfg.Cmd = null; }
        if (ins.name === "CMD") cmdReset = true;
        if (ins.name === "EXPOSE") st.cfg.ExposedPorts = [...new Set([...(st.cfg.ExposedPorts || []), ...ins.raw.split(/\s+/).map((x) => Number(x.split("/")[0]))])];
      }
      results[i] = st;
    }

    const r = results[final];
    const id = hexOf(`image|${r.key}`);
    const existing = e.images[id];
    const img = existing || { id, created: e.now, layers: r.layers, fs: r.fs, users: r.users, bins: r.bins, os: r.os, config: r.cfg, built: e.ready };
    if (e.ready) img.built = true;
    const exportSecs = existing ? 0 : Math.min(9, e.imageSize(img) / (400 * MB));
    total += exportSecs;
    row("exporting to image", exportSecs);
    row("=> exporting layers", exportSecs);
    row(`=> writing image sha256:${id}`, 0);
    for (const t of p.flags.tag || []) { row(`=> naming to ${fullRef(normRef(t))}`, 0); e.tag(t, img); }
    if (!(p.flags.tag || []).length) e.images[id] = img;
    e.lastBuild = { steps, image: id, tags: (p.flags.tag || []).map(normRef), user: e.ready };
    if (p.flags.quiet) return ok(`sha256:${id}`);
    return { code: 0, lines: [[`[+] Building ${total.toFixed(1)}s (${stepTotal + 3}/${stepTotal + 3}) FINISHED`.padEnd(66) + "docker:default", ""], ...log] };
  }

  function docker(e, args) {
    let [sub, ...rest] = args;
    const groups = {
      container: { ls: "ps", list: "ps", run: "run", create: "create", start: "start", stop: "stop", restart: "restart", rm: "rm", remove: "rm", kill: "kill", logs: "logs", inspect: "inspect", exec: "exec", prune: "container-prune", port: "port", stats: "stats", update: "update" },
      image: { ls: "images", list: "images", rm: "rmi", remove: "rmi", history: "history", inspect: "image-inspect", prune: "image-prune", pull: "pull", build: "build", tag: "tag" },
      buildx: { build: "build", prune: "builder-prune" },
      builder: { build: "build", prune: "builder-prune" },
      system: { df: "df", prune: "system-prune", info: "info" }
    };
    if (groups[sub]) {
      const to = groups[sub][rest[0]];
      if (!to) return LAB(`docker ${sub} ${rest[0] || ""}`.trim());
      sub = to;
      rest = rest.slice(1);
    }
    const simple = (spec) => parseFlags(rest, spec, false);
    switch (sub) {
      case undefined: case "help": case "--help": return ok(["Usage:  docker [OPTIONS] COMMAND", "", "Type 'help' for the commands this playground understands."]);
      case "--version": case "-v": return ok("Docker version 28.0.4, build b8034c0");
      case "version": return ok(["Client: Docker Engine - Community", " Version:           28.0.4", " API version:       1.48", "", "Server: Docker Engine - Community", " Engine:", "  Version:          28.0.4", " containerd:", "  Version:          1.7.27", " runc:", "  Version:          1.2.5"]);
      case "info": {
        const d = diskUse(e);
        return ok(["Client: Docker Engine - Community", " Version:    28.0.4", " Context:    default", "", "Server:", ` Containers: ${d.containers}`, `  Running: ${d.running}`, "  Paused: 0", `  Stopped: ${d.containers - d.running}`, ` Images: ${d.images}`, " Server Version: 28.0.4", " Storage Driver: overlay2", " Cgroup Driver: systemd", " Cgroup Version: 2", " Default Runtime: runc", " Kernel Version: 6.8.0-45-generic", " Operating System: Ubuntu 24.04.1 LTS", " CPUs: 4", " Total Memory: 7.7GiB", " Docker Root Dir: /var/lib/docker"]);
      }
      case "run": return dRun(e, rest, false);
      case "create": return dRun(e, rest, true);
      case "ps": return dPs(e, rest);
      case "images": return dImages(e, rest);
      case "history": return dHistory(e, rest);
      case "inspect": return dInspect(e, rest);
      case "image-inspect": return dInspect(e, rest, "image");
      case "logs": return dLogs(e, rest);
      case "exec": return dExec(e, rest);
      case "build": return dBuild(e, rest);
      case "update": return dUpdate(e, rest);
      case "rmi": return dRmi(e, rest);
      case "volume": return dVolume(e, rest);
      case "network": return dNetwork(e, rest);
      case "pull": {
        const p = simple(flagSpec("a|all-tags q|quiet", "platform", ""));
        if (p.error) return usage("pull", p.error);
        if (p.pos.length !== 1) return fail(["docker: 'pull' requires 1 argument.", "", "See 'docker pull --help' for more information"]);
        const r = e.pullLines(p.pos[0]);
        return r.error ? fail(`Error response from daemon: ${r.error}`) : ok(r.lines);
      }
      case "tag": {
        const [src, dst] = rest;
        if (!src || !dst) return fail(["docker: 'tag' requires 2 arguments.", "", "See 'docker tag --help' for more information"]);
        const img = e.image(src);
        if (!img) return fail(`Error response from daemon: No such image: ${normRef(src)}`);
        e.tag(dst, img);
        return ok([]);
      }
      case "start": case "restart": case "stop": case "kill": case "rm": {
        const p = simple(flagSpec("a|attach i|interactive f|force v|volumes", "t|time s|signal", ""));
        if (p.error) return usage(sub, p.error);
        return containersArg(e, p.pos, sub, (c, n) => {
          if (sub === "rm") {
            if ((c.state === "running" || c.state === "restarting") && !p.flags.force) return fail(`Error response from daemon: cannot remove container "/${c.name}": container is running: stop the container before removing or force remove`);
            e.remove(c, p.flags.volumes);
            return ok(n);
          }
          if (sub === "kill") {
            if (c.state !== "running") return fail(`Error response from daemon: cannot kill container: ${n}: container ${c.id} is not running`);
            e.stop(c, "KILL");
            return ok(n);
          }
          if (sub === "stop" || sub === "restart") e.stop(c);
          if (sub === "stop") return ok(n);
          if (c.state === "running") return ok(n);
          c.stopped = false;
          const err = e.start(c);
          return err ? fail([`Error response from daemon: ${err}`, `Error: failed to start containers: ${n}`]) : ok(n);
        });
      }
      case "port": {
        const c = e.container(rest[0]);
        if (!c) return fail(`Error response from daemon: No such container: ${rest[0] || ""}`);
        if (c.state !== "running") return ok([]);
        return ok(c.ports.flatMap((p) => [`${p.cont}/tcp -> ${p.hostIp || "0.0.0.0"}:${p.host}`, ...(p.hostIp ? [] : [`${p.cont}/tcp -> [::]:${p.host}`])]));
      }
      case "stats": {
        const p = simple(flagSpec("a|all no-stream no-trunc", "format", ""));
        if (p.error) return usage("stats", p.error);
        if (!p.flags["no-stream"]) return na("docker stats keeps refreshing until Ctrl+C. In the playground, add --no-stream for one snapshot.");
        const list = (p.pos.length ? p.pos.map((n) => e.container(n)) : e.containers.filter((c) => c.state === "running" || p.flags.all)).filter(Boolean);
        const mem = (c) => (c.state !== "running" ? 0 : c.proc.app === "report" ? 296 * MB : c.proc.app === "nginx" ? 9.2 * MiB : c.proc.app ? 41 * MiB : 0.6 * MiB);
        const limit = (c) => c.memory || 7.7 * 1024 * MiB;
        const mib = (b) => (b >= 1024 * MiB ? `${(b / 1024 / MiB).toFixed(2)}GiB` : `${(b / MiB).toFixed(2)}MiB`);
        return { code: 0, lines: table([["CONTAINER ID", "NAME", "CPU %", "MEM USAGE / LIMIT", "MEM %", "NET I/O", "BLOCK I/O", "PIDS"],
          ...list.map((c) => [c.id.slice(0, 12), c.name, c.state === "running" ? "0.02%" : "0.00%", `${mib(mem(c))} / ${mib(limit(c))}`, `${(mem(c) / limit(c) * 100).toFixed(2)}%`, c.state === "running" ? "1.2kB / 0B" : "0B / 0B", "0B / 0B", c.state === "running" ? "11" : "0"])]).map((l, i) => [l, i ? "row" : "head"]) };
      }
      case "df": {
        const p = simple(flagSpec("v|verbose", "format", ""));
        if (p.error) return usage("system df", p.error);
        const d = diskUse(e);
        const pct = (a, b) => (b ? `${human(a)} (${Math.round(a / b * 100)}%)` : "0B");
        return { code: 0, lines: table([["TYPE", "TOTAL", "ACTIVE", "SIZE", "RECLAIMABLE"],
          ["Images", d.images, d.activeImages, human(d.imageSize), pct(d.imageFree, d.imageSize)],
          ["Containers", d.containers, d.running, human(d.containers * 1100), `${human((d.containers - d.running) * 1100)} (${d.containers ? Math.round((d.containers - d.running) / d.containers * 100) : 0}%)`],
          ["Local Volumes", d.volumes, d.activeVolumes, human(d.volumeSize), "0B (0%)"],
          ["Build Cache", d.cacheCount, 0, human(d.cacheSize), human(d.cacheSize)]]).map((l, i) => [l, i ? "row" : "head"]) };
      }
      case "container-prune": case "image-prune": case "system-prune": case "builder-prune": {
        const p = simple(flagSpec("f|force a|all volumes", "filter", "filter"));
        if (p.error) return usage(sub.replace("-", " "), p.error);
        return prune(e, sub.split("-")[0], p.flags);
      }
      case "compose": case "login": case "logout": case "push": case "scout": case "cp": case "events": case "attach": case "commit": case "save": case "load": case "export": case "import": case "context": case "swarm": case "service": case "stack": case "search": case "init": case "debug": case "top": case "pause": case "unpause": case "wait": case "rename": case "diff": case "secret": case "config": case "plugin": case "trust": case "manifest": case "node":
        return LAB(`docker ${sub}`);
      default:
        return fail([`docker: unknown command: docker ${sub}`, "", "Run 'docker --help' for more information"]);
    }
  }

  // --- the shell around it --------------------------------------------------------

  const HOST_USERS = { 0: "root", 1000: "dev", 998: "docker" };
  function hostTool(e, cmd, a, sudo) {
    const uid = sudo ? 0 : 1000;
    const say = (t, cls) => ok(String(t).split("\n"), cls);
    const err = (t) => fail(t);
    const pos = a.filter((x) => !/^-/.test(x));
    switch (cmd) {
      case "pwd": return say(e.cwd);
      case "cd": {
        const to = join(e.cwd, (a[0] || HOME).replace(/^~/, HOME));
        const st = stat(e.host, to);
        if (!st) return err(`bash: cd: ${a[0]}: No such file or directory`);
        if (!st.dir) return err(`bash: cd: ${a[0]}: Not a directory`);
        e.cwd = to;
        return ok([]);
      }
      case "ls": return lsLines(e.host, e.cwd, a, (id) => HOST_USERS[id] || String(id));
      case "cat": return catLines(e.host, e.cwd, a, "cat");
      case "echo": return say(a[0] === "-n" ? a.slice(1).join(" ") : a.join(" "));
      case "printf": return { code: 0, lines: (a[0] || "").replace(/%s/g, () => a.splice(1, 1)[0] || "").replace(/\\n/g, "\n").replace(/\\t/g, "\t").replace(/\n$/, "").split("\n").map((l) => [l, ""]) };
      case "id": return say(sudo ? "uid=0(root) gid=0(root) groups=0(root)" : "uid=1000(dev) gid=1000(dev) groups=1000(dev),27(sudo),998(docker)");
      case "whoami": return say(sudo ? "root" : "dev");
      case "touch": {
        for (const f of pos) {
          const p = join(e.cwd, f);
          if (e.host[p]) continue;
          if (!canWrite(stat(e.host, join(p, "..")) || D(), uid, uid)) return err(`touch: cannot touch '${f}': Permission denied`);
          e.host[p] = { text: "", uid, gid: uid, mode: 0o644, v: 0 };
        }
        return ok([]);
      }
      case "mkdir": {
        for (const d of pos) {
          const p = join(e.cwd, d);
          if (stat(e.host, p)) { if (a.includes("-p")) continue; return err(`mkdir: cannot create directory ‘${d}’: File exists`); }
          if (!canWrite(stat(e.host, join(p, "..")) || D(), uid, uid)) return err(`mkdir: cannot create directory ‘${d}’: Permission denied`);
          e.host[p] = D(uid);
        }
        return ok([]);
      }
      case "rm": {
        const rec = a.some((x) => /^-\w*r/i.test(x));
        for (const f of pos) {
          const p = join(e.cwd, f);
          const st = stat(e.host, p);
          if (!st) { if (a.some((x) => /^-\w*f/.test(x))) continue; return err(`rm: cannot remove '${f}': No such file or directory`); }
          if (st.dir && !rec) return err(`rm: cannot remove '${f}': Is a directory`);
          if (!canWrite(stat(e.host, join(p, "..")) || D(), uid, uid)) return err(`rm: cannot remove '${f}': Permission denied`);
          for (const q of under(e.host, p)) delete e.host[q];
        }
        return ok([]);
      }
      case "chown": case "chmod": {
        const [spec, ...paths] = pos;
        if (!spec || !paths.length) return err(`${cmd}: missing operand\nTry '${cmd} --help' for more information.`);
        let owner;
        if (cmd === "chown") {
          const [u, g] = spec.split(":");
          const id = (n) => (/^\d+$/.test(n) ? Number(n) : Object.keys(HOST_USERS).map(Number).find((k) => HOST_USERS[k] === n));
          if (id(u) === undefined) return err(`chown: invalid user: ‘${spec}’`);
          if (g && id(g) === undefined) return err(`chown: invalid group: ‘${spec}’`);
          owner = [id(u), g ? id(g) : undefined];
        }
        for (const f of paths) {
          const p = join(e.cwd, f);
          const st = e.host[p];
          if (!st) return err(`${cmd}: cannot access '${f}': No such file or directory`);
          if (!sudo && (cmd === "chown" || st.uid !== uid)) return err(`${cmd}: changing ${cmd === "chown" ? "ownership" : "permissions"} of '${f}': Operation not permitted`);
          for (const q of a.some((x) => /^-\w*R/.test(x)) ? under(e.host, p) : [p]) {
            const x = e.host[q];
            if (!x) continue;
            if (cmd === "chown") e.host[q] = { ...x, uid: owner[0], gid: owner[1] === undefined ? x.gid : owner[1] };
            else {
              let mode = x.mode == null ? 0o644 : x.mode;
              if (/^[0-7]{3,4}$/.test(spec)) mode = parseInt(spec, 8);
              else {
                const m = /^([ugoa]*)([+-=])([rwx]+)$/.exec(spec);
                if (!m) return err(`chmod: invalid mode: ‘${spec}’`);
                const who = m[1] || "a";
                const bits = (m[3].includes("r") ? 4 : 0) + (m[3].includes("w") ? 2 : 0) + (m[3].includes("x") ? 1 : 0);
                const mask = (who.includes("u") || who.includes("a") ? bits << 6 : 0) | (who.includes("g") || who.includes("a") ? bits << 3 : 0) | (who.includes("o") || who.includes("a") ? bits : 0);
                mode = m[2] === "+" ? mode | mask : m[2] === "-" ? mode & ~mask : (mode & ~0o777) | mask;
              }
              e.host[q] = { ...x, mode };
            }
          }
        }
        return ok([]);
      }
      case "du": {
        const lines = [];
        for (const f of pos.length ? pos : ["."]) {
          const p = join(e.cwd, f);
          if (!stat(e.host, p)) return err(`du: cannot access '${f}': No such file or directory`);
          const n = sizeUnder(e.host, p);
          lines.push(`${n >= GB ? (n / 1024 / MiB).toFixed(1) + "G" : n >= MiB ? Math.round(n / MiB) + "M" : Math.max(4, Math.round(n / 1024)) + "K"}\t${f}`);
        }
        return ok(lines);
      }
      case "curl": {
        const url = a.filter((x) => !x.startsWith("-") && a[a.indexOf(x) - 1] !== "-o" && a[a.indexOf(x) - 1] !== "-m").pop();
        if (!url) return err("curl: try 'curl --help' or 'curl --manual' for more information");
        const r = e.http(null, url);
        if (r.code) return { code: r.code, lines: [[r.text, "warn"]] };
        const head = a.some((x) => /^-\w*[iIv]/.test(x)) ? ["HTTP/1.1 200 OK", `Content-Length: ${r.text.length}`, ""] : [];
        return ok([...head, ...(a.includes("-I") ? [] : r.text.split("\n"))]);
      }
      case "sed": {
        if (!a.includes("-i")) return na("The playground runs sed -i to edit a file in place: sed -i 's/old/new/' Dockerfile");
        const [expr, file] = pos;
        const m = /^s(.)(.*?)\1(.*?)\1(g?)$/.exec(expr || "");
        const p = join(e.cwd, file || "");
        if (!m) return err(`sed: -e expression #1, char ${String(expr || "").length}: unterminated \`s' command`);
        if (!e.host[p] || e.host[p].text === undefined) return err(`sed: can't read ${file}: No such file or directory`);
        let re;
        try { re = new RegExp(m[2].replace(/\\\//g, "/"), m[4] ? "g" : ""); } catch { return err(`sed: -e expression #1: invalid regular expression`); }
        e.writeFile(p, e.host[p].text.split("\n").map((l) => l.replace(re, m[3].replace(/\\\//g, "/").replace(/&/g, "$&"))).join("\n"));
        return ok([]);
      }
      case "grep": {
        const [pattern, ...files] = pos;
        if (!pattern) return err("Usage: grep [OPTION]... PATTERNS [FILE]...");
        const lines = [];
        for (const f of files) {
          const st = e.host[join(e.cwd, f)];
          if (!st || st.text === undefined) return err(`grep: ${f}: No such file or directory`);
          for (const l of st.text.split("\n")) if (l.toLowerCase().includes(pattern.toLowerCase()) || (!a.includes("-i") && l.includes(pattern))) lines.push(files.length > 1 ? `${f}:${l}` : l);
        }
        return { code: lines.length ? 0 : 1, lines: lines.map((l) => [l, ""]) };
      }
      case "node": case "npm": case "npx": case "yarn":
        return err(`Command '${cmd}' not found, but can be installed with:\n\nsudo apt install ${cmd === "npx" ? "npm" : cmd === "yarn" ? "yarnpkg" : cmd}`);
      case "apt": case "apt-get": case "snap": case "systemctl": case "service":
        return LAB(cmd);
      case "vi": case "vim": case "nano": case "code":
        return na("Edit files in the editor beside the terminal, or with echo, printf and sed -i.");
      default:
        return err(`bash: ${cmd}: command not found`);
    }
  }

  function filterLines(lines, [cmd, ...a]) {
    const pos = a.filter((x) => !x.startsWith("-"));
    const num = Number((a.find((x) => /^-n?\d+$/.test(x)) || "").replace(/^-n?/, "")) || Number(a[a.indexOf("-n") + 1]) || 10;
    if (cmd === "grep") {
      const re = pos[0] || "";
      const keep = (t) => (a.includes("-i") ? t.toLowerCase().includes(re.toLowerCase()) : t.includes(re)) !== a.includes("-v");
      return lines.filter((l) => keep(l[0]));
    }
    if (cmd === "head") return lines.slice(0, num);
    if (cmd === "tail") return lines.slice(-num);
    if (cmd === "wc") return [[String(a.includes("-l") ? lines.length : lines.map((l) => l[0]).join("\n").length), ""]];
    if (cmd === "sort") return [...lines].sort((x, y) => x[0].localeCompare(y[0]));
    if (cmd === "less" || cmd === "more" || cmd === "cat") return lines;
    return null;
  }

  // Run one line: commands joined by && || ; with pipes and > redirects.
  function shell(e, line) {
    const expanded = String(line).replace(/\$\(pwd\)|\$\{?PWD\}?/g, e.cwd).replace(/\$\{?HOME\}?/g, HOME).replace(/(^|\s)~(?=\/|\s|$)/g, `$1${HOME}`);
    const toks = lex(expanded);
    if (!toks) return [["bash: unexpected EOF while looking for matching quote", "warn"]];
    const out = [];
    let i = 0, last = 0, skip = false;
    while (i < toks.length) {
      const seg = [];
      while (i < toks.length && !["&&", "||", ";"].includes(toks[i].op)) seg.push(toks[i++]);
      const sep = toks[i] ? toks[i].op : null;
      i++;
      if (!skip && seg.length) {
        const pipes = [[]];
        let redirect = null;
        for (let j = 0; j < seg.length; j++) {
          const t = seg[j];
          if (t.op === "|") pipes.push([]);
          else if (t.op === ">" || t.op === ">>") { redirect = { op: t.op, file: seg[j + 1] && seg[j + 1].w }; j++; }
          else pipes[pipes.length - 1].push(t.w);
        }
        let r = runOne(e, pipes[0]);
        for (const pipe of pipes.slice(1)) {
          const lines = filterLines(r.lines, pipe);
          r = lines ? { code: pipe[0] === "grep" && !lines.length ? 1 : 0, lines } : { code: 1, lines: [[`The playground pipes into grep, head, tail, sort and wc.`, "na"]] };
        }
        if (redirect) {
          if (!redirect.file) r = { code: 2, lines: [["bash: syntax error near unexpected token `newline'", "warn"]] };
          else {
            const path = join(e.cwd, redirect.file);
            const keep = r.lines.filter((l) => l[1] !== "warn" && l[1] !== "na");
            const warn = r.lines.filter((l) => l[1] === "warn" || l[1] === "na");
            const parent = stat(e.host, join(path, ".."));
            if (!parent) r = { code: 1, lines: [[`bash: ${redirect.file}: No such file or directory`, "warn"]] };
            else if (e.host[path] && e.host[path].dir) r = { code: 1, lines: [[`bash: ${redirect.file}: Is a directory`, "warn"]] };
            else if (!canWrite(e.host[path] || parent, 1000, 1000) && !(e.host[path] && e.host[path].uid === 1000)) r = { code: 1, lines: [[`bash: ${redirect.file}: Permission denied`, "warn"]] };
            else {
              const text = keep.map((l) => l[0]).join("\n") + (keep.length ? "\n" : "");
              const old = e.host[path] && e.host[path].text !== undefined ? e.host[path].text : "";
              e.writeFile(path, redirect.op === ">>" ? old + text : text);
              r = { code: r.code, lines: warn };
            }
          }
        }
        out.push(...r.lines);
        last = r.code;
      }
      skip = (sep === "&&" && last !== 0) || (sep === "||" && last === 0);
    }
    return out;
  }

  function runOne(e, w) {
    if (!w.length) return ok([]);
    e.tick(1000);
    let [cmd, ...a] = w;
    let sudo = false;
    if (cmd === "sudo") { sudo = true; [cmd, ...a] = a; if (!cmd) return fail("usage: sudo command"); }
    try {
      if (cmd === "docker") return docker(e, a);
    } catch (err) {
      if (/^template:/.test(err.message)) return fail(err.message);
      throw err;
    }
    return hostTool(e, cmd, a, sudo);
  }

  // --- scenarios -------------------------------------------------------------------

  const file = (text, extra) => ({ text, ...extra });
  const blob = (size, extra) => ({ size, ...extra });
  const dirBlob = (size) => ({ dir: true, size });
  const project = (dir, files) => Object.fromEntries([[dir, D(1000)], ...Object.entries(files).map(([k, v]) => [`${dir}/${k}`, v])]);
  const pkg = (name, deps, dev, size) => file(`{\n  "name": "${name}",\n  "version": "1.0.0",\n  "dependencies": { ${deps.map((d) => `"${d}": "^4.0.0"`).join(", ")} },\n  "devDependencies": { ${dev.map((d) => `"${d}": "^9.0.0"`).join(", ")} }\n}\n`, { deps: size });
  const NODE_IGNORE = "node_modules\n.git\n.env\nlogs\n";
  const nodeDockerfile = (script, user, port) => `FROM node:22-alpine\n${user === "app" ? "RUN addgroup -S -g 10001 app && adduser -S -u 10001 -G app app\n" : ""}WORKDIR /app\nCOPY package*.json ./\nRUN npm ci --omit=dev\nCOPY . .\nUSER ${user}\nEXPOSE ${port}\nCMD ["node", "${script}"]\n`;
  const service = (dir, script, app, user, port, deps) => project(dir, {
    Dockerfile: file(nodeDockerfile(script, user, port)), ".dockerignore": file(NODE_IGNORE),
    "package.json": pkg(app, deps, ["eslint"], { all: 31 * MB, prod: 9.4 * MB, count: [188, 42] }), "package-lock.json": blob(24 * kB),
    [script]: file(`// ${app}: see the README for what it does\nrequire("./src/${app}").start();\n`, { app })
  });
  const SHOP_SERVER = 'const express = require("express");\nconst app = express();\napp.get("/", (req, res) => res.send("shop: ok"));\napp.listen(3000, () => console.log("shop: listening on :3000"));\n';
  const SHOP_DEPS = { all: 186 * MB, prod: 48 * MB, count: [412, 64] };
  const shopFiles = (dockerfile, ignore, hostModules) => project(`${HOME}/shop`, {
    Dockerfile: file(dockerfile), ...(ignore ? { ".dockerignore": file(ignore) } : {}),
    "package.json": pkg("shop", ["express"], ["eslint", "jest", "nodemon"], SHOP_DEPS), "package-lock.json": blob(88 * kB),
    "server.js": file(SHOP_SERVER, { app: "shop" }), "README.md": file("# shop\n\nThe storefront. Run it with: docker build -t quest/shop . && docker run -p 3000:3000 quest/shop\n"),
    public: dirBlob(1.3 * MB), ".git": dirBlob(96 * MB), ...(hostModules ? { node_modules: dirBlob(210 * MB), logs: dirBlob(3.1 * MB), ".env": file("# local settings for development; never copy into an image\nSHOP_DB_HOST=localhost\nSHOP_DB_USER=shop\n") } : {})
  });
  const BIG_DOCKERFILE = 'FROM node:22\nWORKDIR /app\nCOPY . .\nRUN npm ci\nCMD ["node", "server.js"]\n';
  const DEV_DOCKERFILE = 'FROM node:22-alpine\nWORKDIR /app\nCOPY package*.json ./\nRUN npm ci\nCOPY . .\nEXPOSE 3000\nCMD ["node", "server.js"]\n';
  const SLOW_DOCKERFILE = 'FROM node:22-alpine\nWORKDIR /app\nCOPY . .\nRUN npm ci --omit=dev\nEXPOSE 3000\nCMD ["node", "server.js"]\n';

  const byImage = (e, repo) => e.containers.filter((c) => (e.tagsOf(e.images[c.imageId]) || []).some((t) => t.startsWith(repo + ":")));
  const web = (e, port) => { const r = e.http(null, `localhost:${port}`); return { ok: r.code === 0, text: r.code === 0 ? `answers (${r.app})` : r.text.replace(/^curl: \(\d+\) /, "") }; };
  const newestShop = (e) => Object.values(e.images).filter((i) => i.built && e.tagsOf(i).some((t) => t.startsWith("quest/shop:"))).sort((a, b) => b.created - a.created)[0];

  const SCENARIOS = [
    {
      id: "exits", title: "Exits immediately", level: "02",
      story: "You started nginx for the team's preview site an hour ago. The browser says nothing is listening, and docker ps is empty.",
      goal: "Get nginx answering on localhost:8080.",
      done: "nginx answers on localhost:8080.",
      setup: ["docker pull nginx:1.27", "docker run -d --name web -p 8080:80 nginx:1.27 nginx", 3],
      won: (e) => web(e, 8080).ok,
      check: (e) => ({ label: "curl localhost:8080", ...web(e, 8080) }),
      hints: [
        "docker ps shows only running containers. Try docker ps -a: what is the STATUS of web?",
        "Exited (0) means the main process finished on its own, without an error. docker inspect web --format '{{.Config.Cmd}}' shows it ran plain nginx, which starts in the background and returns.",
        "A container lives exactly as long as its first process. Recreate it with the image's default command, which keeps nginx in the foreground: docker rm web && docker run -d --name web -p 8080:80 nginx:1.27"
      ],
      lesson: "A container stops when its main process (PID 1) exits. Servers must stay in the foreground: nginx's default CMD adds -g 'daemon off;' for exactly that reason.",
      tries: ["docker ps", "docker ps -a", "docker logs web"]
    },
    {
      id: "port", title: "Port not published", level: "06",
      story: "The web container is Up and its logs look healthy, but curl localhost:8080 cannot connect.",
      goal: "Make localhost:8080 reach nginx.",
      done: "localhost:8080 reaches nginx.",
      setup: ["docker pull nginx:1.27", "docker run -d --name web nginx:1.27", 10],
      won: (e) => web(e, 8080).ok,
      check: (e) => ({ label: "curl localhost:8080", ...web(e, 8080) }),
      hints: [
        "Run curl localhost:8080, then docker ps. Read the PORTS column for web.",
        "PORTS says 80/tcp: the image exposes port 80 inside the container, but nothing on your machine forwards to it. docker port web prints nothing, and the PortBindings are map[].",
        "Port mappings are fixed when a container is created. Recreate it, mapping host port 8080 to the container's port 80: docker rm -f web && docker run -d --name web -p 8080:80 nginx:1.27"
      ],
      lesson: "EXPOSE only documents a port. -p host:container publishes it, and the container side must be the port the app really listens on.",
      tries: ["curl localhost:8080", "docker ps", "docker inspect web --format '{{.HostConfig.PortBindings}}'"]
    },
    {
      id: "dns", title: "Name not found", level: "07",
      story: "The api container talks to Redis at the hostname cache. Both containers were started with plain docker run, and api exits a second after it starts.",
      goal: "Let api reach cache by its name, on a user-defined network.",
      done: "api reaches cache by name.",
      files: service(`${HOME}/api`, "api.js", "api", "node", 8080, ["ioredis"]),
      setup: ["docker pull redis:7.4", `cd ${HOME}/api`, "docker build -t quest/api:1.0 .", `cd ${HOME}`, 120, "docker run -d --name cache redis:7.4", "docker run -d --name api -p 8080:8080 quest/api:1.0", 2],
      won: (e) => { const c = e.container("api"); return Boolean(c && c.state === "running" && c.proc.via === "dns" && web(e, 8080).ok); },
      check: (e) => {
        const c = e.container("api");
        const up = c && c.state === "running";
        return { label: "api → cache:6379", text: !c ? "no api container" : !up ? statusOf(e, c) : c.proc.via === "dns" ? "by name, over DNS" : c.proc.via === "link" ? "through a legacy --link" : "by IP address" };
      },
      hints: [
        "docker ps -a shows api exited. docker logs api says why.",
        "ENOTFOUND cache: the name does not resolve. docker network inspect bridge shows both containers on the default bridge, which has no DNS for container names.",
        "Create a network, attach both containers, then start api again: docker network create app-net && docker network connect app-net cache && docker network connect app-net api && docker start api"
      ],
      lesson: "Only user-defined networks give containers DNS by name. Put services that talk to each other on one, instead of hard-coding IPs or using the legacy --link.",
      tries: ["docker ps -a", "docker logs api", "docker network ls"]
    },
    {
      id: "volmask", title: "Mount hides the app", level: "08",
      story: "To see code changes without rebuilding, you mounted your project folder into the shop container. Since then it exits at once.",
      goal: "Keep /home/dev/shop mounted at /app and get the shop answering on localhost:3000.",
      done: "The shop answers, with your folder still mounted.",
      files: shopFiles(DEV_DOCKERFILE, NODE_IGNORE, false),
      setup: [`cd ${HOME}/shop`, "docker build -t quest/shop:1.0 .", 30, `docker run -d --name shop -p 3000:3000 -v ${HOME}/shop:/app quest/shop:1.0`, 1],
      won: (e) => web(e, 3000).ok && byImage(e, "quest/shop").some((c) => c.state === "running" && c.mounts.some((m) => m.type === "bind" && m.source === `${HOME}/shop` && m.dest === "/app")),
      check: (e) => ({ label: "curl localhost:3000", ...web(e, 3000) }),
      hints: [
        "docker logs shop: the app cannot find express. Yet the image installed it: docker run --rm quest/shop:1.0 ls /app shows node_modules.",
        "The bind mount lays your folder over /app, and your folder has no node_modules (ls). A mount hides whatever the image had at that path.",
        "Keep the bind mount and give node_modules its own volume, which Docker fills from the image: docker rm shop && docker run -d --name shop -p 3000:3000 -v /home/dev/shop:/app -v /app/node_modules quest/shop:1.0"
      ],
      lesson: "A mount replaces what the image has at that path. A named or anonymous volume on the inner path brings the image's files back, because Docker copies them into an empty volume.",
      tries: ["docker ps -a", "docker logs shop", "ls -a"]
    },
    {
      id: "perms", title: "Permission denied", level: "09",
      story: "The uploader stores files in /srv/uploads on the host. The image was hardened to run as a non-root user, and now it exits with EACCES.",
      goal: "Run uploader as its non-root user, writing to /srv/uploads, without making the folder writable by everyone.",
      done: "uploader writes to /srv/uploads as a non-root user.",
      files: { ...service(`${HOME}/uploader`, "uploader.js", "uploader", "app", 8080, ["busboy"]), "/srv/uploads": D() },
      setup: [`cd ${HOME}/uploader`, "docker build -t quest/uploader:1.0 .", `cd ${HOME}`, 60, "docker run -d --name uploader -p 8080:8080 -v /srv/uploads:/data/uploads quest/uploader:1.0", 1],
      won: (e) => byImage(e, "quest/uploader").some((c) => c.state === "running" && e.userOf(c).uid !== 0 && c.mounts.some((m) => m.source === "/srv/uploads" && m.dest === "/data/uploads")) && !(e.host["/srv/uploads"].mode & 0o002),
      check: (e) => {
        const c = byImage(e, "quest/uploader").find((x) => x.state === "running") || byImage(e, "quest/uploader")[0];
        const open = e.host["/srv/uploads"] && e.host["/srv/uploads"].mode & 0o002;
        const text = !c ? "no uploader container" : c.state !== "running" ? statusOf(e, c) : e.userOf(c).uid === 0 ? "running as root" : open ? "folder writable by everyone" : `writing as uid ${e.userOf(c).uid}`;
        return { label: "uploader → /srv/uploads", text };
      },
      hints: [
        "docker logs uploader: EACCES on /data/uploads. Who does the app run as? docker run --rm quest/uploader:1.0 id",
        "The app is uid 10001. ls -ln /srv shows uploads owned by uid 0 with mode drwxr-xr-x: only root may write. A bind mount keeps the host's owner and mode, and the host has no user called app.",
        "Give the folder to the app's uid, then start the container again: sudo chown -R 10001:10001 /srv/uploads && docker start uploader"
      ],
      lesson: "Bind mounts keep host ownership, matched by number, not by name. Match the folder's owner to the container's UID instead of running as root or opening the folder to everyone.",
      tries: ["docker logs uploader", "ls -ln /srv", "docker run --rm quest/uploader:1.0 id"]
    },
    {
      id: "bigimage", title: "1.6 GB image", level: "05",
      story: "The shop image takes minutes to push and to start on new servers. docker images says it is 1.6 GB, for a 60-line web server.",
      goal: "Build quest/shop under 250 MB, with no .git or .env inside, and still working. Keep both files in your project.",
      done: "quest/shop is small, clean and still runs.",
      edit: [".dockerignore", "Dockerfile"],
      focus: "quest/shop",
      files: shopFiles(BIG_DOCKERFILE, null, true),
      setup: [`cd ${HOME}/shop`, "docker build -t quest/shop:1.0 .", 1440],
      won: (e) => {
        const img = newestShop(e);
        return Boolean(img && e.imageSize(img) < 250 * MB && !stat(img.fs, "/app/.git") && !stat(img.fs, "/app/.env") && e.trial(img).ok && e.host[`${HOME}/shop/.git`] && e.host[`${HOME}/shop/.env`]);
      },
      check: (e) => {
        const img = newestShop(e) || e.image("quest/shop:1.0");
        const size = e.imageSize(img);
        const problems = [stat(img.fs, "/app/.git") && ".git inside", stat(img.fs, "/app/.env") && ".env inside", !e.trial(img).ok && "does not start"].filter(Boolean);
        return { label: `${e.tagsOf(img)[0] || "quest/shop"} size`, text: [human(size), ...problems].join(" · ") };
      },
      hints: [
        "docker images, then docker history quest/shop:1.0. Which layers are big, and what did they copy?",
        "COPY . . sends everything in the folder: .git, your local node_modules, logs, even .env. The build output's \"transferring context\" says how much. node:22 alone is 1.12GB, and npm ci also installs test tools.",
        "In the editor: a .dockerignore with .git, node_modules, logs and .env; and a Dockerfile in two stages on node:22-alpine: FROM node:22-alpine AS deps, WORKDIR /app, COPY package*.json ./, RUN npm ci --omit=dev, then FROM node:22-alpine, WORKDIR /app, COPY --from=deps /app/node_modules ./node_modules, COPY . ., USER node, CMD [\"node\", \"server.js\"]. Then: docker build -t quest/shop:1.1 ."
      ],
      lesson: "Image size is the sum of every layer. Keep the build context clean with .dockerignore, start from a small base, and ship only what runs: production dependencies, copied from a build stage.",
      tries: ["docker images", "docker history quest/shop:1.0", "ls -la"]
    },
    {
      id: "cache", title: "Cache busted on every change", level: "04",
      story: "Every one-line change to server.js makes docker build reinstall all dependencies. The team waits on it dozens of times a day.",
      goal: "Change server.js and rebuild with the npm ci step still CACHED.",
      done: "Source changes no longer reinstall dependencies.",
      edit: ["Dockerfile", "server.js"],
      focus: "quest/shop",
      files: shopFiles(SLOW_DOCKERFILE, NODE_IGNORE, true),
      setup: [`cd ${HOME}/shop`, "docker build -t quest/shop:1.0 .", 90, "echo '// faster checkout' >> server.js"],
      won: (e) => {
        const b = e.lastBuild;
        if (!b || !b.user) return false;
        const i = b.steps.findIndex((s) => /^RUN .*\b(npm|yarn) (ci|install|i)\b/.test(s.text));
        return i >= 0 && b.steps[i].cached && b.steps.slice(i + 1).some((s) => /^COPY/.test(s.text) && !s.cached) && e.trial(e.images[b.image]).ok;
      },
      check: (e) => {
        const b = e.lastBuild;
        const step = b && b.steps.find((s) => /^RUN .*\b(npm|yarn) (ci|install|i)\b/.test(s.text));
        return { label: "npm ci on the last build", text: !b ? "not built yet" : !step ? "no install step" : step.cached ? "CACHED" : "ran again" };
      },
      hints: [
        "server.js already has an edit. Run docker build -t quest/shop:1.1 . and read the steps: which say CACHED, and which ran?",
        "A step's cache breaks when anything it copies changes, and every step after it runs again. COPY . . copies server.js, so any edit reruns npm ci.",
        "Copy only the dependency files, install, then copy the rest: in the Dockerfile put COPY package*.json ./ and RUN npm ci --omit=dev before COPY . . Build, change server.js (echo '// tweak' >> server.js), and build again."
      ],
      lesson: "Order a Dockerfile from what changes least to what changes most. Dependency files and their install step go before the source code, so only the last layers rebuild.",
      tries: ["docker build -t quest/shop:1.1 .", "cat Dockerfile", "docker history quest/shop:1.0"]
    },
    {
      id: "oom", title: "OOMKilled", level: "11",
      story: "The report service was given a memory limit during a cost review. It now dies a few seconds after every start, with nothing in the logs.",
      goal: "Get report running again, with a memory limit it can live with.",
      done: "report runs within its memory limit.",
      files: service(`${HOME}/report`, "report.js", "report", "node", 8080, ["csv-parse"]),
      setup: [`cd ${HOME}/report`, "docker build -t quest/report:2.0 .", `cd ${HOME}`, 600, "docker run -d --name report -p 8080:8080 --memory 128m quest/report:2.0", 4],
      won: (e) => byImage(e, "quest/report").some((c) => c.state === "running" && c.memory > 0 && !c.proc.hung) && web(e, 8080).ok,
      check: (e) => {
        const c = byImage(e, "quest/report").find((x) => x.state === "running") || byImage(e, "quest/report")[0];
        const text = !c ? "no report container" : c.state !== "running" ? `${statusOf(e, c)}${c.oom ? ", OOMKilled" : ""}` : !c.memory ? "running with no memory limit" : c.proc.hung ? "stuck at its limit" : `running, limit ${Math.round(c.memory / MiB)}MiB`;
        return { label: "report", text };
      },
      hints: [
        "docker ps -a: report Exited (137). 137 is 128 + 9: the process got signal 9, SIGKILL.",
        "docker inspect report --format '{{.State.OOMKilled}}' prints true: the kernel killed it at its memory limit. --format '{{.HostConfig.Memory}}' shows 134217728 bytes (128 MiB), and the logs say it loads about 300 MB.",
        "Raise the limit (memory and swap together, or Docker refuses), then start it: docker update --memory 512m --memory-swap 512m report && docker start report"
      ],
      lesson: "Exit code 137 with OOMKilled true means the memory limit, not a bug in the code. Size the limit to what the app really uses, measured with docker stats, and keep one.",
      tries: ["docker ps -a", "docker logs report", "docker inspect report --format '{{.State.OOMKilled}}'"]
    }
  ];
  const GROUPS = [["Basics", ["exits", "port"]], ["Networking", ["dns"]], ["Storage", ["volmask", "perms"]], ["Images and builds", ["cache", "bigimage"]], ["Production", ["oom"]]];
  const ORDER = GROUPS.flatMap(([, ids]) => ids);
  SCENARIOS.sort((a, b) => ORDER.indexOf(a.id) - ORDER.indexOf(b.id));

  // Fill a cheat sheet command's <blanks> from what the open scenario has.
  function fillBlanks(e, cmd) {
    const trouble = e.containers.find((c) => c.state !== "running") || e.containers[0];
    const userNet = Object.values(e.networks).find((n) => n.user);
    const v = {
      name: trouble && trouble.name, image: trouble ? trouble.image : e.scenario.focus ? `${e.scenario.focus}:1.0` : null,
      network: userNet ? userNet.name : "app-net", volume: Object.keys(e.volumes).find((n) => !e.volumes[n].anon) || "app-data", tag: "quest/demo:1.0"
    };
    return cmd.replace(/<([a-z]+)>/g, (m, k) => (v[k] == null ? m : String(v[k])));
  }

  const HELP = [
    "The playground runs a modelled Docker engine. It understands:",
    "  docker run | create | start | stop | restart | kill | rm | ps [-a] | logs | inspect | exec | port | update | stats --no-stream",
    "  docker images | pull | tag | rmi | history | build [-t] [-f] [--no-cache] | system df | system prune | image prune | builder prune",
    "  docker volume ls|create|inspect|rm      docker network ls|create|inspect|rm|connect|disconnect",
    "  on your machine: curl, ls, cat, cd, pwd, echo, printf, touch, mkdir, rm, du -sh, chown, chmod, id, sed -i, grep (and sudo)",
    "  && and ; chain commands; | pipes into grep, head, tail, sort or wc -l; > and >> write files.",
    "  hint (three per scenario), reset, next, clear"
  ];

  root.DQSim = { SCENARIOS, GROUPS, Engine, shell, human, parseDockerfile, fillBlanks, lex, parseBytes };

  // --- UI ------------------------------------------------------------------------

  if (typeof document === "undefined") return;
  const term = document.getElementById("pg-term");
  if (!term) return;

  const out = document.getElementById("pg-out");
  const form = document.getElementById("pg-form");
  const input = document.getElementById("pg-input");
  const map = document.getElementById("pg-map");
  const goal = document.getElementById("pg-goal");
  const picker = document.getElementById("pg-scenarios");
  const tries = document.getElementById("pg-try");
  const editor = document.getElementById("pg-editor");

  const saved = {
    get() { try { return JSON.parse(localStorage.getItem("dq-docker:pg-solved")) || []; } catch { return []; } },
    add(id) { try { localStorage.setItem("dq-docker:pg-solved", JSON.stringify([...new Set([...saved.get(), id])])); } catch { /* private mode */ } }
  };

  let scenario = SCENARIOS[0];
  let engine;
  let solved;
  let hintLevel;
  let editing = null;
  const history = [];
  let historyPos = 0;

  function el(tag, cls, text) {
    const x = document.createElement(tag);
    if (cls) x.className = cls;
    if (text != null) x.textContent = text;
    return x;
  }
  function print(text, cls) {
    out.append(el("div", "pg-line" + (cls ? " " + cls : ""), text));
    out.scrollTop = out.scrollHeight;
  }

  function renderPicker() {
    const done = new Set(saved.get());
    picker.replaceChildren(...GROUPS.map(([group, ids]) => {
      const row = el("div", "pg-group");
      const items = el("div", "pg-group-items");
      for (const s of ids.map((id) => SCENARIOS.find((x) => x.id === id))) {
        const b = el("button", "pg-scn");
        b.type = "button";
        b.setAttribute("aria-pressed", String(s === scenario));
        if (done.has(s.id)) b.append(el("span", "pg-scn-done", "✓"));
        b.append(document.createTextNode(s.title));
        b.title = done.has(s.id) ? `${s.title} (solved)` : s.title;
        b.addEventListener("click", () => load(s.id));
        items.append(b);
      }
      const n = ids.filter((id) => done.has(id)).length;
      const name = el("span", "pg-group-name", group);
      name.append(el("span", "pg-group-count" + (n === ids.length ? " done" : ""), `${n}/${ids.length}`));
      row.append(name, items);
      return row;
    }));
  }

  // Container states at the last render, so a container that comes up flashes once.
  let seen = new Map();
  function chip(c) {
    const state = c.state === "running" ? "ok" : c.state === "created" || c.state === "restarting" ? "wait" : "bad";
    const was = seen.get(c.id);
    const b = el("button", `pg-ctr ${state}${was === undefined ? " is-new" : was !== "ok" && state === "ok" ? " is-healed" : ""}`);
    b.type = "button";
    b.title = `${c.name}: ${statusOf(engine, c)}. Click to use the name.`;
    const dot = el("span", "pg-dot", state === "ok" ? "✓" : state === "wait" ? "…" : "!");
    dot.setAttribute("aria-hidden", "true");
    const ports = c.state === "running" ? c.ports.map((p) => ` :${p.host}→${p.cont}`).join("") : "";
    b.append(dot, el("span", null, c.name), el("span", "pg-ctr-st", c.state === "running" ? `Up${ports}` : c.state === "exited" ? `Exited (${c.exitCode})${c.oom ? " OOM" : ""}` : c.state === "restarting" ? "Restarting" : "Created"));
    b.addEventListener("click", () => {
      const v = input.value;
      input.value = (v && !v.endsWith(" ") ? v + " " : v) + c.name;
      input.focus();
    });
    return b;
  }

  function renderMap() {
    const boxes = [];
    const nets = Object.values(engine.networks).filter((n) => n.name === "bridge" || engine.containers.some((c) => c.nets[n.name] || c.netMode === n.name));
    for (const n of nets) {
      const box = el("div", "pg-net");
      const head = el("div", "pg-net-name", n.name);
      head.append(el("span", "pg-net-kind", n.user ? "user-defined · DNS by name" : n.name === "bridge" ? "default bridge · no DNS" : n.driver));
      box.append(head);
      const list = engine.containers.filter((c) => c.nets[n.name] || c.netMode === n.name);
      if (!list.length) box.append(el("span", "muted small", "No containers"));
      list.forEach((c) => box.append(chip(c)));
      boxes.push(box);
    }
    seen = new Map(engine.containers.map((c) => [c.id, c.state === "running" ? "ok" : c.state]));
    const mounts = engine.containers.flatMap((c) => c.mounts.filter((m) => m.type !== "tmpfs").map((m) => `${c.name}  ${m.type === "bind" ? m.source : m.anon ? "anonymous volume" : m.name} → ${m.dest}`));
    if (mounts.length) {
      const box = el("div", "pg-panel");
      box.append(el("div", "pg-panel-name", "Mounts"), ...mounts.map((t) => el("div", "pg-mono", t)));
      boxes.push(box);
    }
    boxes.push(layersPanel());
    const r = scenario.check(engine);
    const box = el("div", "pg-check " + (scenario.won(engine) ? "ok" : "bad"));
    box.append(el("span", "pg-check-name", r.label), el("span", "pg-check-val", r.text));
    boxes.push(box);
    map.replaceChildren(...boxes);
  }

  // The signature view: an image as a stack of layers with their sizes.
  function layersPanel() {
    const box = el("div", "pg-panel");
    const imgs = Object.values(engine.images).filter((i) => engine.tagsOf(i).length).sort((a, b) => b.created - a.created);
    const focus = scenario.focus ? newestShop(engine) || engine.image(`${scenario.focus}:1.0`) : null;
    if (!focus) {
      box.append(el("div", "pg-panel-name", "Images"));
      for (const i of imgs) {
        const row = el("div", "pg-img");
        row.append(el("span", "pg-mono", engine.tagsOf(i)[0]), el("span", "pg-size", human(engine.imageSize(i))));
        box.append(row);
      }
      return box;
    }
    const total = engine.imageSize(focus);
    const head = el("div", "pg-panel-name", `Layers of ${engine.tagsOf(focus)[0]}`);
    head.append(el("span", "pg-size", human(total)));
    box.append(head);
    const base = focus.layers.filter((l) => !l.created || l.created < focus.created - 1).reduce((n, l) => n + l.size, 0);
    const own = focus.layers.filter((l) => l.created >= focus.created - 1 && l.size > 0);
    const rows = [["FROM (base image)", base], ...own.map((l) => [l.by.replace(/ # buildkit$/, "").replace(/^RUN \/bin\/sh -c /, "RUN "), l.size])];
    const max = Math.max(...rows.map((x) => x[1]));
    for (const [label, size] of rows) {
      const row = el("div", "pg-layer" + (size > 200 * MB ? " big" : ""));
      const bar = el("span", "pg-layer-bar");
      bar.style.width = `${Math.max(1.5, size / max * 100)}%`;
      row.append(el("span", "pg-layer-by", label), el("span", "pg-size", human(size)), bar);
      box.append(row);
    }
    return box;
  }

  function renderEditor() {
    editor.hidden = !scenario.edit;
    if (!scenario.edit) return;
    const dir = `${HOME}/shop`;
    if (!editing || !scenario.edit.includes(editing)) editing = scenario.edit[0];
    const tabs = el("div", "seg");
    tabs.setAttribute("role", "tablist");
    tabs.setAttribute("aria-label", "File");
    for (const f of scenario.edit) {
      const b = el("button", null, f);
      b.type = "button";
      b.setAttribute("role", "tab");
      b.setAttribute("aria-selected", String(f === editing));
      b.addEventListener("click", () => { editing = f; renderEditor(); });
      tabs.append(b);
    }
    const area = el("textarea", "pg-edit");
    area.spellcheck = false;
    area.setAttribute("autocapitalize", "off");
    area.setAttribute("aria-label", `Edit ${editing}`);
    area.rows = 9;
    const f = engine.host[`${dir}/${editing}`];
    area.value = f && f.text !== undefined ? f.text : "";
    area.placeholder = editing === ".dockerignore" ? "No .dockerignore yet. One pattern per line, for example: .git" : "";
    area.addEventListener("input", () => { engine.writeFile(`${dir}/${editing}`, area.value); });
    const note = el("p", "note", `${dir}/${editing}. Saved as you type; then run docker build in the terminal.`);
    editor.replaceChildren(el("div", "pg-panel-name", "Editor"), tabs, area, note);
  }

  function renderTries() {
    tries.replaceChildren(el("span", "muted small", "Try"), ...[...scenario.tries, "hint", "reset"].map((cmd) => {
      const b = el("button", "chip", cmd);
      b.type = "button";
      b.addEventListener("click", () => { run(cmd); input.focus(); });
      return b;
    }));
  }

  function load(id) {
    scenario = SCENARIOS.find((s) => s.id === id) || SCENARIOS[0];
    engine = new Engine(scenario);
    seen = new Map();
    solved = false;
    hintLevel = 0;
    editing = null;
    out.replaceChildren();
    print(`On call. ${scenario.story}`, "dim");
    print("Find out why with docker, then fix it. Type 'help' for commands, 'hint' if stuck.", "dim");
    print("");
    goal.textContent = "Goal: " + scenario.goal;
    goal.className = "pg-goal";
    renderPicker();
    renderTries();
    renderEditor();
    renderMap();
    const current = picker.querySelector('[aria-pressed="true"]');
    if (current && picker.scrollWidth > picker.clientWidth) picker.scrollLeft = current.offsetLeft - picker.querySelector(".pg-group-name").offsetLeft - 48;
  }

  function check() {
    if (solved || !scenario.won(engine)) return;
    solved = true;
    saved.add(scenario.id);
    renderPicker();
    const b = picker.querySelector('.pg-scn[aria-pressed="true"]');
    if (b) {
      b.classList.add("just-solved");
      b.closest(".pg-group").querySelector(".pg-group-count").classList.add("bump");
    }
    goal.textContent = "Fixed. " + scenario.done;
    goal.className = "pg-goal done";
    print("");
    print("✓ Fixed. " + scenario.lesson, "ok");
    const lv = (window.QUEST && window.QUEST.levels.find((l) => l.id === scenario.level)) || null;
    if (lv) print(`  Practise it on your own machine in Level ${lv.id} · ${lv.title}.`, "dim");
    const next = SCENARIOS.find((s) => !saved.get().includes(s.id));
    print(next ? `  Next scenario: ${next.title}. Pick it above, or type 'next'.` : "  You solved every scenario. Try the labs on your own machine next.", "dim");
  }

  function run(raw) {
    const line = raw.trim();
    print("$ " + line, "cmd");
    if (!line) return;
    if (line === "help") return HELP.forEach((x) => print(x, "dim"));
    if (line === "clear") return out.replaceChildren();
    if (line === "reset") return load(scenario.id);
    if (line === "next") {
      const next = SCENARIOS.find((s) => !saved.get().includes(s.id) && s !== scenario) || SCENARIOS[(SCENARIOS.indexOf(scenario) + 1) % SCENARIOS.length];
      return load(next.id);
    }
    if (line === "hint") return print(scenario.hints[Math.min(hintLevel++, scenario.hints.length - 1)], "dim");
    let result;
    try { result = shell(engine, line); } catch {
      result = [["(the playground could not run that command; check its quoting, or type 'help')", "warn"]];
    }
    for (const [text, cls] of result) print(text, cls);
    renderMap();
    if (scenario.edit && document.activeElement && !document.activeElement.classList.contains("pg-edit")) renderEditor();
    check();
  }

  function complete() {
    const v = input.value;
    const start = v.lastIndexOf(" ") + 1;
    const stem = v.slice(start);
    const names = [...engine.containers.map((c) => c.name), ...Object.keys(engine.tags), ...Object.keys(engine.networks), ...Object.keys(engine.volumes).filter((n) => !engine.volumes[n].anon),
      ...kids(engine.host, engine.cwd), "docker", "run", "ps", "logs", "inspect", "exec", "start", "stop", "restart", "images", "history", "build", "network", "volume", "connect", "create", "update", "system", "--memory", "--memory-swap", "--format", "--name", "--network"];
    const hits = [...new Set(names)].filter((n) => n.startsWith(stem) && n !== stem);
    if (hits.length === 1) input.value = v.slice(0, start) + hits[0] + " ";
    else if (hits.length > 1) {
      let common = hits[0];
      for (const x of hits) while (!x.startsWith(common)) common = common.slice(0, -1);
      if (common.length > stem.length) input.value = v.slice(0, start) + common;
      else print(hits.join("   "), "dim");
    }
  }

  form.addEventListener("submit", (ev) => {
    ev.preventDefault();
    const value = input.value;
    if (value.trim()) { history.push(value); historyPos = history.length; }
    input.value = "";
    run(value);
  });
  input.addEventListener("keydown", (ev) => {
    if (ev.key === "ArrowUp" && historyPos > 0) { historyPos--; input.value = history[historyPos]; ev.preventDefault(); }
    if (ev.key === "ArrowDown") { historyPos = Math.min(history.length, historyPos + 1); input.value = history[historyPos] || ""; ev.preventDefault(); }
    if (ev.key === "Tab" && input.value.trim()) { ev.preventDefault(); complete(); }
  });
  out.addEventListener("click", () => { if (!window.getSelection().toString()) input.focus(); });

  const reveal = () => { term.scrollIntoView({ block: "center" }); input.focus({ preventScroll: true }); };
  window.DQPlayground = {
    scenarios: SCENARIOS.map((s) => ({ id: s.id, title: s.title })),
    load: (id) => { load(id); reveal(); },
    // From the cheat sheet: open the scenario a command needs, fill its blanks and run it.
    prefill: (cmd, where) => {
      if (where && where !== "any" && where !== scenario.id) load(where);
      reveal();
      const full = fillBlanks(engine, cmd);
      if (/<[a-z]+>/.test(full)) input.value = full;
      else run(full);
    }
  };
  load(SCENARIOS[0].id);
})(typeof window !== "undefined" ? window : globalThis);
