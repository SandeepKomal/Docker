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
  // With env, $NAME and ${NAME} expand outside single quotes.
  function lex(line, env) {
    const out = [];
    let cur = "", q = null, has = false;
    const push = () => { if (cur || has) out.push({ w: cur }); cur = ""; has = false; };
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      const v = env && ch === "$" && q !== "'" ? /^\$(?:\{(\w+)\}|(\w+))/.exec(line.slice(i)) : null;
      if (v) { cur += env[v[1] || v[2]] ?? ""; i += v[0].length - 1; continue; }
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
    let s = st.dir ? "d" : st.socket ? "s" : "-";
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
  // The capabilities Docker gives a container unless told otherwise.
  const DEFAULT_CAPS = ["AUDIT_WRITE", "CHOWN", "DAC_OVERRIDE", "FOWNER", "FSETID", "KILL", "MKNOD", "NET_BIND_SERVICE", "NET_RAW", "SETFCAP", "SETGID", "SETPCAP", "SETUID", "SYS_CHROOT"];
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
    "postgres:17": {
      size: 435 * MB, os: "debian", bins: ["postgres", "psql", "pg_isready"], users: { postgres: [999, 999] }, env: ["PG_MAJOR=17", "PGDATA=/var/lib/postgresql/data"], expose: [5432],
      entrypoint: ["docker-entrypoint.sh"], cmd: ["postgres"], vol: ["/var/lib/postgresql/data"], stop: "SIGINT", fs: { "/var/lib/postgresql/data": D(999) },
      hist: [["# debian.sh --arch 'amd64' out/ 'bookworm' '@1729555200'", 0.17], ["RUN /bin/sh -c set -eux; groupadd -r postgres --gid=999; useradd -r -g postgres --uid=999 postgres # buildkit", 0], ["ENV PG_MAJOR=17", 0],
        ["RUN /bin/sh -c set -ex; apt-get update; apt-get install -y --no-install-recommends postgresql-common \"postgresql-$PG_MAJOR=$PG_VERSION\" # buildkit", null],
        ['VOLUME [/var/lib/postgresql/data]', 0], ['ENTRYPOINT ["docker-entrypoint.sh"]', 0], ["STOPSIGNAL SIGINT", 0], ["EXPOSE map[5432/tcp:{}]", 0], ['CMD ["postgres"]', 0]]
    },
    "postgres:16": {
      size: 432 * MB, os: "debian", bins: ["postgres", "psql", "pg_isready"], users: { postgres: [999, 999] }, env: ["PG_MAJOR=16", "PGDATA=/var/lib/postgresql/data"], expose: [5432],
      entrypoint: ["docker-entrypoint.sh"], cmd: ["postgres"], vol: ["/var/lib/postgresql/data"], stop: "SIGINT", fs: { "/var/lib/postgresql/data": D(999) },
      hist: [["# debian.sh --arch 'amd64' out/ 'bookworm' '@1729555200'", 0.17], ["ENV PG_MAJOR=16", 0], ["RUN /bin/sh -c set -ex; apt-get update; apt-get install -y --no-install-recommends postgresql-common \"postgresql-$PG_MAJOR=$PG_VERSION\" # buildkit", null],
        ['VOLUME [/var/lib/postgresql/data]', 0], ['ENTRYPOINT ["docker-entrypoint.sh"]', 0], ["EXPOSE map[5432/tcp:{}]", 0], ['CMD ["postgres"]', 0]]
    },
    "redis:7.4": {
      size: 117 * MB, os: "debian", bins: ["redis-server", "redis-cli"], users: { redis: [999, 999] }, expose: [6379], entrypoint: ["docker-entrypoint.sh"], cmd: ["redis-server"],
      fs: { "/data": D(999) }, vol: ["/data"],
      hist: [["# debian.sh --arch 'amd64' out/ 'bookworm' '@1729555200'", 0.6], ["RUN /bin/sh -c set -eux; groupadd -r -g 999 redis; useradd -r -g redis -u 999 redis # buildkit", 0], ["ENV REDIS_VERSION=7.4.1", 0],
        ["RUN /bin/sh -c set -eux; apt-get update; apt-get install -y --no-install-recommends ca-certificates wget dpkg-dev gcc make # buildkit", null],
        ["VOLUME [/data]", 0], ['ENTRYPOINT ["docker-entrypoint.sh"]', 0], ["EXPOSE map[6379/tcp:{}]", 0], ['CMD ["redis-server"]', 0]]
    }
  };
  const ALIASES = {
    "nginx:latest": "nginx:1.27", "postgres:latest": "postgres:17", "node:latest": "node:22", "node:lts": "node:22", "node:22-bookworm": "node:22",
    "node:22-bookworm-slim": "node:22-slim", "alpine:latest": "alpine:3.20", "ubuntu:latest": "ubuntu:24.04", "redis:latest": "redis:7.4"
  };
  const normRef = (ref) => {
    let r = String(ref).replace(/^docker\.io\//, "").replace(/^library\//, "");
    if (!/:[^/]+$/.test(r) && !r.includes("@")) r += ":latest";
    return r;
  };
  const hostOf = (ref) => (/^[^/]+[.:][^/]*\//.test(ref) ? ref.split("/")[0] : "docker.io");
  const fullRef = (ref) => (hostOf(ref) !== "docker.io" ? ref : `docker.io/${ref.includes("/") ? "" : "library/"}${ref}`);
  const capName = (c) => String(c).toUpperCase().replace(/^CAP_/, "");

  // --- what programs do when they run ------------------------------------------

  const nodeTrace = (lines) => [...lines, "", "Node.js v22.11.0"];
  const PAGE_403 = "<html>\n<head><title>403 Forbidden</title></head>\n<body>\n<center><h1>403 Forbidden</h1></center>\n<hr><center>nginx/1.27.3</center>\n</body>\n</html>";
  // A small Express app that listens where HOST says, 0.0.0.0 by default.
  const webApp = (name, port, mod) => ({
    port, body: (e, c) => { const v = [...e.images[c.imageId].config.Env, ...c.env].reverse().find((kv) => kv.startsWith("APP_VERSION=")); return `${name}: ok${v ? ` (version ${v.split("=")[1]})` : ""}`; },
    start(x) {
      const host = x.env.HOST || "0.0.0.0";
      const debug = x.env.LOG_LEVEL === "debug" || x.args.includes("--verbose");
      const handlesTerm = /SIGTERM/.test((x.view[x.script] || {}).text || "");
      return x.module(mod || "express") || { logs: [...(debug ? [`${name}: debug logging on`] : []), `${name}: listening on ${host}:${port}`], loopback: /^(127\.0\.0\.1|localhost)$/.test(host), debug, handlesTerm };
    }
  });
  // A Node service that needs a database or queue before it can serve.
  const dbClient = (name, port, envName, fallback, dbPort, mod) => ({
    port, body: `${name}: ok`,
    start(x) {
      const missing = x.module(mod);
      if (missing) return missing;
      const host = x.env[envName] || fallback;
      const logs = [`${name}: connecting to ${host}:${dbPort}`];
      const r = x.e.resolve(x.c, host);
      if (!r) return { code: 1, logs: nodeTrace([...logs, `Error: getaddrinfo ENOTFOUND ${host}`, "    at GetAddrInfoReqWrap.onlookupall [as oncomplete] (node:dns:120:26) {", "  errno: -3008,", "  code: 'ENOTFOUND',", "  syscall: 'getaddrinfo',", `  hostname: '${host}'`, "}"]) };
      const t = r.target;
      if (!t || !t.proc.listens.includes(dbPort) || (t.proc.readyAt || 0) > x.e.now) return { code: 1, logs: nodeTrace([...logs, `Error: connect ECONNREFUSED ${r.ip}:${dbPort}`, "    at TCPConnectWrap.afterConnect [as oncomplete] (node:net:1615:16) {", "  errno: -111,", "  code: 'ECONNREFUSED',", "  syscall: 'connect',", `  address: '${r.ip}',`, `  port: ${dbPort}`, "}"]) };
      return { logs: [...logs, `${name}: connected`, `${name}: listening on :${port}`], via: r.via };
    }
  });
  const nginxBody = (e, c) => { const f = e.view(c)["/usr/share/nginx/html/index.html"]; return f && f.text !== undefined ? f.text.replace(/\n$/, "") : PAGE_403; };
  const APPS = {
    nginx: {
      port: 80, stopCode: 0, body: nginxBody,
      start(x) {
        const t = `${stamp(x.e.now)} [emerg] 1#1:`;
        if (x.c.readOnly) {
          for (const [dir, msg] of [["/var/cache/nginx", 'mkdir() "/var/cache/nginx/client_temp" failed (30: Read-only file system)'], ["/var/run", 'open() "/var/run/nginx.pid" failed (30: Read-only file system)']]) {
            if (!x.c.mounts.some((m) => m.dest === dir)) return { code: 1, logs: [`${t} ${msg}`, `nginx: [emerg] ${msg}`] };
          }
        }
        if (x.uid === 0 && !x.caps.has("CHOWN")) return { code: 1, logs: [`${t} chown("/var/cache/nginx/client_temp", 101) failed (1: Operation not permitted)`, 'nginx: [emerg] chown("/var/cache/nginx/client_temp", 101) failed (1: Operation not permitted)'] };
        const logs = [`${stamp(x.e.now)} [notice] 1#1: using the "epoll" event method`, `${stamp(x.e.now)} [notice] 1#1: nginx/1.27.3`, `${stamp(x.e.now)} [notice] 1#1: start worker processes`];
        if (x.e.pidsFree() < 64) return { hung: true, logs: [...logs, `${stamp(x.e.now)} [alert] 1#1: fork() failed while spawning "worker process" (11: Resource temporarily unavailable)`] };
        const missing = ["SETGID", "SETUID"].find((cap) => x.uid === 0 && !x.caps.has(cap));
        if (missing) return { hung: true, logs: [...logs, `${stamp(x.e.now)} [notice] 1#1: start worker process 29`, `${stamp(x.e.now)} [emerg] 29#29: ${missing.toLowerCase()}(101) failed (1: Operation not permitted)`, `${stamp(x.e.now)} [alert] 1#1: worker process 29 exited with fatal code 2 and cannot be respawned`] };
        return { logs };
      }
    },
    redis: { port: 6379, stopCode: 0, start: () => ({ logs: ["1:M 30 Oct 2026 09:00:00.000 * Server initialized", "1:M 30 Oct 2026 09:00:00.000 * Ready to accept connections tcp"] }) },
    postgres: {
      port: 5432, stopCode: 0,
      start(x) {
        const major = (x.env.PG_MAJOR || "17");
        const ver = x.view["/var/lib/postgresql/data/PG_VERSION"];
        const ts = `${iso(x.e.now).slice(0, 19).replace("T", " ")}.000 UTC [1]`;
        if (ver && ver.text.trim() !== major) {
          return { code: 1, logs: ["", "PostgreSQL Database directory appears to contain a database; Skipping initialization", "", `${ts} FATAL:  database files are incompatible with server`, `${ts} DETAIL:  The data directory was initialized by PostgreSQL version ${ver.text.trim()}, which is not compatible with this version ${major === "17" ? "17.2" : "16.6"} (Debian ${major === "17" ? "17.2-1.pgdg120+1" : "16.6-1.pgdg120+1"}).`] };
        }
        if (ver) return { readyAt: x.e.now + 3000, logs: ["", "PostgreSQL Database directory appears to contain a database; Skipping initialization", "", `${ts} LOG:  database system is ready to accept connections`] };
        // First start: initialise the data directory in its volume.
        const m = x.c.mounts.find((mt) => mt.dest === "/var/lib/postgresql/data" && mt.type === "volume");
        if (m && (x.env.POSTGRES_PASSWORD || x.env.POSTGRES_HOST_AUTH_METHOD === "trust")) x.e.volumes[m.name].fs["/PG_VERSION"] = { text: major + "\n", uid: 999 };
        if (!x.env.POSTGRES_PASSWORD && x.env.POSTGRES_HOST_AUTH_METHOD !== "trust") {
          return { code: 1, logs: ["Error: Database is uninitialized and superuser password is not specified.", "       You must specify POSTGRES_PASSWORD to a non-empty value for the", '       superuser. For example, "-e POSTGRES_PASSWORD=password" on "docker run".', "",
            '       You may also use "POSTGRES_HOST_AUTH_METHOD=trust" to allow all', "       connections without a password. This is *not* recommended.", "", '       See PostgreSQL documentation about "trust":', "       https://www.postgresql.org/docs/current/auth-trust.html"] };
        }
        return { readyAt: x.e.now + 6000, logs: ["The files belonging to this database system will be owned by user \"postgres\".", "PostgreSQL init process complete; ready for start up.", "", `${iso(x.e.now).slice(0, 19).replace("T", " ")}.000 UTC [1] LOG:  listening on IPv4 address "0.0.0.0", port 5432`, `${iso(x.e.now).slice(0, 19).replace("T", " ")}.000 UTC [1] LOG:  database system is ready to accept connections`] };
      }
    },
    shop: webApp("shop", 3000),
    payments: webApp("payments", 3000, "@kitchen/payments"),
    orders: dbClient("orders", 8080, "DB_HOST", "db", 5432, "pg"),
    worker: {
      start(x) {
        const missing = x.module("bullmq");
        if (missing) return missing;
        if (!x.env.QUEUE_URL) return { code: 1, logs: ["worker: starting", "worker: fatal: QUEUE_URL is not set (where to read jobs from)"] };
        return { logs: ["worker: starting", `worker: reading jobs from ${x.env.QUEUE_URL}`] };
      }
    },
    pricing: { port: 8080, cpuNeed: 0.8, body: "pricing: 1,204 prices recalculated", start: (x) => x.module("express") || { logs: ["pricing: listening on :8080", "pricing: recalculating prices every request (CPU heavy)"] } },
    resizer: { port: 8080, body: "resizer: ok", start: (x) => x.module("sharp") || { logs: ["resizer: listening on :8080", "resizer: starting one convert process per image"] } },
    proxy: { port: 2375, start: () => ({ logs: ["socket-proxy: forwarding allowed API calls to /var/run/docker.sock on :2375"] }) },
    dashboard: {
      port: 8080,
      body: (e, c) => (c.proc.via ? `dashboard: containers running: ${e.containers.filter((o) => o.state === "running").length}` : "dashboard: cannot reach Docker"),
      start(x) {
        const a = dockerAccess(x.e, x.c, x.env);
        return a.error ? { logs: [`dashboard: ${a.error}`] } : { via: a.via, logs: [`dashboard: reading containers from ${a.via === "proxy" ? x.env.DOCKER_HOST : "unix:///var/run/docker.sock"}`] };
      }
    },
    chatty: { port: 8080, body: "chatty: ok", start: (x) => x.module("express") || { logs: ["chatty: listening on :8080", ...[1, 2, 3].map((n) => `chatty: GET /api/items 200 ${n}ms request_id=${hexOf("r" + n).slice(0, 8)}`)] } },
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
  function execForm(raw) {
    if (!raw.startsWith("[")) return null;
    try { const a = JSON.parse(raw); return Array.isArray(a) ? a.map(String) : null; } catch { return null; }
  }
  const argvOf = (raw) => execForm(raw) || ["/bin/sh", "-c", raw];
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
      this.env = {};
      this.remote = {};
      this.logins = new Set();
      this.hubLimit = Boolean(scenario.hubLimit);
      this.capacity = 40 * GB;
      this.hostServices = {};
      this.builder = "default";
      this.builders = { default: "docker" };
      this.remoteCache = {};
      this.ephemeral = Boolean(scenario.ciRunner);
      this.daemon = { up: true, conf: {} };
      this.groups = ["dev", "sudo", "docker"];
      this.pendingGroups = [];
      this.firewall = ["22/tcp                     ALLOW       Anywhere"];
      this.host = { "/home": D(), [HOME]: D(1000), "/srv": D(), "/tmp": D(0, 0o1777), "/etc": D(), "/etc/docker": D(), "/usr/local/share/ca-certificates": D(), "/var/run/docker.sock": { socket: true, uid: 0, gid: 998, mode: 0o660, size: 0 },
        "/etc/shadow": { text: "root:*:20026:0:99999:7:::\ndaemon:*:20026:0:99999:7:::\ndev:!:20026:0:99999:7:::\n", uid: 0, gid: 42, mode: 0o640 } };
      for (const [p, e] of Object.entries(scenario.files || {})) this.host[p] = { uid: 1000, gid: 1000, mode: e.dir ? 0o755 : 0o644, v: 0, ...e };
      this.addNetwork("bridge", "bridge", "172.17.0.0/16");
      this.addNetwork("host", "host");
      this.addNetwork("none", "null");
      this.now = START;
      this.ready = false;
      for (const step of scenario.setup || []) {
        if (typeof step === "number") this.now += step * 60e3;
        else if (typeof step === "function") step(this);
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
        id: hexOf(`image|${key}`), digest: hexOf(`digest|${key}`), created, layers, os: b.os, arch: "amd64", base: key,
        bins: new Set([...BINS[b.os], ...b.bins]), users: { root: [0, 0], ...(b.users || {}) },
        fs: { ...BASE_FS, ...(b.fs || {}) },
        config: { Env: ["PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", ...(b.env || [])], Cmd: b.cmd, Entrypoint: b.entrypoint || null, WorkingDir: "", User: "", ExposedPorts: b.expose || [], StopSignal: b.stop || null, Volumes: b.vol || [], Healthcheck: null }
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
      const host = hostOf(r);
      const repo = r.slice(0, r.lastIndexOf(":"));
      const tag = r.slice(r.lastIndexOf(":") + 1);
      const path = host === "docker.io" ? (repo.includes("/") ? repo : "library/" + repo) : repo.slice(host.length + 1);
      const remote = this.remote[r];
      const img = remote ? remote.image : this.registry(r);
      if (host === "docker.io" && this.hubLimit && !this.logins.has("docker.io") && !(img && this.tags[r] === img.id)) {
        return { error: "toomanyrequests: You have reached your unauthenticated pull rate limit. https://www.docker.com/increase-rate-limit" };
      }
      if (remote && remote.privateCA && !this.trusts(host)) return { error: `Get "https://${host}/v2/": tls: failed to verify certificate: x509: certificate signed by unknown authority` };
      if (remote && remote.private && !this.logins.has(host)) return { error: `Head "https://${host === "docker.io" ? "registry-1.docker.io" : host}/v2/${path}/manifests/${tag}": unauthorized` };
      if (!img) {
        const known = Object.keys(BASES).some((k) => k.startsWith(repo + ":")) || Object.keys(this.remote).some((k) => k.startsWith(repo + ":"));
        return { error: known || host !== "docker.io" ? `manifest for ${r} not found: manifest unknown: manifest unknown`
          : `pull access denied for ${repo}, repository does not exist or may require 'docker login': denied: requested access to the resource is denied` };
      }
      const had = this.tags[r] === img.id;
      const lines = [`${tag}: Pulling from ${path}`];
      if (!had) for (const l of img.layers.filter((x) => x.id)) lines.push(`${l.id.slice(0, 12)}: Pull complete`);
      lines.push(`Digest: sha256:${img.digest || hexOf("digest" + img.id)}`, `Status: ${had ? "Image is up to date" : "Downloaded newer image"} for ${r}`, fullRef(r));
      this.tag(r, img);
      return { lines };
    }

    // Setup helper: move a local image to a registry, as if it had been pushed there.
    publish(ref, priv, privateCA) {
      const img = this.image(ref);
      this.remote[normRef(ref)] = { image: img, private: Boolean(priv), privateCA: Boolean(privateCA) };
      delete this.tags[normRef(ref)];
      if (!this.tagsOf(img).length) delete this.images[img.id];
    }
    // Bytes on the disk that holds /var/lib/docker: the OS, images, build cache, volumes and logs.
    diskUsed() {
      const d = diskUse(this);
      return 7.5 * GB + d.imageSize + d.cacheSize + d.volumeSize + this.containers.reduce((n, c) => n + (c.logBytes || 0), 0);
    }
    // The host's process table, for --pids-limit: pid_max minus what everything uses.
    pidsFree() { return 32768 - 420 - this.containers.filter((c) => c.state === "running").reduce((n, c) => n + (c.pids || 11), 0); }
    // A registry with a certificate from a private CA is trusted through certs.d or the system store.
    trusts(host) { return Boolean(this.host[`/etc/docker/certs.d/${host}/ca.crt`]) || this.systemCA || (this.daemon.conf["insecure-registries"] || []).includes(host); }
    capsOf(c) {
      if (c.privileged) return new Set([...DEFAULT_CAPS, "SYS_ADMIN", "NET_ADMIN", "SYS_PTRACE"]);
      const drop = c.capDrop.map(capName);
      const caps = new Set(drop.includes("ALL") ? [] : DEFAULT_CAPS.filter((x) => !drop.includes(x)));
      for (const a of c.capAdd.map(capName)) (a === "ALL" ? [...DEFAULT_CAPS, "SYS_ADMIN", "NET_ADMIN", "SYS_PTRACE"] : [a]).forEach((x) => caps.add(x));
      return caps;
    }
    // Run a container's healthcheck now: null when it has none.
    health(c) {
      const test = c.health || this.images[c.imageId].config.Healthcheck;
      if (!test || test[0] === "NONE" || c.state !== "running") return null;
      const shellForm = test[0] === "CMD-SHELL";
      const cmd = shellForm ? test[1] : test.slice(1).join(" ");
      const first = words(cmd.split(/\|\||&&/)[0]);
      const who = this.userOf(c);
      // exit is a shell builtin, not a program in the image.
      const r = !first.length ? { code: 0, lines: [] } : first[0] === "exit" ? { code: Number(first[1]) || 0, lines: [] } : ctool(this, c, first, who);
      const out = r.oci ? (shellForm ? `/bin/sh: ${first[0]}: not found` : r.oci) : r.na ? "" : r.lines.map((l) => l[0]).join("\n");
      const code = r.oci ? (shellForm && /\|\|\s*exit 1/.test(cmd) ? 1 : 127) : r.na ? 0 : r.code ? (/\|\|\s*exit 1/.test(cmd) ? 1 : r.code) : 0;
      return { status: code === 0 ? "healthy" : "unhealthy", code, out };
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
      if (name === "172.17.0.1") return { ip: name, via: "ip", target: { proc: { listens: Object.keys(this.hostServices).map(Number), app: "redis" } } };
      if (/^\d+\.\d+\.\d+\.\d+$/.test(name)) {
        const target = this.containers.find((o) => this.running(o) && Object.values(o.nets).some((n) => n.ip === name));
        return { ip: name, via: "ip", target };
      }
      const onHost = { proc: { listens: Object.keys(this.hostServices).map(Number), app: "redis" } };
      if (c.netMode === "host" && /^(localhost|127\.0\.0\.1)$/.test(name)) return { ip: "127.0.0.1", via: "host", target: onHost };
      if (c.extraHosts && c.extraHosts[name]) return { ip: c.extraHosts[name], via: "hosts", target: c.extraHosts[name] === "172.17.0.1" ? onHost : null };
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
        if ((!target.proc.listens.includes(cport) || target.proc.loopback) && target.netMode !== "host") return { code: 56, text: "curl: (56) Recv failure: Connection reset by peer" };
      } else {
        const r = c ? this.resolve(c, host) : { target: this.containers.find((o) => this.running(o) && Object.values(o.nets).some((n) => n.ip === host)) };
        if (!r) return { code: 6, text: `curl: (6) Could not resolve host: ${host}` };
        target = r.target;
        if (!target || !target.proc.listens.includes(port) || (target.proc.loopback && target !== c)) return refused(host);
      }
      const def0 = APPS[target.proc.app] || {};
      if (target.proc.hung || (def0.cpuNeed && target.cpus && target.cpus < def0.cpuNeed)) return { code: 28, text: "curl: (28) Operation timed out after 5001 milliseconds with 0 bytes received" };
      if (target.proc.app === "redis") return { code: 1, text: "curl: (1) Received HTTP/0.9 when not allowed" };
      const body = APPS[target.proc.app].body;
      if (!body) return { code: 52, text: "curl: (52) Empty reply from server" };
      return { code: 0, text: typeof body === "function" ? body(this, target) : body, app: target.proc.app };
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
      const r = img.arch !== "amd64" ? { code: 255, logs: [`exec ${argv[0] === "docker-entrypoint.sh" ? "/usr/local/bin/docker-entrypoint.sh" : argv[0]}: exec format error`] } : this.process(c, argv, who);
      if (r.oci) { c.exitCode = 127; c.state = c.startedAt ? "exited" : "created"; return r.oci; }
      for (const [net, n] of Object.entries(c.nets)) {
        const nw = this.networks[net];
        if (nw && nw.subnet && !n.ip) n.ip = nw.subnet.replace(/0\.0\/16$/, `0.${nw.next++}`);
      }
      c.startedAt = this.now;
      c.logs.push(...r.logs);
      if (r.running) {
        c.state = "running";
        c.proc = { app: r.app, listens: r.listens || [], hung: r.hung, via: r.via, loopback: r.loopback, readyAt: r.readyAt, debug: r.debug, handlesTerm: r.handlesTerm };
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
          if (img.bins.has("nginx")) {
            if (/^nginx/.test(rest[0] || "")) logs.push(...NGINX_ENTRY.slice(0, 3), ...(c.readOnly ? ["10-listen-on-ipv6-by-default.sh: info: can not modify /etc/nginx/conf.d/default.conf (read-only file system?)"] : []), NGINX_ENTRY[3]);
            a = rest;
            continue;
          }
          const program = img.bins.has("redis-server") ? "redis-server" : img.bins.has("postgres") ? "postgres" : "node";
          a = rest.length && !rest[0].startsWith("-") && (img.bins.has(rest[0].split("/").pop()) || program !== "node") ? rest : [program, ...rest];
          continue;
        }
        // A script in the image: it must be executable, and its exec line names the program.
        if (bin.startsWith("/") || bin.startsWith("./")) {
          const view = this.view(c);
          const f = view[join(c.workdir || img.config.WorkingDir || "/", bin)];
          if (f && !f.dir && !img.bins.has(base)) {
            if (!((f.mode == null ? 0o644 : f.mode) & 0o111)) return { oci: OCI(bin).replace("executable file not found in $PATH", "permission denied") };
            const line = (f.text || "").split("\n").reverse().find((l) => /^\s*exec\s/.test(l));
            a = line ? [...words(line.replace(/^\s*exec\s+/, "").replace(/"\$@"/, "")), ...rest] : [];
            if (!a.length) return { code: 0, logs };
            continue;
          }
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
        if (base === "postgres") return this.app("postgres", c, logs, who);
        if (base === "sleep") return { running: true, logs, app: null };
        if (base === "node") {
          if (rest[0] && rest[0].startsWith("-") && !/^--(inspect|max-old-space-size|enable-source-maps|env-file)/.test(rest[0])) return { code: 9, logs: [...logs, `node: bad option: ${rest[0]}`] };
          if (rest[0] && rest[0].startsWith("-")) { a = ["node", ...rest.slice(1)]; continue; }
          if (!rest.length) return c.interactive ? { running: true, logs, app: null } : { code: 0, logs };
          const view = this.view(c);
          const script = join(c.workdir || img.config.WorkingDir || "/", rest[0]);
          const file = view[script] || view[script + ".js"];
          if (!file) return { code: 1, logs: nodeTrace([...logs, "node:internal/modules/cjs/loader:1228", "  throw err;", "  ^", "", `Error: Cannot find module '${script}'`, "    at Module._resolveFilename (node:internal/modules/cjs/loader:1225:15)", "    at Module._load (node:internal/modules/cjs/loader:1051:27) {", "  code: 'MODULE_NOT_FOUND',", "  requireStack: []", "}"]) };
          if (!file.app) return { code: 0, logs };
          return this.app(file.app, c, logs, who, view, script, rest.slice(1));
        }
        const r = ctool(this, c, a, who);
        if (r.na) return { code: 0, logs };
        return { code: r.code, logs: [...logs, ...r.lines.map((l) => l[0])] };
      }
      return { code: 0, logs };
    }
    app(name, c, logs, who, view, script, args) {
      const def = APPS[name];
      view = view || this.view(c);
      const env = Object.fromEntries([...this.images[c.imageId].config.Env, ...c.env].map((kv) => [kv.split("=")[0], kv.slice(kv.indexOf("=") + 1)]));
      const x = {
        e: this, c, view, uid: who.uid, gid: who.gid, env, caps: this.capsOf(c), args: args || [], script,
        // A require() that fails like Node does when node_modules is missing.
        module: (mod) => (view[(script || "").replace(/\/[^/]*$/, "") + "/node_modules"] ? null : {
          code: 1, logs: nodeTrace(["node:internal/modules/cjs/loader:1228", "  throw err;", "  ^", "", `Error: Cannot find module '${mod}'`, "Require stack:", `- ${script}`,
            "    at Module._resolveFilename (node:internal/modules/cjs/loader:1225:15)", "    at Module._load (node:internal/modules/cjs/loader:1051:27) {", "  code: 'MODULE_NOT_FOUND',", `  requireStack: [ '${script}' ]`, "}"])
        })
      };
      const r = def.start(x);
      if (r.code !== undefined) return { code: r.code, oom: r.oom, logs: [...logs, ...r.logs] };
      return { running: true, app: name, listens: def.port ? [def.port] : [], hung: r.hung, via: r.via, loopback: r.loopback, readyAt: r.readyAt, debug: r.debug, handlesTerm: r.handlesTerm, logs: [...logs, ...r.logs] };
    }
    // docker stop sends SIGTERM, then SIGKILL after the timeout. PID 1 ignores
    // signals it has no handler for, so an app without one is killed (137).
    // Returns the seconds Docker waited.
    stop(c, signal, timeout) {
      if (c.state === "restarting") { c.stopped = true; c.state = "exited"; return 0; }
      if (!this.running(c)) return 0;
      const def = APPS[c.proc.app];
      const term = signal !== "KILL";
      const code = !term ? 137 : c.init ? 143 : def && def.stopCode !== undefined ? def.stopCode : c.proc.handlesTerm ? 0 : 137;
      if (term && code === 0 && c.proc.handlesTerm) c.logs.push(`${c.proc.app}: SIGTERM received, closing the server`);
      const waited = term && code === 137 ? (timeout === undefined || Number.isNaN(timeout) ? 10 : timeout) : 0;
      c.stopped = true;
      this.exited(c, code, false);
      c.lastStop = { signal: term ? "TERM" : "KILL", code, waited };
      return waited;
    }
    // Would this image run? Used to check that a smaller image still works.
    trial(img) {
      const c = newContainer(this, { name: "trial", imageId: img.id, image: img.id, cmd: img.config.Cmd, entrypoint: img.config.Entrypoint, env: [], mounts: [], ports: [] });
      const who = this.userOf(c);
      if (who.error) return { ok: false, why: who.error };
      if (img.arch !== "amd64") return { ok: false, why: "exec format error" };
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

  // How a process in a container reaches the Docker API: a socket proxy over
  // DOCKER_HOST, the mounted socket itself, or nothing.
  function dockerAccess(e, c, env) {
    const m = /^tcp:\/\/([^:/]+):(\d+)/.exec(env.DOCKER_HOST || "");
    if (m) {
      const r = e.resolve(c, m[1]);
      const t = r && r.target;
      if (!t || t.proc.app !== "proxy" || !t.mounts.some((x) => x.source === "/var/run/docker.sock")) return { error: `Cannot connect to the Docker daemon at ${env.DOCKER_HOST}. Is the docker daemon running?` };
      return { via: "proxy", proxyEnv: Object.fromEntries([...e.images[t.imageId].config.Env, ...t.env].map((kv) => [kv.split("=")[0], kv.slice(kv.indexOf("=") + 1)])) };
    }
    if (c.mounts.some((x) => x.type === "bind" && x.source === "/var/run/docker.sock" && x.dest === "/var/run/docker.sock")) return { via: "socket" };
    return { error: "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?" };
  }

  // The daemon stops its containers; on start it reads daemon.json and restarts those with a policy.
  function daemonStop(e) {
    for (const c of e.containers) if (c.state === "running" || c.state === "restarting") { e.stop(c); c.stopped = false; }
    e.daemon.up = false;
    e.daemon.since = e.now;
  }
  function daemonStart(e) {
    const f = e.host["/etc/docker/daemon.json"];
    e.daemon.since = e.now;
    e.daemon.error = null;
    if (f && f.text !== undefined && f.text.trim()) {
      try { e.daemon.conf = JSON.parse(f.text); } catch (err) {
        const trailing = /,\s*([}\]])/.exec(f.text);
        const ch = trailing ? trailing[1] : (/position (\d+)/.exec(err.message) ? f.text[Number(/position (\d+)/.exec(err.message)[1])] : "");
        e.daemon.error = `unable to configure the Docker daemon with file /etc/docker/daemon.json: ${trailing ? `invalid character '${ch}' looking for beginning of object key string` : ch ? `invalid character '${ch}' after object key:value pair` : "unexpected end of JSON input"}`;
        e.daemon.up = false;
        return e.daemon.error;
      }
    } else e.daemon.conf = {};
    e.daemon.up = true;
    e.systemCA = Boolean(e.caPending);
    for (const c of e.containers) if (c.state === "exited" && !c.stopped && (c.restart === "always" || c.restart === "unless-stopped")) e.start(c);
    return null;
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
      capDrop: o.capDrop || [], capAdd: o.capAdd || [], extraHosts: o.extraHosts || {}, init: Boolean(o.init),
      cpus: o.cpus || 0, cpuShares: o.cpuShares || 0, cpusetCpus: o.cpusetCpus || "", pidsLimit: o.pidsLimit || 0, pids: 0, health: o.health || null, log: o.log || { type: "json-file", opts: {} }, logBytes: 0, platform: o.platform || "",
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
      case "cat": {
        if (a.includes("/sys/fs/cgroup/cpu.stat")) {
          const def = APPS[c.proc.app] || {};
          const thr = def.cpuNeed && c.cpus && c.cpus < def.cpuNeed;
          return say(["usage_usec 812345678", "user_usec 790112345", "system_usec 22233333", `nr_periods 36000`, `nr_throttled ${thr ? 35874 : 0}`, `throttled_usec ${thr ? 3226611000 : 0}`].join("\n"));
        }
        if (a.includes("/sys/fs/cgroup/pids.max")) return say(c.pidsLimit ? String(c.pidsLimit) : "max");
        return catLines(view, wd, a, "cat");
      }
      case "docker": {
        const env = Object.fromEntries([...img.config.Env, ...c.env].map((kv) => [kv.split("=")[0], kv.slice(kv.indexOf("=") + 1)]));
        const acc = dockerAccess(e, c, env);
        if (acc.error) return say(acc.error, "warn");
        // The proxy lets reads through when CONTAINERS=1, and writes only when POST=1.
        if (acc.via === "proxy") {
          const read = /^(ps|images|inspect|version|info|logs)$/.test(a[0] || "");
          const allowed = a[0] === "version" || (read && acc.proxyEnv.CONTAINERS === "1") || (!read && acc.proxyEnv.POST === "1");
          if (!allowed) return say("Error response from daemon: <html><body><h1>403 Forbidden</h1>\nRequest forbidden by administrative rules.\n</body></html>", "warn");
        }
        return docker(e, a);
      }
      case "echo": return say(a.join(" "));
      case "true": case "sleep": return say("");
      case "pg_isready": return c.proc.app === "postgres" && c.proc.readyAt <= e.now ? say("/var/run/postgresql:5432 - accepting connections") : { code: 2, lines: [["/var/run/postgresql:5432 - no response", "warn"]] };
      case "redis-cli": {
        if (a.includes("ping") || a.includes("PING")) return say("PONG");
        const dump = view["/data/dump.rdb"];
        return a.some((x) => /^dbsize$/i.test(x)) ? say(`(integer) ${dump ? dump.keys : 0}`) : say("(the playground's redis-cli answers ping and dbsize)", "na");
      }
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

  const RUN_SPEC = flagSpec("d|detach i|interactive t|tty rm P|publish-all read-only privileged init oom-kill-disable no-healthcheck help",
    "name p|publish v|volume e|env net|network m|memory memory-swap u|user restart entrypoint w|workdir link mount cpus pids-limit tmpfs cap-drop cap-add security-opt network-alias h|hostname l|label platform log-driver log-opt health-cmd health-interval env-file pull add-host cpu-shares cpuset-cpus",
    "publish volume env link mount tmpfs cap-drop cap-add security-opt network-alias label log-opt add-host");
  const LOG_DRIVERS = ["json-file", "local", "none", "syslog", "journald", "gelf", "fluentd", "awslogs", "splunk", "etwlogs", "gcplogs"];
  const fail = (lines, cls) => ({ code: 1, lines: (Array.isArray(lines) ? lines : [lines]).map((l) => [l, cls || "warn"]) });
  const ok = (lines, cls) => ({ code: 0, lines: (Array.isArray(lines) ? lines : [lines]).filter((l) => l !== null).map((l) => (Array.isArray(l) ? l : [l, cls || ""])) });
  const na = (text) => ({ code: 0, lines: [[text, "na"]] });
  const usage = (cmd, err) => fail([err, `See 'docker ${cmd} --help'.`]);
  const LAB = (what) => na(`${what} needs a real Docker host. Run it on your machine (Lab).`);

  function statusOf(e, c) {
    if (c.state === "running") { const hc = e.health(c); return `Up ${duration(e.now - c.startedAt)}${hc ? ` (${hc.status})` : ""}`; }
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
        ...(() => { const hc = e.health(c); return hc ? { Health: { Status: hc.status, FailingStreak: hc.code ? 3 : 0, Log: [{ ExitCode: hc.code, Output: hc.out }] } } : {}; })(),
        Pid: c.state === "running" ? 4000 + (hash(c.id) % 900) : 0, ExitCode: c.exitCode, Error: "", StartedAt: c.startedAt ? iso(c.startedAt) : "0001-01-01T00:00:00Z", FinishedAt: c.finishedAt ? iso(c.finishedAt) : "0001-01-01T00:00:00Z" },
      Image: `sha256:${img.id}`, Name: `/${c.name}`, RestartCount: 0, Platform: "linux",
      LogPath: c.log.type === "json-file" ? `/var/lib/docker/containers/${c.id}/${c.id}-json.log` : "",
      HostConfig: {
        Binds: c.mounts.filter((m) => m.spec).map((m) => m.spec), NetworkMode: c.netMode,
        PortBindings: Object.fromEntries(c.ports.map((p) => [`${p.cont}/tcp`, [{ HostIp: p.hostIp || "", HostPort: String(p.host) }]])),
        RestartPolicy: { Name: c.restart, MaximumRetryCount: 0 }, AutoRemove: c.rm, Privileged: c.privileged, ReadonlyRootfs: c.readOnly,
        Memory: c.memory, MemorySwap: c.memorySwap, OomKillDisable: c.oomKillDisable, Init: c.init || null,
        NanoCpus: Math.round((c.cpus || 0) * 1e9), CpuShares: c.cpuShares || 0, CpusetCpus: c.cpusetCpus || "", PidsLimit: c.pidsLimit || null,
        ExtraHosts: Object.keys(c.extraHosts || {}).length ? Object.entries(c.extraHosts).map(([n, ip]) => `${n}:${ip}`) : null, CapAdd: c.capAdd.length ? c.capAdd : null, CapDrop: c.capDrop.length ? c.capDrop : null, LogConfig: { Type: c.log.type, Config: c.log.opts }
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
      Id: `sha256:${img.id}`, RepoTags: e.tagsOf(img), RepoDigests: [], Created: iso(img.created), Os: "linux", Architecture: img.arch || "amd64", Size: e.imageSize(img),
      Config: { User: img.config.User, Healthcheck: img.config.Healthcheck ? { Test: img.config.Healthcheck } : null, Volumes: (img.config.Volumes || []).length ? Object.fromEntries(img.config.Volumes.map((v) => [v, {}])) : null, ExposedPorts: Object.fromEntries((img.config.ExposedPorts || []).map((p) => [`${p}/tcp`, {}])), Env: img.config.Env, Cmd: img.config.Cmd, WorkingDir: img.config.WorkingDir, Entrypoint: img.config.Entrypoint, Labels: null },
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
    if (f.pull === "always") {
      const r = e.pullLines(ref);
      if (r.error) return fail(`docker: Error response from daemon: ${r.error}`);
      lines.push(...r.lines.slice(0, -1).map((l) => [l, "dim"]));
    }
    let img = e.image(ref);
    if (!img) {
      lines.push([`Unable to find image '${normRef(ref)}' locally`, ""]);
      const r = e.pullLines(ref);
      if (r.error) return fail([...lines.map((l) => l[0]), `docker: Error response from daemon: ${r.error}`, "", `Run 'docker ${verb} --help' for more information`]);
      lines.push(...r.lines.slice(0, -1).map((l) => [l, "dim"]));
      img = e.image(ref);
    }
    if (f.platform && f.platform.replace(/\/v\d$/, "") !== `linux/${img.arch}`) return fail(`docker: Error response from daemon: image with reference ${ref} was found but its platform (linux/${img.arch}) does not match the specified platform (${f.platform}).`);
    if (!f.platform && img.arch !== "amd64") lines.push([`WARNING: The requested image's platform (linux/${img.arch}/v8) does not match the detected host platform (linux/amd64/v3) and no specific platform was requested`, "warn"]);
    const ports = parsePorts(e, f.publish, f["publish-all"], img);
    if (ports.error) return fail(ports.error);
    const m = parseMounts(e, f);
    if (m.error) return fail(m.error);
    // An image's VOLUME paths get an anonymous volume unless something is mounted there.
    for (const v of img.config.Volumes || []) if (!m.mounts.some((x) => x.dest === v)) m.mounts.push({ type: "volume", name: e.id("anon" + v + m.mounts.length), dest: v, anon: true });
    const driver = f["log-driver"] || e.daemon.conf["log-driver"] || "json-file";
    if (!LOG_DRIVERS.includes(driver)) return fail(`docker: Error response from daemon: failed to create task for container: failed to initialize logging driver: logger: no log driver named '${driver}' is registered.`);
    const envFile = f["env-file"] ? e.host[join(e.cwd, f["env-file"])] : null;
    if (f["env-file"] && (!envFile || envFile.text === undefined)) return fail(`docker: open ${f["env-file"]}: no such file or directory.`);
    const entry = f.entrypoint !== undefined ? (f.entrypoint ? [f.entrypoint] : []) : img.config.Entrypoint;
    const c = newContainer(e, {
      name, image: ref, imageId: img.id, cmd: cmd.length ? cmd : f.entrypoint !== undefined ? [] : img.config.Cmd, entrypoint: entry, workdir: f.workdir, user: f.user,
      env: (f.env || []).filter((x) => x.includes("=")), tty: f.tty, interactive: f.interactive, rm: f.rm, ports: ports.ports, mounts: m.mounts, netMode,
      aliases: f["network-alias"], links, memory, memorySwap, restart: f.restart, oomKillDisable: f["oom-kill-disable"], privileged: f.privileged, readOnly: f["read-only"],
      capDrop: f["cap-drop"], capAdd: f["cap-add"], platform: f.platform, init: f.init,
      cpus: Number(f.cpus) || 0, cpuShares: Number(f["cpu-shares"]) || 0, cpusetCpus: f["cpuset-cpus"] || "", pidsLimit: Number(f["pids-limit"]) || 0,
      extraHosts: Object.fromEntries((f["add-host"] || []).map((h) => { const [n, ip] = h.split(/:(.*)/); return [n, ip === "host-gateway" ? "172.17.0.1" : ip]; })),
      health: f["no-healthcheck"] ? ["NONE"] : f["health-cmd"] ? ["CMD-SHELL", f["health-cmd"]] : null,
      log: { type: driver, opts: f["log-opt"] ? Object.fromEntries(f["log-opt"].map((kv) => [kv.split("=")[0], kv.slice(kv.indexOf("=") + 1)])) : !f["log-driver"] ? { ...(e.daemon.conf["log-opts"] || {}) } : {} }
    });
    if (envFile) c.env.unshift(...envFile.text.split("\n").map((l) => l.trim()).filter((l) => l.includes("=") && !l.startsWith("#")));
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
    if (!["json-file", "local", "journald"].includes(c.log.type)) return fail("Error response from daemon: configured logging driver does not support reading");
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
    const p = parseFlags(args, flagSpec("", "m|memory memory-swap restart cpus pids-limit cpu-shares cpuset-cpus", ""), false);
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
      if (f.cpus !== undefined) { if (!(Number(f.cpus) >= 0)) return fail(`invalid argument "${f.cpus}" for "--cpus" flag: failed to parse ${f.cpus} as a rational number`); c.cpus = Number(f.cpus); }
      if (f["cpu-shares"] !== undefined) c.cpuShares = Number(f["cpu-shares"]) || 0;
      if (f["cpuset-cpus"] !== undefined) c.cpusetCpus = f["cpuset-cpus"];
      if (f["pids-limit"] !== undefined) c.pidsLimit = Number(f["pids-limit"]) > 0 ? Number(f["pids-limit"]) : 0;
      if (c.state === "restarting" && c.restart === "no") c.state = "exited";
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
      volumeSize: vols.reduce((n, v) => n + volSize(v), 0), volumeFree: vols.filter((v) => !e.containers.some((c) => c.mounts.some((m) => m.name === v.name))).reduce((n, v) => n + volSize(v), 0), cacheCount: cache.length, cacheSize: cache.reduce((n, x) => n + (x.layer.size || 0), 0)
    };
  }
  function prune(e, what, flags) {
    const warn = {
      container: "WARNING! This will remove all stopped containers.",
      image: flags.all ? "WARNING! This will remove all images without at least one container associated to them." : "WARNING! This will remove all dangling images.",
      volume: "WARNING! This will remove anonymous local volumes not used by at least one container.",
      network: "WARNING! This will remove all custom networks not used by at least one container.",
      builder: "WARNING! This will remove all dangling build cache.",
      system: `WARNING! This will remove:\n  - all stopped containers\n  - all networks not used by at least one container${flags.volumes ? "\n  - all anonymous volumes not used by at least one container" : ""}\n  - ${flags.all ? "all images without at least one container associated to them" : "all dangling images"}\n  - ${flags.all ? "all build cache" : "unused build cache"}`
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
    if (what === "volume" || (what === "system" && flags.volumes)) {
      for (const v of Object.values(e.volumes)) {
        if ((!v.anon && (!flags.all || what === "system")) || e.containers.some((c) => c.mounts.some((m) => m.name === v.name))) continue;
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

  // mounted: files present only while this step runs (RUN --mount=type=secret).
  function runStep(st, cmdline, uid, mounted) {
    const before = st.fs;
    const fs = { ...before, ...mounted };
    const out = [];
    let secs = 0.4;
    let wd = st.cfg.WorkingDir || "/";
    const vars = { ...Object.fromEntries(st.cfg.Env.map((kv) => [kv.split("=")[0], kv.slice(kv.indexOf("=") + 1)])), ...st.args };
    for (const part of cmdline.split(/\s*(?:&&|;)\s*/).filter(Boolean)) {
      const toks = lex(part, vars) || [];
      const redirect = toks.findIndex((t) => t.op === ">" || t.op === ">>");
      const w = (redirect >= 0 ? toks.slice(0, redirect) : toks).filter((t) => "w" in t).map((t) => t.w);
      const [cmd, ...a] = w;
      if (!cmd) continue;
      if (redirect >= 0 && toks[redirect + 1] && (cmd === "echo" || cmd === "printf")) {
        const target = join(wd, toks[redirect + 1].w);
        const text = (cmd === "printf" ? a.join(" ").replace(/\\n/g, "\n") : a.join(" ") + "\n");
        fs[target] = { text: toks[redirect].op === ">>" && fs[target] ? (fs[target].text || "") + text : text, uid, gid: uid, mode: 0o644 };
        continue;
      }
      const opts = a.filter((x) => x.startsWith("-"));
      const pos = a.filter((x, i) => !x.startsWith("-") && !(/^-[ugGgh]$/.test(a[i - 1] || "") || /^--(uid|gid|ingroup|home|shell)$/.test(a[i - 1] || "")));
      const valueOf = (...keys) => { for (const k of keys) { const i = a.indexOf(k); if (i >= 0) return a[i + 1]; const eq = a.find((x) => x.startsWith(k + "=")); if (eq) return eq.split("=")[1]; } return undefined; };
      if (cmd === "cd") { wd = join(wd, a[0] || "/"); continue; }
      if (cmd === "npm" || cmd === "yarn") {
        const sub = cmd === "yarn" ? (a[0] || "install") : a[0];
        if (!st.bins.has(cmd)) return { code: 127, out: [`/bin/sh: ${cmd}: not found`] };
        if (/^(ci|install|i)$/.test(sub)) {
          const pkg = fs[join(wd, "package.json")];
          const npmrc = [join(wd, ".npmrc"), "/root/.npmrc"].map((x) => fs[x]).find((x) => x && /_authToken=\S+/.test(x.text || ""));
          if (pkg && pkg.private && !npmrc) return { code: 1, out: ["npm error code E401", "npm error 401 Unauthorized - GET https://npm.pkg.github.com/@kitchen%2fpayments - authentication token not provided"] };
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
            } else fs[p] = { ...fs[p], mode: /^[0-7]+$/.test(spec) ? parseInt(spec, 8) : /^[ugoa]*\+x$/.test(spec) ? (fs[p].mode == null ? 0o644 : fs[p].mode) | 0o111 : fs[p].mode };
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
        pkgs.forEach((x) => st.bins.add({ "docker-cli": "docker" }[x] || x));
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
    for (const p of Object.keys(mounted || {})) if (fs[p] === mounted[p]) delete fs[p];
    const changed = Object.keys(fs).filter((p) => fs[p] !== before[p]);
    const size = changed.reduce((n, p) => n + (fs[p].whiteout ? 1200 : entrySize(fs[p])), 0);
    return { code: 0, fs, size, out, secs, files: changed };
  }

  function dBuild(e, args) {
    const p = parseFlags(args, flagSpec("no-cache q|quiet pull squash load push rm", "t|tag f|file build-arg target progress platform network secret cache-from cache-to builder", "tag build-arg secret"), false);
    if (p.error) return usage("buildx build", p.error);
    if (p.pos.length !== 1) return fail(['ERROR: "docker buildx build" requires exactly 1 argument.', "See 'docker buildx build --help'.", "", "Usage:  docker buildx build [OPTIONS] PATH | URL | -", "", "Start a build"]);
    if (p.flags.push || String(p.flags.platform || "").includes(",")) return LAB("Pushing or building for several platforms");
    const builder = p.flags.builder || e.builder;
    const driver = e.builders[builder];
    if (!driver) return fail(`ERROR: no builder "${builder}" found`);
    if (p.flags["cache-to"] && driver === "docker") return fail(["ERROR: Cache export is not supported for the docker driver.", "Switch to a different driver, or turn on the containerd image store, and try again.", "Learn more at https://docs.docker.com/go/build-cache-backends/"]);
    const cacheRef = (v) => (v ? (/ref=([^,]+)/.exec(v) || [null, /=/.test(v) ? null : v])[1] : null);
    // A CI runner starts every job with an empty build cache.
    if (e.ephemeral) e.cache.clear();
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
    const from = cacheRef(p.flags["cache-from"]);
    if (from && e.remoteCache[from]) { for (const [k, v] of e.remoteCache[from]) e.cache.set(k, v); row(`importing cache manifest from ${from}`, 0.4); }
    else if (from) row(`ERROR importing cache manifest from ${from}`, 0.3);
    row("[internal] load build context", ctxSize / (80 * MB) + 0.1);
    row(`=> transferring context: ${bytes2(ctxSize)}`, ctxSize / (80 * MB));

    const results = {};
    const steps = [];
    const arch = p.flags.platform ? p.flags.platform.split("/")[1] : "amd64";
    const diskBefore = e.diskUsed();
    const added = [];
    let fresh = 0;
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
        st = { fs: r.fs, cfg: { ...r.cfg }, users: { ...r.users }, groups: { ...r.groups }, bins: new Set(r.bins), layers: [...r.layers], key: r.key, os: r.os, args: {}, base: r.base };
      } else {
        const base = e.image(s.from) || e.registry(s.from);
        if (!base) return failWith(`[${label}1/${n}] FROM ${fullRef(normRef(s.from))}`, null, `${s.from}: failed to resolve source metadata for ${fullRef(normRef(s.from))}: pull access denied, repository does not exist or may require authorization: server message: insufficient_scope: authorization failed`);
        st = { fs: { ...base.fs }, cfg: JSON.parse(JSON.stringify(base.config)), users: { ...base.users }, groups: {}, bins: new Set(base.bins), layers: [...base.layers], key: `base:${base.id}:${arch}`, os: base.os, args: {}, base: base.base };
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
            if (fromStage && !results[fromStage.index]) return failWith(`[${label}${k + 1}/${n}] ${ins.text}`, null, `circular dependency detected on stage: ${fromStage.name || fromStage.index}`);
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
          if (flags.chmod && /^[0-7]{3,4}$/.test(flags.chmod)) for (const t of Object.keys(copied)) copied[t] = { ...copied[t], mode: parseInt(flags.chmod, 8) };
          extra = Object.entries(copied).map(([t, x]) => `${t}:${entrySize(x)}:${x.v || 0}:${x.uid || 0}:${x.mode || 0}`).join(",");
        }
        if (ins.name === "RUN") extra = JSON.stringify(st.args);
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
          // A secret mount puts the file in place for this step only, so no layer keeps it.
          const mounted = {};
          const mount = typeof flags.mount === "string" ? Object.fromEntries(flags.mount.split(",").map((kv) => kv.split("="))) : {};
          if (mount.type === "secret") {
            const given = (p.flags.secret || []).map((x) => Object.fromEntries(x.split(",").map((kv) => kv.split("=")))).find((x) => x.id === mount.id);
            const src = given && (given.src || given.source) ? e.host[join(e.cwd, given.src || given.source)] : null;
            if (src) mounted[norm(mount.target || mount.dst || `/run/secrets/${mount.id}`)] = { ...src, uid: 0 };
          }
          const r = runStep(st, rest.startsWith("[") ? argvOf(rest).slice(-1)[0] : rest, who, mounted);
          if (r.code) return failWith(shown, r.out, `process "/bin/sh -c ${rest}" did not complete successfully: exit code: ${r.code}`);
          st.fs = r.fs;
          const argList = Object.entries(st.args);
          layer = { id: hexOf(`layer|${st.key}`), size: r.size, files: r.files, by: `RUN ${argList.length ? `|${argList.length} ${argList.map(([k, v]) => `${k}=${v}`).join(" ")} ` : ""}/bin/sh -c ${rest} # buildkit` };
          fresh += r.size;
          row(shown, r.secs);
          total += r.secs;
          r.out.forEach((l, j) => log.push([`${(r.secs * (0.3 + j / 20)).toFixed(3)} ${l}`, "dim"]));
        } else if (copied) {
          const fs = { ...st.fs };
          for (const [t, x] of Object.entries(copied)) fs[t] = x;
          st.fs = fs;
          const size = Object.values(copied).reduce((a, x) => a + entrySize(x), 0);
          layer = { id: hexOf(`layer|${st.key}`), size, files: Object.keys(copied), by: `${ins.name} ${rest} # buildkit` };
          fresh += size;
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
        if (!hit) { e.cache.set(st.key, { fs: st.fs, users: { ...st.users }, groups: { ...st.groups }, bins: [...st.bins], layer }); added.push(st.key); }
        if (!hit && shown) { steps.push({ text: `${ins.name} ${ins.raw}`, cached: false, stage: s.name }); doneCount++; }
        st.layers.push({ ...layer, created: e.now, comment: "buildkit.dockerfile.v0" });
        // Metadata: applied whether or not the step was cached.
        if (ins.name === "ENV") {
          const pairs = /^\S+=/.test(ins.raw) ? words(ins.raw).map((kv) => [kv.split("=")[0], kv.slice(kv.indexOf("=") + 1)]) : [[ins.raw.split(/\s+/)[0], ins.raw.replace(/^\S+\s+/, "")]];
          for (const [key, v] of pairs) st.cfg.Env = [...st.cfg.Env.filter((x) => !x.startsWith(key + "=")), `${key}=${v}`];
        }
        if (ins.name === "WORKDIR") st.cfg.WorkingDir = join(st.cfg.WorkingDir || "/", ins.raw);
        if (ins.name === "ARG") {
          const [k, dflt] = [ins.raw.split("=")[0].trim(), ins.raw.includes("=") ? ins.raw.slice(ins.raw.indexOf("=") + 1) : undefined];
          const given = (p.flags["build-arg"] || []).find((x) => x.split("=")[0] === k);
          const v = given !== undefined ? given.slice(given.indexOf("=") + 1) : dflt;
          if (v !== undefined) st.args[k] = v;
        }
        if (ins.name === "VOLUME") st.cfg.Volumes = [...new Set([...(st.cfg.Volumes || []), ...(execForm(ins.raw) || ins.raw.split(/\s+/))])];
        if (ins.name === "HEALTHCHECK") {
          const hc = ins.raw.replace(/^(--[\w-]+=\S+\s+)+/, "");
          st.cfg.Healthcheck = /^NONE$/i.test(hc) ? ["NONE"] : execForm(hc.replace(/^CMD\s+/i, "")) ? ["CMD", ...execForm(hc.replace(/^CMD\s+/i, ""))] : ["CMD-SHELL", hc.replace(/^CMD\s+/i, "")];
        }
        if (ins.name === "USER") st.cfg.User = ins.raw;
        if (ins.name === "CMD") st.cfg.Cmd = argvOf(ins.raw);
        if (ins.name === "ENTRYPOINT") { st.cfg.Entrypoint = argvOf(ins.raw); if (!cmdReset) st.cfg.Cmd = null; }
        if (ins.name === "CMD") cmdReset = true;
        if (ins.name === "EXPOSE") st.cfg.ExposedPorts = [...new Set([...(st.cfg.ExposedPorts || []), ...ins.raw.split(/\s+/).map((x) => Number(x.split("/")[0]))])];
      }
      results[i] = st;
    }

    if (diskBefore + fresh > e.capacity) {
      for (const k of added) e.cache.delete(k);
      return failWith("exporting to image", null, "failed to copy files: copy file range failed: no space left on device");
    }
    const r = results[final];
    const id = hexOf(`image|${r.key}`);
    const existing = e.images[id];
    const img = existing || { id, created: e.now, layers: r.layers, fs: r.fs, users: r.users, bins: r.bins, os: r.os, arch, config: r.cfg, built: e.ready, base: r.base };
    if (e.ready) img.built = true;
    const exportSecs = existing ? 0 : Math.min(9, e.imageSize(img) / (400 * MB));
    total += exportSecs;
    row("exporting to image", exportSecs);
    row("=> exporting layers", exportSecs);
    row(`=> writing image sha256:${id}`, 0);
    // The docker-container driver keeps results in its own cache unless told to --load them.
    const load = driver === "docker" || p.flags.load;
    if (load) for (const t of p.flags.tag || []) { row(`=> naming to ${fullRef(normRef(t))}`, 0); e.tag(t, img); }
    if (load && !(p.flags.tag || []).length) e.images[id] = img;
    const to = cacheRef(p.flags["cache-to"]);
    if (to) {
      e.remoteCache[to] = new Map(e.cache);
      row("exporting cache to registry", 1.1);
      row("=> preparing build cache for export", 0.4);
      row(`=> writing cache manifest sha256:${hexOf("cache" + to + e.cache.size)}`, 0.2);
    }
    if (!load) log.push(["WARNING: No output specified with docker-container driver. Build result will only remain in the build cache. To push result image into registry use --push or to load image into docker images use --load", "warn"]);
    e.lastBuild = { steps, image: id, tags: (p.flags.tag || []).map(normRef), user: e.ready };
    if (p.flags.quiet) return ok(`sha256:${id}`);
    return { code: 0, lines: [[`[+] Building ${total.toFixed(1)}s (${stepTotal + 3}/${stepTotal + 3}) FINISHED`.padEnd(66) + `${driver === "docker" ? "docker" : "docker-container"}:${builder}`, ""], ...log] };
  }

  // --- docker compose --------------------------------------------------------------

  // Enough YAML for compose files: nested maps, lists, inline [a, b], quotes, comments.
  function yaml(text) {
    const lines = text.split(/\r?\n/).map((raw, n) => ({ raw: raw.replace(/(^|\s)#.*$/, "").replace(/\s+$/, ""), n: n + 1 })).filter((l) => l.raw.trim());
    let i = 0;
    const indent = (l) => l.raw.length - l.raw.trimStart().length;
    const isItem = (l) => /^-(\s|$)/.test(l.raw.trimStart());
    const bad = (l, msg) => { throw new Error(`yaml: line ${l.n}: ${msg}`); };
    const scalar = (s) => {
      s = s.trim();
      if (/^"[^"]*"$|^'[^']*'$/.test(s)) return s.slice(1, -1);
      if (/^\[.*\]$/.test(s)) return s.slice(1, -1).split(",").map(scalar).filter((x) => x !== "");
      if (/^\{\s*\}$/.test(s)) return {};
      if (/^["']/.test(s)) bad(lines[Math.max(0, i - 1)], "found unexpected end of stream");
      return s;
    };
    const nested = (ind) => (i < lines.length && indent(lines[i]) > ind ? block(indent(lines[i])) : i < lines.length && indent(lines[i]) === ind && isItem(lines[i]) ? block(ind) : null);
    function block(ind) {
      if (isItem(lines[i])) {
        const arr = [];
        while (i < lines.length && indent(lines[i]) === ind && isItem(lines[i])) {
          const item = lines[i].raw.trimStart().slice(1).trim();
          i++;
          const kv = /^([\w.-]+):(?:\s+(.*))?$/.exec(item);
          if (!item) arr.push(nested(ind));
          else if (kv) {
            const obj = { [kv[1]]: kv[2] !== undefined ? scalar(kv[2]) : nested(ind + 2) };
            if (i < lines.length && indent(lines[i]) === ind + 2 && !isItem(lines[i])) Object.assign(obj, block(ind + 2));
            arr.push(obj);
          } else arr.push(scalar(item));
        }
        return arr;
      }
      const obj = {};
      while (i < lines.length && indent(lines[i]) === ind && !isItem(lines[i])) {
        const l = lines[i];
        const m = /^("[^"]+"|'[^']+'|[^:\s][^:]*?):(?:\s+(.*))?$/.exec(l.raw.trim());
        if (!m) bad(l, "could not find expected ':'");
        i++;
        const key = m[1].replace(/^["']|["']$/g, "");
        if (m[2] && /^[|>]-?$/.test(m[2])) {
          const parts = [];
          while (i < lines.length && indent(lines[i]) > ind) parts.push(lines[i++].raw.trim());
          obj[key] = parts.join(m[2].startsWith("|") ? "\n" : " ");
        } else obj[key] = m[2] !== undefined ? scalar(m[2]) : nested(ind);
      }
      if (i < lines.length && indent(lines[i]) > ind) bad(lines[i], "mapping values are not allowed in this context");
      return obj;
    }
    return lines.length ? block(indent(lines[0])) : {};
  }

  const COMPOSE_FILES = ["compose.yaml", "compose.yml", "docker-compose.yaml", "docker-compose.yml"];
  // Read the project in the current folder: interpolate variables, parse, normalise.
  function composeProject(e) {
    const path = COMPOSE_FILES.map((f) => join(e.cwd, f)).find((p) => e.host[p] && e.host[p].text !== undefined);
    if (!path) return { error: "no configuration file provided: not found" };
    const dotenv = e.host[join(e.cwd, ".env")];
    const vars = {};
    for (const l of dotenv && dotenv.text ? dotenv.text.split("\n") : []) {
      const m = /^\s*([A-Za-z_]\w*)\s*=\s*(.*)$/.exec(l);
      if (m) vars[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
    Object.assign(vars, e.env);
    const warnings = [];
    const text = e.host[path].text.replace(/\$\$|\$\{(\w+)(?:(:?[-?])([^}]*))?\}|\$(\w+)/g, (m, a, op, alt, b) => {
      if (m === "$$") return "$";
      const k = a || b;
      const v = vars[k];
      if (v === undefined || (op && op.startsWith(":") && v === "")) {
        if (op && op.endsWith("-")) return alt;
        if (!warnings.includes(k)) warnings.push(k);
        return "";
      }
      return v;
    });
    let doc;
    try { doc = yaml(text); } catch (err) { return { error: err.message }; }
    const project = String(doc.name || e.cwd.split("/").pop()).toLowerCase().replace(/[^a-z0-9_-]/g, "");
    const services = {};
    for (const [name, s0] of Object.entries(doc.services || {})) {
      const s = s0 || {};
      const env = Array.isArray(s.environment) ? s.environment.map(String) : Object.entries(s.environment || {}).map(([k, v]) => `${k}=${v ?? ""}`);
      const deps = Array.isArray(s.depends_on) ? Object.fromEntries(s.depends_on.map((d) => [d, "service_started"])) : Object.fromEntries(Object.entries(s.depends_on || {}).map(([d, o]) => [d, (o && o.condition) || "service_started"]));
      for (const d of Object.keys(deps)) if (!(doc.services || {})[d]) return { error: `service "${name}" depends on undefined service "${d}": invalid compose project` };
      const hc = s.healthcheck && s.healthcheck.test;
      services[name] = {
        name, image: s.image || (s.build ? `${project}-${name}` : null), build: s.build ? (typeof s.build === "string" ? s.build : s.build.context || ".") : null,
        ports: (s.ports || []).map(String), env, volumes: (s.volumes || []).map(String), deps, restart: s.restart || "no",
        command: s.command ? (Array.isArray(s.command) ? s.command : words(s.command)) : null,
        health: s.healthcheck && s.healthcheck.disable === "true" ? ["NONE"] : hc ? (Array.isArray(hc) ? hc : ["CMD-SHELL", hc]) : null,
        user: s.user, readOnly: s.read_only === "true", capDrop: s.cap_drop || [], capAdd: s.cap_add || [], memory: s.mem_limit ? parseBytes(s.mem_limit) : 0,
        log: s.logging ? { type: s.logging.driver || "json-file", opts: s.logging.options || {} } : null
      };
      if (!services[name].image) return { error: `service "${name}" has neither an image nor a build context specified: invalid compose project` };
    }
    if (!Object.keys(services).length) return { error: "no service selected" };
    return { project, services, volumes: Object.keys(doc.volumes || {}), text, warnings: warnings.map((k) => `WARN[0000] The "${k}" variable is not set. Defaulting to a blank string.`) };
  }

  const composeRow = (kind, name, status, secs) => ` ✔ ${kind} ${name}`.padEnd(46) + status.padEnd(28) + `${secs.toFixed(1)}s`;
  function compose(e, args) {
    const [sub, ...rest] = args;
    if (!sub) return ok(["Usage:  docker compose [OPTIONS] COMMAND", "", "Define and run multi-container applications with Docker"]);
    const p = parseFlags(rest, flagSpec("d|detach v|volumes a|all build no-deps f|follow q|quiet", "t|timeout n|tail", ""), sub === "exec");
    if (p.error) return usage(`compose ${sub}`, p.error);
    const pr = composeProject(e);
    if (pr.error) return fail(pr.error);
    const warn = pr.warnings.map((w) => [w, "warn"]);
    const net = `${pr.project}_default`;
    const cname = (s) => `${pr.project}-${s}-1`;
    const mine = () => e.containers.filter((c) => c.compose && c.compose.project === pr.project);
    const picked = (p.pos.length ? p.pos : Object.keys(pr.services));
    for (const s of p.pos) if (sub !== "exec" && !pr.services[s]) return fail(`no such service: ${s}`);

    if (sub === "config") return { code: 0, lines: [...warn, ...pr.text.replace(/\n$/, "").split("\n").map((l) => [l, ""])] };
    if (sub === "ps") {
      const list = mine().filter((c) => p.flags.all || c.state === "running" || c.state === "restarting");
      return { code: 0, lines: [...warn, ...table([["NAME", "IMAGE", "COMMAND", "SERVICE", "CREATED", "STATUS", "PORTS"],
        ...list.map((c) => [c.name, c.image, cmdOf(c), c.compose.service, `${duration(e.now - c.created)} ago`, statusOf(e, c), portsOf(e, c)])]).map((l, i) => [l, i ? "row" : "head"])] };
    }
    if (sub === "logs") {
      const list = mine().filter((c) => !p.pos.length || p.pos.includes(c.compose.service));
      const w = Math.max(0, ...list.map((c) => c.compose.service.length + 2));
      return { code: 0, lines: [...warn, ...list.flatMap((c) => c.logs.slice(-(Number(p.flags.tail) || c.logs.length)).map((l) => [`${(c.compose.service + "-1").padEnd(w)}  | ${l}`, ""]))] };
    }
    if (sub === "exec") {
      const [svc, ...cmd] = p.pos;
      const c = mine().find((x) => x.compose.service === svc);
      if (!c) return fail(`service "${svc}" is not running`);
      return dExec(e, [c.name, ...cmd]);
    }
    if (sub === "down" || sub === "stop" || sub === "restart" || sub === "start") {
      const lines = [...warn];
      const list = mine().filter((c) => !p.pos.length || p.pos.includes(c.compose.service));
      for (const c of list) {
        if (sub === "start") { if (c.state !== "running") e.start(c); lines.push([composeRow("Container", c.name, "Started", 0.3), ""]); continue; }
        e.stop(c);
        if (sub === "restart") { c.stopped = false; e.start(c); lines.push([composeRow("Container", c.name, "Started", 0.6), ""]); continue; }
        lines.push([composeRow("Container", c.name, "Stopped", 0.3), ""]);
        if (sub === "down") { e.remove(c, p.flags.volumes); lines.push([composeRow("Container", c.name, "Removed", 0.1), ""]); }
      }
      if (sub === "down") {
        if (p.flags.volumes) for (const v of pr.volumes) if (e.volumes[`${pr.project}_${v}`]) { delete e.volumes[`${pr.project}_${v}`]; lines.push([composeRow("Volume", `${pr.project}_${v}`, "Removed", 0.1), ""]); }
        if (e.networks[net]) { delete e.networks[net]; lines.push([composeRow("Network", net, "Removed", 0.2), ""]); }
      }
      const body = lines.slice(warn.length);
      return { code: 0, lines: [...warn, [`[+] Running ${body.length}/${body.length}`, ""], ...body] };
    }
    if (sub !== "up" && sub !== "build" && sub !== "pull") return LAB(`docker compose ${sub}`);

    // up: dependencies first, then each service; create, recreate or leave it.
    const order = [];
    const visit = (s, seen = []) => {
      if (order.includes(s) || seen.includes(s)) return;
      for (const d of Object.keys(pr.services[s].deps)) visit(d, [...seen, s]);
      order.push(s);
    };
    picked.forEach((s) => visit(s));
    const lines = [...warn];
    const rows = [];
    const done = () => ({ code: 0, lines: [...lines, [`[+] Running ${rows.length}/${rows.length}`, ""], ...rows.map((x) => [x, ""])] });
    for (const s of order) {
      const svc = pr.services[s];
      if (svc.build && (sub !== "up" || p.flags.build || !e.image(svc.image))) {
        const cwd = e.cwd;
        const b = dBuild(e, ["-t", svc.image, svc.build]);
        e.cwd = cwd;
        lines.push(...b.lines);
        if (b.code) return { code: 1, lines };
      }
    }
    if (sub === "build") return { code: 0, lines };
    if (!e.networks[net]) { e.addNetwork(net, "bridge"); rows.push(composeRow("Network", net, "Created", 0.1)); }
    for (const v of pr.volumes) if (!e.volumes[`${pr.project}_${v}`]) { e.volume(`${pr.project}_${v}`, false); rows.push(composeRow("Volume", `"${pr.project}_${v}"`, "Created", 0)); }
    for (const s of order) {
      const svc = pr.services[s];
      let img = e.image(svc.image);
      if (!img) {
        const r = e.pullLines(svc.image);
        if (r.error) return { code: 1, lines: [...lines, ...rows.map((x) => [x, ""]), [` ✘ ${s} Error ${r.error}`, "warn"], [`Error response from daemon: ${r.error}`, "warn"]] };
        rows.push(` ✔ ${s} Pulled`.padEnd(74) + "2.4s");
        img = e.image(svc.image);
      }
      if (sub === "pull") continue;
      const hash = hexOf(JSON.stringify(svc) + img.id);
      let c = mine().find((x) => x.compose.service === s);
      let verb = "Started";
      if (c && c.compose.hash !== hash) { e.stop(c); e.remove(c, false); c = null; verb = "Recreated"; }
      // Wait for dependencies that must be healthy first.
      let waited = false;
      for (const [d, cond] of Object.entries(svc.deps)) {
        const dc = mine().find((x) => x.compose.service === d);
        if (!dc || cond !== "service_healthy") continue;
        if (!(dc.health || e.images[dc.imageId].config.Healthcheck)) return { code: 1, lines: [...lines, ...rows.map((x) => [x, ""]), [`dependency failed to start: container ${dc.name} has no healthcheck configured`, "warn"]] };
        const start = e.now;
        while (e.now - start < 60000 && dc.state === "running" && (e.health(dc) || {}).status !== "healthy") e.tick(1000);
        if (dc.state !== "running") return { code: 1, lines: [...lines, ...rows.map((x) => [x, ""]), [`dependency failed to start: container ${dc.name} exited (${dc.exitCode})`, "warn"]] };
        if ((e.health(dc) || {}).status !== "healthy") return { code: 1, lines: [...lines, ...rows.map((x) => [x, ""]), [`dependency failed to start: container ${dc.name} is unhealthy`, "warn"]] };
        rows.push(composeRow("Container", dc.name, "Healthy", (e.now - start) / 1000 + 0.5));
        waited = true;
      }
      if (c && c.state === "running") { rows.push(composeRow("Container", c.name, "Running", 0)); continue; }
      if (!c) {
        const ports = parsePorts(e, svc.ports, false, img);
        if (ports.error) return fail(ports.error);
        const m = parseMounts(e, { volume: svc.volumes.map((v) => (/^[\w][\w.-]*:/.test(v) && pr.volumes.includes(v.split(":")[0]) ? `${pr.project}_${v}` : v)) });
        if (m.error) return fail(m.error);
        for (const v of img.config.Volumes || []) if (!m.mounts.some((x) => x.dest === v)) m.mounts.push({ type: "volume", name: e.id("anon" + v + s), dest: v, anon: true });
        c = newContainer(e, {
          name: cname(s), image: svc.image, imageId: img.id, cmd: svc.command || img.config.Cmd, entrypoint: img.config.Entrypoint, user: svc.user, env: svc.env,
          ports: ports.ports, mounts: m.mounts, netMode: net, aliases: [s], restart: svc.restart, memory: svc.memory, memorySwap: svc.memory * 2,
          readOnly: svc.readOnly, capDrop: svc.capDrop, capAdd: svc.capAdd, health: svc.health, log: svc.log
        });
        for (const mt of c.mounts) if (mt.type === "volume") e.volume(mt.name, mt.anon);
        c.compose = { project: pr.project, service: s, hash };
        e.containers.push(c);
        if (verb === "Started") rows.push(composeRow("Container", c.name, "Created", 0.1));
      }
      c.compose.waited = waited;
      c.stopped = false;
      const err = e.start(c);
      if (err) return { code: 1, lines: [...lines, ...rows.map((x) => [x, ""]), [` ✘ Container ${c.name}  Error`, "warn"], [`Error response from daemon: ${err}`, "warn"]] };
      rows.push(composeRow("Container", c.name, verb, 0.4));
    }
    const out = done();
    if (sub === "up" && !p.flags.detach) {
      const list = order.map((s) => mine().find((x) => x.compose.service === s)).filter(Boolean);
      out.lines.push([`Attaching to ${list.map((c) => `${c.compose.service}-1`).join(", ")}`, ""], ...list.flatMap((c) => c.logs.map((l) => [`${c.compose.service}-1  | ${l}`, ""])),
        ...list.filter((c) => c.state !== "running").map((c) => [`${c.compose.service}-1 exited with code ${c.exitCode}`, ""]), ["(attached: a real terminal keeps showing the logs until you press Ctrl+C. Add -d to run it in the background.)", "dim"]);
    }
    return out;
  }

  function buildx(e, [sub, ...args]) {
    const p = parseFlags(args, flagSpec("use bootstrap", "name driver", ""), false);
    if (p.error) return usage(`buildx ${sub}`, p.error);
    if (sub === "create") {
      const name = p.flags.name || `${["eager", "brave", "calm"][hash(String(e.now)) % 3]}_${["hopper", "turing"][hash(String(e.now + 1)) % 2]}`;
      const driver = p.flags.driver || "docker-container";
      if (!/^(docker-container|kubernetes|remote)$/.test(driver)) return fail(`ERROR: failed to find driver "${driver}"`);
      if (e.builders[name]) return fail(`ERROR: existing instance for "${name}" but no append mode, specify the node name to make changes for existing instances`);
      e.builders[name] = driver;
      if (p.flags.use) e.builder = name;
      return ok(name);
    }
    if (sub === "use") {
      if (!e.builders[p.pos[0]]) return fail(`ERROR: run \`docker buildx ls\` to list available builders: no builder "${p.pos[0] || ""}" found`);
      e.builder = p.pos[0];
      return ok([]);
    }
    if (sub === "rm") {
      const n = p.pos[0] || e.builder;
      if (n === "default") return fail("ERROR: default is a docker driver builder and cannot be removed");
      if (!e.builders[n]) return fail(`ERROR: no builder "${n}" found`);
      delete e.builders[n];
      if (e.builder === n) e.builder = "default";
      return ok([`${n} removed`]);
    }
    const rows = [["NAME/NODE", "DRIVER/ENDPOINT", "STATUS", "BUILDKIT", "PLATFORMS"]];
    for (const [n, d] of Object.entries(e.builders)) {
      rows.push([`${n}${n === e.builder ? "*" : ""}`, d, "", "", ""], [` \\_ ${n}${d === "docker" ? "" : "0"}`, ` \\_ ${d === "docker" ? "default" : "unix:///var/run/docker.sock"}`, "running", d === "docker" ? "v0.17.3" : "v0.18.2", "linux/amd64 (+3)"]);
    }
    return { code: 0, lines: table(rows).map((l, i) => [l, i ? "row" : "head"]) };
  }

  // Practice findings for the simulated scanner. The IDs are invented, not real CVEs.
  const VULNS = {
    "node:22": [["TRACK-2026-0101", "CRITICAL", "openssl", "3.0.14-1~deb12u2", "3.0.15-1~deb12u1"], ["TRACK-2026-0102", "CRITICAL", "libexpat1", "2.5.0-1", "2.5.0-1+deb12u1"],
      ["TRACK-2026-0110", "HIGH", "curl", "7.88.1-10+deb12u7", "7.88.1-10+deb12u8"], ["TRACK-2026-0111", "HIGH", "imagemagick", "8:6.9.11.60+dfsg-1.6", null],
      ["TRACK-2026-0112", "HIGH", "git", "1:2.39.5-0+deb12u1", null], ["TRACK-2026-0113", "HIGH", "python3.11", "3.11.2-6", "3.11.2-6+deb12u4"], ["TRACK-2026-0120", "MEDIUM", "perl", "5.36.0-7+deb12u1", null]],
    "node:22-slim": [["TRACK-2026-0120", "MEDIUM", "perl-base", "5.36.0-7+deb12u1", null], ["TRACK-2026-0130", "LOW", "libc6", "2.36-9+deb12u9", null]],
    "node:22-alpine": [["TRACK-2026-0140", "LOW", "busybox", "1.36.1-r29", null]],
    "nginx:1.27": [["TRACK-2026-0121", "MEDIUM", "libxml2", "2.9.14+dfsg-1.3~deb12u1", null]],
    "redis:7.4": [["TRACK-2026-0131", "LOW", "libc6", "2.36-9+deb12u9", null]],
    "postgres:17": [["TRACK-2026-0122", "MEDIUM", "libldap-2.5-0", "2.5.13+dfsg-5", null]],
    "postgres:16": [["TRACK-2026-0122", "MEDIUM", "libldap-2.5-0", "2.5.13+dfsg-5", null]]
  };
  const SEVERITIES = ["CRITICAL", "HIGH", "MEDIUM", "LOW"];
  // An apt-get upgrade in the image removes the findings that have a fixed version.
  function vulnsOf(img) {
    const upgraded = img.layers.some((l) => /apt-get (-\S+ )*(dist-)?upgrade/.test(l.by));
    return (VULNS[img.base] || []).filter((v) => !(upgraded && v[4]));
  }
  function scout(e, [sub, ...args]) {
    if (!/^(cves|quickview)$/.test(sub || "")) return LAB(`docker scout ${sub || ""}`.trim());
    const p = parseFlags(args, flagSpec("exit-code", "only-severity format", ""), false);
    if (p.error) return usage(`scout ${sub}`, p.error);
    const ref = p.pos[0];
    const img = ref && (e.image(ref) || e.registry(ref));
    if (!img) return fail(`ERROR could not find image: ${ref || "(none given)"}`);
    const only = p.flags["only-severity"] ? p.flags["only-severity"].toUpperCase().split(",") : SEVERITIES;
    const found = vulnsOf(img).filter((v) => only.includes(v[1]));
    const pl = (n, word) => `${n} ${word}${n === 1 ? "" : word.endsWith("y") ? "" : "s"}`.replace(/y$/, n === 1 ? "y" : "ies");
    const count = (list) => SEVERITIES.map((s) => `${String(list.filter((v) => v[1] === s).length).padStart(4)}${s[0]}`).join(" ");
    const pkgs = img.base && img.base.includes("alpine") ? 224 : img.base && img.base.includes("slim") ? 318 : 712;
    const lines = [[`    ✓ SBOM of image already cached, ${pkgs} packages indexed`, ""]];
    if (sub === "quickview") {
      lines.push(["", ""], [`  Target     │  ${ref.padEnd(18)}│ ${count(vulnsOf(img))}`, ""], [`  Base image │  ${(img.base || "unknown").padEnd(18)}│ ${count(VULNS[img.base] || [])}`, ""]);
      return ok(lines);
    }
    lines.push(found.length ? [`    ✗ Detected ${pl(new Set(found.map((v) => v[2])).size, "vulnerable package")} with a total of ${pl(found.length, "vulnerability")}`, "warn"] : ["    ✓ No vulnerable package detected", ""],
      ["    Practice findings: these IDs are made up for this playground, not real CVEs.", "dim"]);
    for (const v of found) lines.push(["", ""], [`   ${count([v])}  ${v[2]} ${v[3]}`, ""], [`    ✗ ${v[1]} ${v[0]}`, v[1] === "CRITICAL" || v[1] === "HIGH" ? "warn" : ""], [`      Fixed version : ${v[4] || "not fixed"}`, "dim"]);
    if (found.length) lines.push(["", ""], [`${pl(found.length, "vulnerability")} found in ${pl(new Set(found.map((v) => v[2])).size, "package")}`, ""], ...SEVERITIES.map((s) => [`  ${s.padEnd(9)} ${found.filter((v) => v[1] === s).length}`, ""]));
    return { code: p.flags["exit-code"] && found.length ? 2 : 0, lines };
  }

  function login(e, args, stdin) {
    const p = parseFlags(args, flagSpec("password-stdin", "u|username p|password", ""), false);
    if (p.error) return usage("login", p.error);
    const server = !p.pos[0] || /^(docker\.io|index\.docker\.io|registry-1\.docker\.io|https:\/\/index\.docker\.io\/v1\/)$/.test(p.pos[0]) ? "docker.io" : p.pos[0];
    const lines = [];
    let secret = p.flags.password;
    if (p.flags["password-stdin"]) {
      if (!p.flags.username) return fail("Error: Must provide --username with --password-stdin");
      secret = (stdin || "").trim();
      if (!secret) return fail("Error: Cannot perform an interactive login from a non TTY device");
    } else if (secret) lines.push(["WARNING! Using --password via the CLI is insecure. Use --password-stdin.", "warn"]);
    else return na("docker login asks for a password. In the playground, pipe a token in: echo $TOKEN | docker login <registry> -u <user> --password-stdin");
    if (!p.flags.username) return fail("Error: Cannot perform an interactive login from a non TTY device");
    e.logins.add(server);
    return ok([...lines, ["Login Succeeded", ""]]);
  }

  function docker(e, args, stdin) {
    let [sub, ...rest] = args;
    const groups = {
      container: { ls: "ps", list: "ps", run: "run", create: "create", start: "start", stop: "stop", restart: "restart", rm: "rm", remove: "rm", kill: "kill", logs: "logs", inspect: "inspect", exec: "exec", prune: "container-prune", port: "port", stats: "stats", update: "update" },
      image: { ls: "images", list: "images", rm: "rmi", remove: "rmi", history: "history", inspect: "image-inspect", prune: "image-prune", pull: "pull", build: "build", tag: "tag" },
      buildx: { build: "build", prune: "builder-prune" },
      builder: { build: "build", prune: "builder-prune" },
      system: { df: "df", prune: "system-prune", info: "info" }
    };
    if (sub === "buildx" && /^(create|use|ls|rm)$/.test(rest[0] || "")) return buildx(e, rest);
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
      case "login": return login(e, rest, stdin);
      case "scout": return scout(e, rest);
      case "logout": {
        const server = rest[0] && !/docker\.io/.test(rest[0]) ? rest[0] : "docker.io";
        if (!e.logins.has(server)) return ok(`Not logged in to ${server === "docker.io" ? "https://index.docker.io/v1/" : server}`);
        e.logins.delete(server);
        return ok(`Removing login credentials for ${server === "docker.io" ? "https://index.docker.io/v1/" : server}`);
      }
      case "rename": {
        const [from, to] = rest;
        if (!from || !to) return fail(["docker: 'rename' requires 2 arguments.", "", "See 'docker rename --help' for more information"]);
        const c = e.container(from);
        if (!c) return fail(`Error response from daemon: No such container: ${from}`);
        const taken = e.container(to);
        if (taken && taken.name === to) return fail(`Error response from daemon: Error when allocating new name: Conflict. The container name "/${to}" is already in use by container "${taken.id}". You have to remove (or rename) that container to be able to reuse that name.`);
        c.name = to;
        return ok([]);
      }
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
            const sig = String(p.flags.signal || "KILL").toUpperCase().replace(/^SIG/, "");
            // A TERM to a PID 1 with no handler is simply ignored.
            if (sig === "TERM" && !c.init && !c.proc.handlesTerm && !(APPS[c.proc.app] && APPS[c.proc.app].stopCode !== undefined)) return ok(n);
            e.stop(c, sig === "TERM" ? "TERM" : "KILL", 0);
            return ok(n);
          }
          const waited = sub === "stop" || sub === "restart" ? e.stop(c, null, p.flags.time !== undefined ? Number(p.flags.time) : undefined) : 0;
          const note = waited ? [[`(Docker waited ${waited}s for ${n} to exit after SIGTERM, then sent SIGKILL)`, "dim"]] : [];
          if (sub === "stop") return { code: 0, lines: [[n, ""], ...note] };
          if (c.state === "running") return ok(n);
          c.stopped = false;
          const err = e.start(c);
          return err ? fail([`Error response from daemon: ${err}`, `Error: failed to start containers: ${n}`]) : { code: 0, lines: [...note, [n, ""]] };
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
          ...list.map((c) => [c.id.slice(0, 12), c.name, c.state !== "running" ? "0.00%" : APPS[c.proc.app] && APPS[c.proc.app].cpuNeed ? `${(Math.min(c.cpus || 9, APPS[c.proc.app].cpuNeed) * 100 - 0.03).toFixed(2)}%` : "0.02%", `${mib(mem(c))} / ${mib(limit(c))}`, `${(mem(c) / limit(c) * 100).toFixed(2)}%`, c.state === "running" ? "1.2kB / 0B" : "0B / 0B", "0B / 0B", c.state === "running" ? String(c.pids || 11) : "0"])]).map((l, i) => [l, i ? "row" : "head"]) };
      }
      case "df": {
        const p = simple(flagSpec("v|verbose", "format", ""));
        if (p.error) return usage("system df", p.error);
        const d = diskUse(e);
        const pct = (a, b) => (b ? `${human(a)} (${Math.round(a / b * 100)}%)` : "0B");
        return { code: 0, lines: table([["TYPE", "TOTAL", "ACTIVE", "SIZE", "RECLAIMABLE"],
          ["Images", d.images, d.activeImages, human(d.imageSize), pct(d.imageFree, d.imageSize)],
          ["Containers", d.containers, d.running, human(d.containers * 1100), `${human((d.containers - d.running) * 1100)} (${d.containers ? Math.round((d.containers - d.running) / d.containers * 100) : 0}%)`],
          ["Local Volumes", d.volumes, d.activeVolumes, human(d.volumeSize), pct(d.volumeFree, d.volumeSize)],
          ["Build Cache", d.cacheCount, 0, human(d.cacheSize), human(d.cacheSize)]]).map((l, i) => [l, i ? "row" : "head"]) };
      }
      case "container-prune": case "image-prune": case "system-prune": case "builder-prune": {
        const p = simple(flagSpec("f|force a|all volumes", "filter", "filter"));
        if (p.error) return usage(sub.replace("-", " "), p.error);
        return prune(e, sub.split("-")[0], p.flags);
      }
      case "compose": return compose(e, rest);
      case "push": case "cp": case "events": case "attach": case "commit": case "save": case "load": case "export": case "import": case "context": case "swarm": case "service": case "stack": case "search": case "init": case "debug": case "top": case "pause": case "unpause": case "wait": case "diff": case "secret": case "config": case "plugin": case "trust": case "manifest": case "node":
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
      case "export": {
        for (const kv of a) {
          if (!/^[A-Za-z_]\w*=/.test(kv)) return err(`bash: export: \`${kv}': not a valid identifier`);
          e.env[kv.split("=")[0]] = kv.slice(kv.indexOf("=") + 1);
        }
        return ok([]);
      }
      case "unset": { for (const k of a) delete e.env[k]; return ok([]); }
      case "env": case "printenv": return say([`HOME=${HOME}`, `PWD=${e.cwd}`, "USER=dev", ...Object.entries(e.env).map(([k, v]) => `${k}=${v}`)].join("\n"));
      case "df": {
        const g = (b) => (b >= 10 * GB ? `${Math.round(b / 1024 / MiB)}G` : `${(b / 1024 / MiB).toFixed(1)}G`);
        const used = e.diskUsed();
        return ok(table([["Filesystem", "Size", "Used", "Avail", "Use%", "Mounted on"], ["/dev/sda1", g(e.capacity), g(used), g(Math.max(0, e.capacity - used)), `${Math.min(100, Math.round(used / e.capacity * 100))}%`, "/"]]), "row");
      }
      case "truncate": {
        const target = pos[pos.length - 1] || "";
        const c = e.containers.find((x) => target.includes(x.id));
        if (!a.includes("-s") || !c) return err(`truncate: cannot open '${target}' for writing: No such file or directory`);
        if (!sudo) return err(`truncate: cannot open '${target}' for writing: Permission denied`);
        c.logBytes = 0;
        return ok([]);
      }
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
      case "id": return say(sudo ? "uid=0(root) gid=0(root) groups=0(root)" : `uid=1000(dev) gid=1000(dev) groups=1000(dev),27(sudo)${e.groups.includes("docker") ? ",998(docker)" : ""}`);
      case "cp": {
        const [src, dst] = pos;
        const s = e.host[join(e.cwd, src || "")];
        if (!s || s.dir) return err(`cp: cannot stat '${src}': No such file or directory`);
        let to = join(e.cwd, dst || "");
        if (stat(e.host, to) && stat(e.host, to).dir) to = join(to, src.split("/").pop());
        const parent = stat(e.host, join(to, ".."));
        if (!parent) return err(`cp: cannot create regular file '${dst}': No such file or directory`);
        if (!canWrite(parent, uid, uid)) return err(`cp: cannot create regular file '${dst}': Permission denied`);
        e.host[to] = { ...s, uid, gid: uid };
        return ok([]);
      }
      case "update-ca-certificates": {
        if (!sudo) return err("Updating certificates in /etc/ssl/certs...\nln: failed to create symbolic link '/etc/ssl/certs/ca-certificates.crt': Permission denied");
        const n = Object.keys(e.host).filter((p) => /^\/usr\/local\/share\/ca-certificates\/.+\.crt$/.test(p)).length;
        e.caPending = n > 0;
        return ok(["Updating certificates in /etc/ssl/certs...", `${n} added, 0 removed; done.`, "Running hooks in /etc/ca-certificates/update.d...", "done."]);
      }
      case "groups": return say(sudo ? "root" : e.groups.join(" "));
      case "usermod": {
        if (!sudo) return err("usermod: Permission denied.\nusermod: cannot lock /etc/passwd; try again later.");
        const g = a[a.indexOf("-aG") + 1] || a[a.indexOf("-G") + 1];
        if (!a.includes("-aG") && !(a.includes("-a") && a.includes("-G"))) return na("The playground runs usermod -aG <group> <user>.");
        if (g !== "docker" || pos[pos.length - 1] !== "dev") return err(`usermod: group '${g}' does not exist`);
        if (!e.pendingGroups.includes(g)) e.pendingGroups.push(g);
        return ok([]);
      }
      case "newgrp": {
        if (!e.pendingGroups.includes(a[0]) && !e.groups.includes(a[0])) return err("newgrp: failed to crypt password with previous salt: Invalid argument");
        if (!e.groups.includes(a[0])) e.groups.push(a[0]);
        return ok([]);
      }
      case "systemctl": case "service": {
        const [verb, unit] = cmd === "service" ? [a[1], a[0]] : [a[0], a[1]];
        if (!/^docker(\.service)?$/.test(unit || "")) return LAB(`${cmd} for ${unit || "that unit"}`);
        if (verb === "status" || verb === "is-active") {
          const since = `since Fri 2026-10-30 ${new Date(e.daemon.since || e.now).toISOString().slice(11, 19)} UTC`;
          return ok(verb === "is-active" ? [e.daemon.up ? "active" : "failed"] : ["● docker.service - Docker Application Container Engine", "     Loaded: loaded (/usr/lib/systemd/system/docker.service; enabled; preset: enabled)",
            e.daemon.up ? `     Active: active (running) ${since}` : `     Active: failed (Result: exit-code) ${since}`, "TriggeredBy: ● docker.socket", "       Docs: https://docs.docker.com"]);
        }
        if (!sudo) return err(`Failed to ${verb} docker.service: Access denied\nSee system logs and 'systemctl status docker.service' for details.`);
        if (verb === "stop") { daemonStop(e); return ok([]); }
        if (verb === "start" || verb === "restart") {
          if (verb === "restart") daemonStop(e);
          const why = daemonStart(e);
          return why ? err('Job for docker.service failed because the control process exited with error code.\nSee "systemctl status docker.service" and "journalctl -xeu docker.service" for details.') : ok([]);
        }
        return LAB(`systemctl ${verb}`);
      }
      case "journalctl": {
        const t = new Date(e.daemon.since || e.now).toISOString().slice(11, 19);
        return ok(e.daemon.error ? [`Oct 30 ${t} server dockerd[1187]: ${e.daemon.error}`, `Oct 30 ${t} server systemd[1]: docker.service: Main process exited, code=exited, status=1/FAILURE`,
          `Oct 30 ${t} server systemd[1]: docker.service: Failed with result 'exit-code'.`, `Oct 30 ${t} server systemd[1]: Failed to start docker.service - Docker Application Container Engine.`]
          : [`Oct 30 ${t} server dockerd[1187]: time="2026-10-30T${t}Z" level=info msg="API listen on /run/docker.sock"`, `Oct 30 ${t} server systemd[1]: Started docker.service - Docker Application Container Engine.`]);
      }
      case "ufw": {
        if (!sudo) return err("ERROR: You need to be root to run this script");
        if (a[0] === "status") return ok(["Status: active", "", "To                         Action      From", "--                         ------      ----", ...e.firewall]);
        if (/^(deny|allow|reject)$/.test(a[0]) && a[1]) { e.firewall.push(`${a[1].padEnd(27)}${a[0].toUpperCase().padEnd(12)}Anywhere`); return ok(["Rule added", "Rule added (v6)"]); }
        return na("The playground runs ufw status, ufw deny <port> and ufw allow <port>.");
      }
      case "iptables": {
        if (!sudo) return err("iptables v1.8.10 (nf_tables): Could not fetch rule set generation id: Permission denied (you must be root)");
        if (!a.includes("-L")) return na("The playground lists rules: sudo iptables -L DOCKER -n");
        const rows = e.containers.filter((c) => c.state === "running").flatMap((c) => c.ports.map((p) => `ACCEPT     tcp  --  0.0.0.0/0            ${(Object.values(c.nets)[0] || {}).ip || ""}           tcp dpt:${p.cont}`));
        return ok(["Chain DOCKER (2 references)", "target     prot opt source               destination", ...rows]);
      }
      case "ss": case "netstat": return ok(["State   Recv-Q  Send-Q  Local Address:Port  Peer Address:Port", "LISTEN  0       4096    0.0.0.0:22          0.0.0.0:*", ...Object.keys(e.hostServices).map((p) => `LISTEN  0       511     0.0.0.0:${p}        0.0.0.0:*`),
        ...e.containers.filter((c) => c.state === "running").flatMap((c) => c.ports.map((p) => `LISTEN  0       4096    ${p.hostIp || "0.0.0.0"}:${p.host}        0.0.0.0:*`))]);
      case "redis-cli": return Object.values(e.hostServices).includes("redis") ? say("PONG") : err("Could not connect to Redis at 127.0.0.1:6379: Connection refused");
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
        const human1024 = (n) => (n >= GB ? (n / 1024 / MiB).toFixed(1) + "G" : n >= MiB ? Math.round(n / MiB) + "M" : Math.max(4, Math.round(n / 1024)) + "K");
        for (const f of pos.length ? pos : ["."]) {
          const logOf = e.containers.find((c) => f.includes(c.id));
          if (logOf) { if (!sudo) return err(`du: cannot read directory '${f}': Permission denied`); lines.push(`${human1024(logOf.logBytes)}\t${f}`); continue; }
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
        const del = /^\/(.+)\/d$/.exec(expr || "");
        const p = join(e.cwd, file || "");
        if (del && e.host[p] && e.host[p].text !== undefined) {
          let dre;
          try { dre = new RegExp(del[1]); } catch { return err("sed: -e expression #1: invalid regular expression"); }
          e.writeFile(p, e.host[p].text.split("\n").filter((l) => !dre.test(l)).join("\n"));
          return ok([]);
        }
        if (!m) return err(`sed: -e expression #1, char ${String(expr || "").length}: unterminated \`s' command`);
        if (!e.host[p] || e.host[p].text === undefined) return err(`sed: can't read ${file}: No such file or directory`);
        let re;
        try { re = new RegExp(m[2].replace(/\\\//g, "/"), m[4] ? "g" : ""); } catch { return err(`sed: -e expression #1: invalid regular expression`); }
        e.writeFile(p, e.host[p].text.split("\n").map((l) => l.replace(re, m[3].replace(/\\\//g, "/").replace(/\\n/g, "\n").replace(/&/g, "$&"))).join("\n"));
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
      case "docker-compose": return err("Command 'docker-compose' not found, but can be installed with:\n\nsudo snap install docker\n\nCompose v2 is part of Docker: use docker compose (with a space).");
      case "node": case "npm": case "npx": case "yarn":
        return err(`Command '${cmd}' not found, but can be installed with:\n\nsudo apt install ${cmd === "npx" ? "npm" : cmd === "yarn" ? "yarnpkg" : cmd}`);
      case "apt": case "apt-get": case "snap":
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
    const expanded = String(line).replace(/\$\(pwd\)/g, e.cwd).replace(/(^|\s)~(?=\/|\s|$)/g, `$1${HOME}`);
    const toks = lex(expanded, { ...e.env, HOME, PWD: e.cwd, USER: "dev" });
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
          if (pipe[0] === "docker") { r = runOne(e, pipe, r.lines.map((l) => l[0]).join("\n")); continue; }
          const lines = filterLines(r.lines, pipe);
          r = lines ? { code: pipe[0] === "grep" && !lines.length ? 1 : 0, lines } : { code: 1, lines: [[`The playground pipes into grep, head, tail, sort, wc and docker login.`, "na"]] };
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

  function runOne(e, w, stdin) {
    if (!w.length) return ok([]);
    e.tick(1000);
    // A restart policy tries again a few seconds after each exit.
    for (const c of e.containers) if (c.state === "restarting" && e.now - c.finishedAt >= 5000) e.start(c);
    // The resizer leaks a process per request until its limit, or the host's, stops it.
    for (const c of e.containers) {
      if (c.state !== "running" || c.proc.app !== "resizer") continue;
      const before = c.pids;
      c.pids = Math.max(c.pids, Math.min(c.pids + 1500, c.pidsLimit || Infinity, c.pids + Math.max(0, e.pidsFree())));
      if (c.pids === before && !c.logs[c.logs.length - 1].includes("EAGAIN")) c.logs.push("resizer: spawn failed: Error: spawn convert EAGAIN");
    }
    let [cmd, ...a] = w;
    let sudo = false;
    if (cmd === "sudo") { sudo = true; [cmd, ...a] = a; if (!cmd) return fail("usage: sudo command"); }
    try {
      if (cmd === "docker") {
        const local = !a.length || /^(--version|-v|help|--help|login|logout)$/.test(a[0]);
        if (!local && !e.daemon.up) return fail(`${a[0] === "run" ? "docker: " : ""}Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?`);
        const sock = e.host["/var/run/docker.sock"];
        if (!local && !sudo && !e.groups.includes("docker") && !(sock.mode & 0o006)) {
          return fail(`${a[0] === "run" ? "docker: " : ""}permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock: Get "http://%2Fvar%2Frun%2Fdocker.sock/v1.48/${a[0] === "images" ? "images" : "containers"}/json": dial unix /var/run/docker.sock: connect: permission denied`);
        }
        return docker(e, a, stdin);
      }
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
  const nodeDockerfile = (script, user, port) => `FROM node:22-alpine\n${user === "app" ? "RUN addgroup -S -g 10001 app && adduser -S -u 10001 -G app app\n" : ""}WORKDIR /app\nCOPY package*.json ./\nRUN npm ci --omit=dev\nCOPY . .\nUSER ${user}\n${port ? `EXPOSE ${port}\n` : ""}CMD ["node", "${script}"]\n`;
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
    "server.js": file(SHOP_SERVER, { app: "shop" }), "README.md": file("# shop\n\nThe storefront. Run it with: docker build -t nimbus/shop . && docker run -p 3000:3000 nimbus/shop\n"),
    public: dirBlob(1.3 * MB), ".git": dirBlob(96 * MB), ...(hostModules ? { node_modules: dirBlob(210 * MB), logs: dirBlob(3.1 * MB), ".env": file("# local settings for development; never copy into an image\nSHOP_DB_HOST=localhost\nSHOP_DB_USER=shop\n") } : {})
  });
  const BIG_DOCKERFILE = 'FROM node:22\nWORKDIR /app\nCOPY . .\nRUN npm ci\nCMD ["node", "server.js"]\n';
  const DEV_DOCKERFILE = 'FROM node:22-alpine\nWORKDIR /app\nCOPY package*.json ./\nRUN npm ci\nCOPY . .\nEXPOSE 3000\nCMD ["node", "server.js"]\n';
  const SLOW_DOCKERFILE = 'FROM node:22-alpine\nWORKDIR /app\nCOPY . .\nRUN npm ci --omit=dev\nEXPOSE 3000\nCMD ["node", "server.js"]\n';

  const byImage = (e, repo) => e.containers.filter((c) => (e.tagsOf(e.images[c.imageId]) || []).some((t) => t.startsWith(repo + ":")));
  const web = (e, port) => { const r = e.http(null, `localhost:${port}`); return { ok: r.code === 0, text: r.code === 0 ? `answers (${r.app})` : r.text.replace(/^curl: \(\d+\) /, "") }; };
  const newestShop = (e) => Object.values(e.images).filter((i) => i.built && e.tagsOf(i).some((t) => t.startsWith("nimbus/shop:"))).sort((a, b) => b.created - a.created)[0];

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
      setup: ["docker pull redis:7.4", `cd ${HOME}/api`, "docker build -t nimbus/api:1.0 .", `cd ${HOME}`, 120, "docker run -d --name cache redis:7.4", "docker run -d --name api -p 8080:8080 nimbus/api:1.0", 2],
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
      setup: [`cd ${HOME}/shop`, "docker build -t nimbus/shop:1.0 .", 30, `docker run -d --name shop -p 3000:3000 -v ${HOME}/shop:/app nimbus/shop:1.0`, 1],
      won: (e) => web(e, 3000).ok && byImage(e, "nimbus/shop").some((c) => c.state === "running" && c.mounts.some((m) => m.type === "bind" && m.source === `${HOME}/shop` && m.dest === "/app")),
      check: (e) => ({ label: "curl localhost:3000", ...web(e, 3000) }),
      hints: [
        "docker logs shop: the app cannot find express. Yet the image installed it: docker run --rm nimbus/shop:1.0 ls /app shows node_modules.",
        "The bind mount lays your folder over /app, and your folder has no node_modules (ls). A mount hides whatever the image had at that path.",
        "Keep the bind mount and give node_modules its own volume, which Docker fills from the image: docker rm shop && docker run -d --name shop -p 3000:3000 -v /home/dev/shop:/app -v /app/node_modules nimbus/shop:1.0"
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
      setup: [`cd ${HOME}/uploader`, "docker build -t nimbus/uploader:1.0 .", `cd ${HOME}`, 60, "docker run -d --name uploader -p 8080:8080 -v /srv/uploads:/data/uploads nimbus/uploader:1.0", 1],
      won: (e) => byImage(e, "nimbus/uploader").some((c) => c.state === "running" && e.userOf(c).uid !== 0 && c.mounts.some((m) => m.source === "/srv/uploads" && m.dest === "/data/uploads")) && !(e.host["/srv/uploads"].mode & 0o002),
      check: (e) => {
        const c = byImage(e, "nimbus/uploader").find((x) => x.state === "running") || byImage(e, "nimbus/uploader")[0];
        const open = e.host["/srv/uploads"] && e.host["/srv/uploads"].mode & 0o002;
        const text = !c ? "no uploader container" : c.state !== "running" ? statusOf(e, c) : e.userOf(c).uid === 0 ? "running as root" : open ? "folder writable by everyone" : `writing as uid ${e.userOf(c).uid}`;
        return { label: "uploader → /srv/uploads", text };
      },
      hints: [
        "docker logs uploader: EACCES on /data/uploads. Who does the app run as? docker run --rm nimbus/uploader:1.0 id",
        "The app is uid 10001. ls -ln /srv shows uploads owned by uid 0 with mode drwxr-xr-x: only root may write. A bind mount keeps the host's owner and mode, and the host has no user called app.",
        "Give the folder to the app's uid, then start the container again: sudo chown -R 10001:10001 /srv/uploads && docker start uploader"
      ],
      lesson: "Bind mounts keep host ownership, matched by number, not by name. Match the folder's owner to the container's UID instead of running as root or opening the folder to everyone.",
      tries: ["docker logs uploader", "ls -ln /srv", "docker run --rm nimbus/uploader:1.0 id"]
    },
    {
      id: "bigimage", title: "1.6 GB image", level: "05",
      story: "The shop image takes minutes to push and to start on new servers. docker images says it is 1.6 GB, for a 60-line web server.",
      goal: "Build nimbus/shop under 250 MB, with no .git or .env inside, and still working. Keep both files in your project.",
      done: "nimbus/shop is small, clean and still runs.",
      edit: [".dockerignore", "Dockerfile"],
      focus: "nimbus/shop",
      files: shopFiles(BIG_DOCKERFILE, null, true),
      setup: [`cd ${HOME}/shop`, "docker build -t nimbus/shop:1.0 .", 1440],
      won: (e) => {
        const img = newestShop(e);
        return Boolean(img && e.imageSize(img) < 250 * MB && !stat(img.fs, "/app/.git") && !stat(img.fs, "/app/.env") && e.trial(img).ok && e.host[`${HOME}/shop/.git`] && e.host[`${HOME}/shop/.env`]);
      },
      check: (e) => {
        const img = newestShop(e) || e.image("nimbus/shop:1.0");
        const size = e.imageSize(img);
        const problems = [stat(img.fs, "/app/.git") && ".git inside", stat(img.fs, "/app/.env") && ".env inside", !e.trial(img).ok && "does not start"].filter(Boolean);
        return { label: `${e.tagsOf(img)[0] || "nimbus/shop"} size`, text: [human(size), ...problems].join(" · ") };
      },
      hints: [
        "docker images, then docker history nimbus/shop:1.0. Which layers are big, and what did they copy?",
        "COPY . . sends everything in the folder: .git, your local node_modules, logs, even .env. The build output's \"transferring context\" says how much. node:22 alone is 1.12GB, and npm ci also installs test tools.",
        "In the editor: a .dockerignore with .git, node_modules, logs and .env; and a Dockerfile in two stages on node:22-alpine: FROM node:22-alpine AS deps, WORKDIR /app, COPY package*.json ./, RUN npm ci --omit=dev, then FROM node:22-alpine, WORKDIR /app, COPY --from=deps /app/node_modules ./node_modules, COPY . ., USER node, CMD [\"node\", \"server.js\"]. Then: docker build -t nimbus/shop:1.1 ."
      ],
      lesson: "Image size is the sum of every layer. Keep the build context clean with .dockerignore, start from a small base, and ship only what runs: production dependencies, copied from a build stage.",
      tries: ["docker images", "docker history nimbus/shop:1.0", "ls -la"]
    },
    {
      id: "cache", title: "Cache busted on every change", level: "04",
      story: "Every one-line change to server.js makes docker build reinstall all dependencies. The team waits on it dozens of times a day.",
      goal: "Change server.js and rebuild with the npm ci step still CACHED.",
      done: "Source changes no longer reinstall dependencies.",
      edit: ["Dockerfile", "server.js"],
      focus: "nimbus/shop",
      files: shopFiles(SLOW_DOCKERFILE, NODE_IGNORE, true),
      setup: [`cd ${HOME}/shop`, "docker build -t nimbus/shop:1.0 .", 90, "echo '// faster checkout' >> server.js"],
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
        "server.js already has an edit. Run docker build -t nimbus/shop:1.1 . and read the steps: which say CACHED, and which ran?",
        "A step's cache breaks when anything it copies changes, and every step after it runs again. COPY . . copies server.js, so any edit reruns npm ci.",
        "Copy only the dependency files, install, then copy the rest: in the Dockerfile put COPY package*.json ./ and RUN npm ci --omit=dev before COPY . . Build, change server.js (echo '// tweak' >> server.js), and build again."
      ],
      lesson: "Order a Dockerfile from what changes least to what changes most. Dependency files and their install step go before the source code, so only the last layers rebuild.",
      tries: ["docker build -t nimbus/shop:1.1 .", "cat Dockerfile", "docker history nimbus/shop:1.0"]
    },
    {
      id: "oom", title: "OOMKilled", level: "11",
      story: "The report service was given a memory limit during a cost review. It now dies a few seconds after every start, with nothing in the logs.",
      goal: "Get report running again, with a memory limit it can live with.",
      done: "report runs within its memory limit.",
      files: service(`${HOME}/report`, "report.js", "report", "node", 8080, ["csv-parse"]),
      setup: [`cd ${HOME}/report`, "docker build -t nimbus/report:2.0 .", `cd ${HOME}`, 600, "docker run -d --name report -p 8080:8080 --memory 128m nimbus/report:2.0", 4],
      won: (e) => byImage(e, "nimbus/report").some((c) => c.state === "running" && c.memory > 0 && !c.proc.hung) && web(e, 8080).ok,
      check: (e) => {
        const c = byImage(e, "nimbus/report").find((x) => x.state === "running") || byImage(e, "nimbus/report")[0];
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
  const siteFiles = project(`${HOME}/site`, { Dockerfile: file("FROM nginx:1.27\nCOPY index.html /usr/share/nginx/html/\n"), "index.html": file("<h1>Kitchen menu v1.0</h1>\n") });
  const siteBuilds = [`cd ${HOME}/site`, "docker build -t nimbus/site:1.0 .", (e) => e.writeFile(`${HOME}/site/index.html`, "<h1>Kitchen menu v1.1</h1>\n"), "docker build -t nimbus/site:1.1 .", `cd ${HOME}`];
  const serves = (e, port, text) => { const r = e.http(null, `localhost:${port}`); return r.code === 0 && r.text.includes(text); };
  const answer = (e, port) => { const r = e.http(null, `localhost:${port}`); return r.code === 0 ? r.text.split("\n").find((l) => /<h1>|: ok/.test(l)) || "answers" : r.text.replace(/^curl: \(\d+\) /, ""); };
  const named = (e, name) => e.containers.find((c) => c.name === name);
  const viaDns = (e, name) => { const c = named(e, name); return Boolean(c && c.state === "running" && c.proc.via === "dns"); };
  const linkText = (e, name) => { const c = named(e, name); return !c ? `no ${name} container` : c.state !== "running" ? statusOf(e, c) : c.proc.via === "dns" ? "by name, over DNS" : c.proc.via === "link" ? "through a legacy --link" : "by IP address"; };
  const forget = (dir) => (e) => { for (const p of Object.keys(e.host)) if (inside(p, dir)) delete e.host[p]; };
  const runningOf = (e, repo) => byImage(e, repo).filter((c) => c.state === "running");
  const ORDERS_COMPOSE = (dbHost, deps, healthcheck) => `services:
  api:
    build: .
    ports:
      - "8080:8080"
    environment:
      DB_HOST: ${dbHost}
      DB_PASSWORD: \${DB_PASSWORD}
    depends_on:
${deps}
  db:
    image: postgres:17
    environment:
      POSTGRES_PASSWORD: \${DB_PASSWORD}
    volumes:
      - db-data:/var/lib/postgresql/data
${healthcheck ? `    healthcheck:
      test: ["CMD", "pg_isready", "-U", "postgres"]
      interval: 5s
      retries: 10
` : ""}volumes:
  db-data:
`;
  const HEALTHY_DEP = "      db:\n        condition: service_healthy";
  const ordersFiles = (composeText, withEnv) => ({
    ...service(`${HOME}/orders`, "orders.js", "orders", "node", 8080, ["pg"]),
    [`${HOME}/orders/compose.yaml`]: file(composeText),
    ...(withEnv ? { [`${HOME}/orders/.env`]: file("DB_PASSWORD=kitchen-practice\n") } : {})
  });
  const HEALTH_DOCKERFILE = 'FROM node:22-alpine\nWORKDIR /app\nCOPY package*.json ./\nRUN npm ci --omit=dev\nCOPY . .\nEXPOSE 3000\nHEALTHCHECK --interval=30s --timeout=3s CMD curl -f http://localhost:3000/ || exit 1\nCMD ["node", "server.js"]\n';
  const PAY_DOCKERFILE = 'FROM node:22-alpine\nWORKDIR /app\nCOPY package*.json .npmrc ./\nRUN npm ci --omit=dev && rm -f .npmrc\nCOPY server.js ./\nUSER node\nCMD ["node", "server.js"]\n';
  const payFiles = project(`${HOME}/payments`, {
    Dockerfile: file(PAY_DOCKERFILE), ".dockerignore": file("node_modules\n.git\n"),
    "package.json": file('{\n  "name": "payments",\n  "private": true,\n  "dependencies": { "@kitchen/payments": "^3.1.0", "express": "^4.21.1" }\n}\n', { private: true, deps: { all: 40 * MB, prod: 31 * MB, count: [120, 88] } }),
    "package-lock.json": blob(41 * kB), "server.js": file('const pay = require("@kitchen/payments");\nrequire("express")().use(pay.routes()).listen(3000);\n', { app: "payments" }),
    ".npmrc": file("@kitchen:registry=https://npm.pkg.github.com\n//npm.pkg.github.com/:_authToken=practice-token-not-real\n", { mode: 0o600 })
  });
  const leaks = (e, img) => img.layers.some((l) => (l.files || []).some((p) => /\.npmrc$/.test(p)) || l.by.includes("practice-token-not-real")) || img.config.Env.some((x) => x.includes("practice-token"));
  const newestOf = (e, repo) => Object.values(e.images).filter((i) => i.built && e.tagsOf(i).some((t) => t.startsWith(repo + ":"))).sort((a, b) => b.created - a.created)[0];
  const webFiles = project(`${HOME}/web`, {
    Dockerfile: file("FROM nginx:1.27\nCOPY dist/ /usr/share/nginx/html/\nEXPOSE 80\n"), ".dockerignore": file("node_modules\n.git\ndist\n"),
    "package.json": file('{\n  "name": "web",\n  "scripts": { "build": "vite build" }\n}\n'), src: dirBlob(240 * kB), dist: D(1000),
    "dist/index.html": file("<!doctype html>\n<h1>Kitchen web</h1>\n"), "dist/assets": dirBlob(380 * kB)
  });
  // Old images and build cache that fill the disk, for the disk-full scenario.
  function clutter(e) {
    for (let i = 0; i < 9; i++) {
      const id = hexOf(`dangling${i}`);
      e.images[id] = { id, created: e.now - (i + 2) * 86400e3, layers: [{ id: hexOf(`dl${i}`), size: 1.2 * GB, by: "COPY . . # buildkit", created: e.now }], fs: {}, users: { root: [0, 0] }, bins: new Set(), os: "debian", arch: "amd64", config: { Env: [], Cmd: null, Entrypoint: null, WorkingDir: "", User: "", ExposedPorts: [], Volumes: [], Healthcheck: null } };
    }
    for (let i = 0; i < 40; i++) e.cache.set(hexOf(`old-cache${i}`), { fs: {}, users: {}, groups: {}, bins: [], layer: { id: hexOf(`oc${i}`), size: 350 * MB } });
    e.volume("pgdata", false).fs["/PG_VERSION"] = { size: 2.1 * GB };
    e.writeFile(`${HOME}/shop/server.js`, SHOP_SERVER + "// new checkout page\n");
    e.capacity = e.diskUsed() + 1e6;
  }

  const MORE = [
    {
      id: "typo", title: "pull access denied", level: "01",
      story: "The deploy script ran docker run -d --name web -p 8080:80 ngnix:1.27 and stopped with an error. Nothing is serving the site.",
      goal: "Get nginx answering on localhost:8080.",
      done: "nginx answers on localhost:8080.",
      setup: ["docker run -d --name web -p 8080:80 ngnix:1.27", 2],
      won: (e) => serves(e, 8080, "Welcome to nginx"),
      check: (e) => ({ label: "curl localhost:8080", text: answer(e, 8080) }),
      hints: [
        "docker ps -a has no web container at all: it was never created. Run the deploy command again and read the first lines.",
        "pull access denied for ngnix, repository does not exist. Docker Hub answers a typo and a private repository the same way, so check the spelling before you log in.",
        "The image is nginx, not ngnix: docker run -d --name web -p 8080:80 nginx:1.27"
      ],
      lesson: "Unable to find image locally, then pull access denied, nearly always means a typo in the name or tag. Logging in only helps for private repositories.",
      tries: ["docker ps -a", "docker run -d --name web -p 8080:80 ngnix:1.27", "docker images"]
    },
    {
      id: "conflict", title: "Name already in use", level: "00",
      story: "Version 1.1 of the menu site was built. The deploy step tried to start it as web and failed; the stopped 1.0 container is still there.",
      goal: "Run nimbus/site:1.1 as the container named web, answering on localhost:8080.",
      done: "web runs version 1.1.",
      files: siteFiles,
      setup: [...siteBuilds, 60, "docker run -d --name web -p 8080:80 nimbus/site:1.0", 600, "docker stop web", 5, "docker run -d --name web -p 8080:80 nimbus/site:1.1", 1],
      won: (e) => { const c = named(e, "web"); return Boolean(c && c.state === "running" && c.image === "nimbus/site:1.1" && serves(e, 8080, "v1.1")); },
      check: (e) => ({ label: "curl localhost:8080", text: answer(e, 8080) }),
      hints: [
        "Run the deploy command again: docker run -d --name web -p 8080:80 nimbus/site:1.1. What does the error say?",
        "A stopped container keeps its name. docker ps -a shows web, Exited, still from nimbus/site:1.0. docker start web would bring back the old version.",
        "Remove the old one (or rename it to keep it), then run the new one: docker rm web && docker run -d --name web -p 8080:80 nimbus/site:1.1"
      ],
      lesson: "Stopped containers keep their names until removed. Deploy scripts remove (or rename) the old container before starting the new one, or use --rm.",
      tries: ["docker ps -a", "docker run -d --name web -p 8080:80 nimbus/site:1.1", "docker images nimbus/site"]
    },
    {
      id: "exit127", title: "Executable not found", level: "03",
      story: "A teammate rewrote the shop's Dockerfile. The new image builds, but docker run fails before the app prints anything.",
      goal: "Get the shop answering on localhost:3000.",
      done: "The shop answers on localhost:3000.",
      edit: ["Dockerfile"], editDir: `${HOME}/shop`,
      files: shopFiles(DEV_DOCKERFILE.replace('CMD ["node", "server.js"]', 'ENTRYPOINT ["nodejs", "server.js"]'), NODE_IGNORE, false),
      setup: [`cd ${HOME}/shop`, "docker build -t nimbus/shop:1.0 .", 20, "docker run -d --name shop -p 3000:3000 nimbus/shop:1.0", 1],
      won: (e) => runningOf(e, "nimbus/shop").length > 0 && serves(e, 3000, "shop: ok"),
      check: (e) => ({ label: "curl localhost:3000", text: answer(e, 3000) }),
      hints: [
        "docker ps -a: shop is Created, never started. docker start shop prints the same error. Read it to the end.",
        "exec: \"nodejs\": executable file not found in $PATH. The node image calls its program node, not nodejs: docker run --rm --entrypoint ls nimbus/shop:1.0 /usr/local/bin",
        "Fix ENTRYPOINT in the Dockerfile to [\"node\", \"server.js\"], rebuild and re-create: docker build -t nimbus/shop:1.1 . && docker rm shop && docker run -d --name shop -p 3000:3000 nimbus/shop:1.1"
      ],
      lesson: "Exit code 127 and executable file not found mean the command does not exist in the image. Check the binary's name and that the image really contains it.",
      tries: ["docker ps -a", "docker start shop", "cat Dockerfile"]
    },
    {
      id: "restartloop", title: "Restarting forever", level: "11",
      story: "The worker was started with --restart always so it would survive reboots. Now docker ps shows it Restarting every few seconds.",
      goal: "Get worker running and staying up.",
      done: "worker is running.",
      files: service(`${HOME}/worker`, "worker.js", "worker", "node", null, ["bullmq"]),
      setup: [`cd ${HOME}/worker`, "docker build -t nimbus/worker:1.0 .", `cd ${HOME}`, 30, "docker run -d --name worker --restart always nimbus/worker:1.0", 3],
      won: (e) => runningOf(e, "nimbus/worker").some((c) => c.env.some((x) => /^QUEUE_URL=\S+/.test(x))),
      check: (e) => { const c = byImage(e, "nimbus/worker")[0]; return { label: "worker", text: c ? statusOf(e, c) : "no worker container" }; },
      hints: [
        "docker ps shows Restarting (1). The restart policy hides the crash; docker logs worker shows what happens on each start.",
        "QUEUE_URL is not set. Restarting cannot fix missing configuration, and docker update cannot add environment variables.",
        "Re-create it with the variable: docker rm -f worker && docker run -d --name worker --restart always -e QUEUE_URL=redis://cache:6379 nimbus/worker:1.0"
      ],
      lesson: "A restart policy keeps a healthy service up; it does not fix a broken one. Restarting (1) means read the logs and fix the cause.",
      tries: ["docker ps", "docker logs worker", "docker inspect worker --format '{{.RestartCount}} {{.HostConfig.RestartPolicy.Name}}'"]
    },
    {
      id: "nologs", title: "No logs to read", level: "13",
      story: "To save disk, the worker on this server runs with --log-driver none. It exits at once, and nobody can see why.",
      goal: "Get worker running, with logs you can read.",
      done: "worker runs, and its logs are readable.",
      files: service(`${HOME}/worker`, "worker.js", "worker", "node", null, ["bullmq"]),
      setup: [`cd ${HOME}/worker`, "docker build -t nimbus/worker:1.0 .", `cd ${HOME}`, 30, "docker run -d --name worker --log-driver none nimbus/worker:1.0", 2],
      won: (e) => runningOf(e, "nimbus/worker").some((c) => c.log.type !== "none" && c.env.some((x) => /^QUEUE_URL=\S+/.test(x))),
      check: (e) => { const c = byImage(e, "nimbus/worker")[0]; return { label: "worker", text: c ? `${statusOf(e, c)} · logs: ${c.log.type}` : "no worker container" }; },
      hints: [
        "docker logs worker fails: the logging driver none keeps nothing. docker inspect worker --format '{{.HostConfig.LogConfig.Type}}' confirms it.",
        "Re-create it with the default json-file driver (or --log-driver local, which also rotates) and read what it says.",
        "The log says QUEUE_URL is not set: docker rm worker && docker run -d --name worker --log-driver local -e QUEUE_URL=redis://cache:6379 nimbus/worker:1.0"
      ],
      lesson: "Without logs you are guessing. Keep a readable driver (json-file or local) and limit its size, instead of turning logging off.",
      tries: ["docker ps -a", "docker logs worker", "docker inspect worker --format '{{.HostConfig.LogConfig.Type}}'"]
    },
    {
      id: "localhost", title: "localhost is the container", level: "07",
      story: "api and cache share the app-net network, but api says connection refused on 127.0.0.1:6379. The setting worked on a laptop where Redis ran locally.",
      goal: "Let api reach cache by its name.",
      done: "api reaches cache by name.",
      files: service(`${HOME}/api`, "api.js", "api", "node", 8080, ["ioredis"]),
      setup: ["docker pull redis:7.4", `cd ${HOME}/api`, "docker build -t nimbus/api:1.0 .", `cd ${HOME}`, 60, "docker network create app-net", "docker run -d --name cache --network app-net redis:7.4", "docker run -d --name api --network app-net -p 8080:8080 -e REDIS_HOST=localhost nimbus/api:1.0", 2],
      won: (e) => viaDns(e, "api"),
      check: (e) => ({ label: "api → cache:6379", text: linkText(e, "api") }),
      hints: [
        "docker logs api: ECONNREFUSED 127.0.0.1:6379. Which machine is 127.0.0.1 from inside a container?",
        "Each container has its own network namespace, so localhost is the api container itself, where nothing listens on 6379. cache is reachable by its name on app-net.",
        "Re-create api pointing at the name: docker rm api && docker run -d --name api --network app-net -p 8080:8080 -e REDIS_HOST=cache nimbus/api:1.0"
      ],
      lesson: "Inside a container, localhost means that container. Reach other containers by name on a shared user-defined network.",
      tries: ["docker logs api", "docker inspect api --format '{{.Config.Env}}'", "docker network inspect app-net"]
    },
    {
      id: "loopback", title: "Listening on 127.0.0.1", level: "06",
      story: "The shop is Up, its port is published, and its log says it is listening. Yet curl localhost:3000 gets its connection reset.",
      goal: "Make localhost:3000 reach the shop through its published port.",
      done: "The shop answers on localhost:3000.",
      files: shopFiles(DEV_DOCKERFILE, NODE_IGNORE, false),
      setup: [`cd ${HOME}/shop`, "docker build -t nimbus/shop:1.0 .", `cd ${HOME}`, 30, "docker run -d --name shop -p 3000:3000 -e HOST=127.0.0.1 nimbus/shop:1.0", 5],
      won: (e) => serves(e, 3000, "shop: ok") && runningOf(e, "nimbus/shop").some((c) => c.netMode !== "host"),
      check: (e) => ({ label: "curl localhost:3000", text: answer(e, 3000) }),
      hints: [
        "curl localhost:3000 says Connection reset by peer, so Docker forwards the port but nothing answers behind it. docker logs shop: where does it listen?",
        "127.0.0.1 inside the container only accepts connections from inside the container (docker exec shop wget -qO- localhost:3000 works). Published ports arrive on the container's own network interface.",
        "Let the app listen on every interface: docker rm -f shop && docker run -d --name shop -p 3000:3000 -e HOST=0.0.0.0 nimbus/shop:1.0"
      ],
      lesson: "A server in a container must listen on 0.0.0.0. To keep a port private, publish it on the host's loopback instead: -p 127.0.0.1:3000:3000.",
      tries: ["curl localhost:3000", "docker logs shop", "docker exec shop wget -qO- localhost:3000"]
    },
    {
      id: "portinuse", title: "Port already allocated", level: "06",
      story: "Version 1.1 of the menu site should replace 1.0 on port 8080. The new container was created but would not start.",
      goal: "Run nimbus/site:1.1 as web on localhost:8080.",
      done: "web serves version 1.1 on 8080.",
      files: siteFiles,
      setup: [...siteBuilds, 60, "docker run -d --name web-old -p 8080:80 nimbus/site:1.0", 120, "docker run -d --name web -p 8080:80 nimbus/site:1.1", 1],
      won: (e) => { const c = named(e, "web"); return Boolean(c && c.state === "running" && c.image === "nimbus/site:1.1" && serves(e, 8080, "v1.1")); },
      check: (e) => ({ label: "curl localhost:8080", text: answer(e, 8080) }),
      hints: [
        "docker start web and read the error: Bind for 0.0.0.0:8080 failed: port is already allocated.",
        "docker ps --filter publish=8080, or just docker ps: web-old, running 1.0, still holds the port. Only one container can publish a host port.",
        "Stop the old one, then start the new one: docker stop web-old && docker start web"
      ],
      lesson: "A host port belongs to one container at a time. Stop or remove the old container before the new one takes its port.",
      tries: ["docker ps -a", "docker start web", "curl localhost:8080"]
    },
    {
      id: "isolated", title: "Different networks", level: "07",
      story: "The networks were split into front (public services) and back (data). Since then api cannot find cache.",
      goal: "Let api reach cache by name, keeping the front and back networks.",
      done: "api reaches cache by name.",
      files: service(`${HOME}/api`, "api.js", "api", "node", 8080, ["ioredis"]),
      setup: ["docker pull redis:7.4", `cd ${HOME}/api`, "docker build -t nimbus/api:1.0 .", `cd ${HOME}`, 60, "docker network create front", "docker network create back", "docker run -d --name cache --network back redis:7.4", "docker run -d --name api --network front -p 8080:8080 nimbus/api:1.0", 2],
      won: (e) => viaDns(e, "api") && Boolean(e.networks.front && e.networks.back),
      check: (e) => ({ label: "api → cache:6379", text: linkText(e, "api") }),
      hints: [
        "docker logs api: ENOTFOUND cache. Both networks are user-defined, so DNS works. On which network is each container?",
        "docker network inspect front and back: api is only on front, cache only on back. Names resolve only between containers that share a network.",
        "Attach api to the back network too, then start it: docker network connect back api && docker start api"
      ],
      lesson: "Containers find each other by name only on a network they share. A container can join several networks, which is how a service bridges a front and a back network.",
      tries: ["docker logs api", "docker network ls", "docker network inspect back"]
    },
    {
      id: "datalost", title: "Data gone after re-create", level: "08",
      story: "cache was re-created during an upgrade, and all 1,532 keys are gone. Nobody deleted any volume.",
      goal: "Re-create cache so its data lives in a named volume and survives the next re-create.",
      done: "cache keeps its data in a named volume.",
      setup: ["docker pull redis:7.4", "docker run -d --name cache redis:7.4", (e) => { e.volumes[e.container("cache").mounts[0].name].fs["/dump.rdb"] = { size: 18 * MB, keys: 1532 }; }, 4320, "docker rm -f cache", "docker run -d --name cache redis:7.4", 2],
      won: (e) => e.containers.some((c) => c.state === "running" && c.proc.app === "redis" && c.mounts.some((m) => m.dest === "/data" && (m.type === "bind" || (m.type === "volume" && !m.anon)))),
      check: (e) => {
        const c = e.containers.find((x) => x.proc.app === "redis") || e.containers[0];
        const m = c && c.mounts.find((x) => x.dest === "/data");
        return { label: "cache /data", text: !m ? "no mount" : m.type === "bind" ? `bind mount ${m.source}` : m.anon ? "anonymous volume, lost on re-create" : `named volume ${m.name}` };
      },
      hints: [
        "docker volume ls lists two volumes with long random names. docker inspect cache --format '{{json .Mounts}}' shows /data on one of them.",
        "The redis image declares VOLUME /data, so every new container gets a fresh anonymous volume. The old data is still in the other volume, but nothing points at it.",
        "Use a named volume that outlives containers: docker rm -f cache && docker run -d --name cache -v redis-data:/data redis:7.4 (or mount the old volume by its name to get the keys back)."
      ],
      lesson: "A VOLUME in an image only gives each container its own anonymous volume. Name the volume yourself so the next container finds the same data.",
      tries: ["docker volume ls", "docker exec cache redis-cli dbsize", "docker inspect cache --format '{{json .Mounts}}'"]
    },
    {
      id: "readonly", title: "Read-only file system", level: "15",
      story: "Security asked for a read-only root file system on every container. nginx now exits at once.",
      goal: "Run nginx with --read-only, answering on localhost:8080.",
      done: "nginx runs with a read-only root.",
      setup: ["docker pull nginx:1.27", "docker run -d --name web --read-only -p 8080:80 nginx:1.27", 2],
      won: (e) => e.containers.some((c) => c.state === "running" && c.readOnly && c.proc.app === "nginx") && serves(e, 8080, "Welcome to nginx"),
      check: (e) => ({ label: "curl localhost:8080", text: answer(e, 8080) }),
      hints: [
        "docker logs web: nginx cannot create /var/cache/nginx/client_temp. The root file system is read-only, as asked.",
        "nginx must write to two places: its cache (/var/cache/nginx) and its pid file (/var/run). Give exactly those a writable tmpfs.",
        "docker rm web && docker run -d --name web --read-only --tmpfs /var/cache/nginx --tmpfs /var/run -p 8080:80 nginx:1.27"
      ],
      lesson: "With --read-only, find what the app writes (the logs name it) and give only those paths a tmpfs or a volume.",
      tries: ["docker ps -a", "docker logs web", "docker inspect web --format '{{.HostConfig.ReadonlyRootfs}}'"]
    },
    {
      id: "capdrop", title: "Capabilities dropped", level: "15",
      story: "To harden it, web was started with --cap-drop ALL. nginx stopped working.",
      goal: "Run nginx with --cap-drop ALL, adding back only what it needs.",
      done: "nginx runs with the fewest capabilities.",
      setup: ["docker pull nginx:1.27", "docker run -d --name web --cap-drop ALL -p 8080:80 nginx:1.27", 2],
      won: (e) => serves(e, 8080, "Welcome to nginx") && e.containers.some((c) => c.state === "running" && c.proc.app === "nginx" && !c.privileged && c.capDrop.map(capName).includes("ALL") && c.capAdd.every((x) => ["CHOWN", "SETUID", "SETGID", "NET_BIND_SERVICE", "DAC_OVERRIDE"].includes(capName(x)))),
      check: (e) => ({ label: "curl localhost:8080", text: answer(e, 8080) }),
      hints: [
        "docker logs web: chown(...) failed (1: Operation not permitted). The nginx master runs as root, but root without capabilities cannot change file owners.",
        "nginx needs CHOWN for its cache folders, and SETUID and SETGID to start its workers as the nginx user. Port 80 needs nothing extra on current Docker.",
        "docker rm web && docker run -d --name web --cap-drop ALL --cap-add CHOWN --cap-add SETUID --cap-add SETGID -p 8080:80 nginx:1.27"
      ],
      lesson: "Drop every capability, then add back only the ones the logs ask for. --privileged is the opposite: every capability and every device.",
      tries: ["docker logs web", "docker inspect web --format '{{.HostConfig.CapDrop}} {{.HostConfig.CapAdd}}'", "curl localhost:8080"]
    },
    {
      id: "secretlayer", title: "Token in a layer", level: "15",
      story: "A scan found an npm token inside nimbus/payments:1.0, although the Dockerfile deletes .npmrc right after npm ci.",
      goal: "Build nimbus/payments with no token in any layer or in its history, and still working.",
      done: "The image builds and runs, and no layer holds the token.",
      edit: ["Dockerfile", ".dockerignore"], editDir: `${HOME}/payments`, focus: "nimbus/payments",
      files: payFiles,
      setup: [`cd ${HOME}/payments`, "docker build -t nimbus/payments:1.0 .", 300],
      won: (e) => { const img = newestOf(e, "nimbus/payments"); return Boolean(img && !leaks(e, img) && e.trial(img).ok); },
      check: (e) => { const img = newestOf(e, "nimbus/payments") || e.image("nimbus/payments:1.0"); return { label: `${e.tagsOf(img)[0]}`, text: leaks(e, img) ? "token found in a layer" : e.trial(img).ok ? "clean, and it runs" : "clean, but it does not start" }; },
      hints: [
        "docker history nimbus/payments:1.0: the COPY that includes .npmrc is its own layer. The rm in the next step hides the file but cannot change that layer.",
        "Build arguments are no better: docker history shows their values. BuildKit secrets mount a file for one RUN step only, and never store it.",
        "In the Dockerfile: COPY package*.json ./ then RUN --mount=type=secret,id=npmrc,target=/root/.npmrc npm ci --omit=dev. Then: docker build --secret id=npmrc,src=.npmrc -t nimbus/payments:1.1 ."
      ],
      lesson: "Anything copied, written or passed as ARG ends up in the image or its history. Use --mount=type=secret for credentials needed at build time.",
      tries: ["docker history nimbus/payments:1.0", "cat Dockerfile", "docker run --rm nimbus/payments:1.0 ls -a /app"]
    },
    {
      id: "copymissing", title: "COPY: not found", level: "03",
      story: "The front end was built into dist/ as usual, but docker build fails on the COPY of dist since someone tidied the .dockerignore.",
      goal: "Build nimbus/web with the site from dist/ in it.",
      done: "nimbus/web builds and serves the site.",
      edit: [".dockerignore", "Dockerfile"], editDir: `${HOME}/web`,
      files: webFiles,
      setup: [`cd ${HOME}/web`],
      won: (e) => { const img = newestOf(e, "nimbus/web"); const f = img && img.fs["/usr/share/nginx/html/index.html"]; return Boolean(f && /Kitchen web/.test(f.text || "")); },
      check: (e) => { const img = newestOf(e, "nimbus/web"); return { label: "nimbus/web", text: !img ? "not built" : (img.fs["/usr/share/nginx/html/index.html"] || {}).text ? "built with the site" : "built, but no index.html" }; },
      hints: [
        "Run docker build -t nimbus/web:1.0 . and read the error: \"/dist\": not found. Yet ls shows dist right there.",
        "The build only sees the context Docker sends, and .dockerignore decides what that is. cat .dockerignore: dist is excluded.",
        "Remove the dist line from .dockerignore (in the editor, or sed -i '/^dist$/d' .dockerignore), then docker build -t nimbus/web:1.0 ."
      ],
      lesson: "\"not found\" in COPY means the file is missing from the build context, not from your disk. Check .dockerignore and the folder you build from.",
      tries: ["docker build -t nimbus/web:1.0 .", "cat .dockerignore", "ls dist"]
    },
    {
      id: "platform", title: "exec format error", level: "14",
      story: "nimbus/shop:2.0 was built on a laptop with an Arm chip and copied to the amd64 server. It exits the moment it starts.",
      goal: "Get the shop answering on localhost:3000 on this server.",
      done: "An amd64 build runs on the server.",
      files: shopFiles(DEV_DOCKERFILE, NODE_IGNORE, false),
      setup: [`cd ${HOME}/shop`, "docker build --platform linux/arm64 -t nimbus/shop:2.0 .", 60, "docker run -d --name shop -p 3000:3000 nimbus/shop:2.0", 1],
      won: (e) => serves(e, 3000, "shop: ok"),
      check: (e) => ({ label: "curl localhost:3000", text: answer(e, 3000) }),
      hints: [
        "docker logs shop: exec format error. docker run also printed a warning about the platform.",
        "docker image inspect nimbus/shop:2.0 --format '{{.Architecture}}' says arm64; this server is amd64. Asking docker run for --platform linux/amd64 cannot convert it.",
        "Build for the server's platform, then re-create: docker build --platform linux/amd64 -t nimbus/shop:2.0 . && docker rm shop && docker run -d --name shop -p 3000:3000 nimbus/shop:2.0"
      ],
      lesson: "Images are built for one CPU architecture unless you build for several. Build with --platform for where it runs, or publish a multi-platform image with buildx.",
      tries: ["docker logs shop", "docker image inspect nimbus/shop:2.0 --format '{{.Architecture}}'", "docker info"]
    },
    {
      id: "auth", title: "Private registry", level: "14",
      story: "The new server must run ghcr.io/kitchen/shop:2.1 from the team's private registry. The pull fails. A read-only token is in $GHCR_TOKEN.",
      goal: "Run ghcr.io/kitchen/shop:2.1 on localhost:3000.",
      done: "The private image runs.",
      files: shopFiles(DEV_DOCKERFILE, NODE_IGNORE, false),
      setup: [`cd ${HOME}/shop`, "docker build -t ghcr.io/kitchen/shop:2.1 .", (e) => e.publish("ghcr.io/kitchen/shop:2.1", true), forget(`${HOME}/shop`), (e) => { e.env.GHCR_TOKEN = "practice-token-not-real"; }, `cd ${HOME}`, 10, "docker run -d --name shop -p 3000:3000 ghcr.io/kitchen/shop:2.1", 1],
      won: (e) => serves(e, 3000, "shop: ok") && runningOf(e, "ghcr.io/kitchen/shop").length > 0,
      check: (e) => ({ label: "curl localhost:3000", text: answer(e, 3000) }),
      hints: [
        "docker pull ghcr.io/kitchen/shop:2.1 and read the error: unauthorized. The registry wants to know who you are.",
        "docker login with no server logs in to Docker Hub, not ghcr.io. Name the registry, and pipe the token in so it never appears in your shell history or in ps.",
        "echo $GHCR_TOKEN | docker login ghcr.io -u kitchen-ci --password-stdin && docker run -d --name shop -p 3000:3000 ghcr.io/kitchen/shop:2.1"
      ],
      lesson: "Credentials are per registry. Log in to the registry the image names, with --password-stdin, using a token limited to pulling.",
      tries: ["docker pull ghcr.io/kitchen/shop:2.1", "echo $GHCR_TOKEN | wc -l", "docker images"]
    },
    {
      id: "ratelimit", title: "toomanyrequests", level: "14",
      story: "Every CI job on this shared runner pulls nginx anonymously from Docker Hub. Today the pull fails. The team's Docker Hub token is in $DOCKERHUB_TOKEN.",
      goal: "Get nginx:1.27 running on localhost:8080.",
      done: "nginx was pulled as an authenticated user and runs.",
      hubLimit: true,
      setup: [(e) => { e.env.DOCKERHUB_TOKEN = "practice-token-not-real"; }, "docker run -d --name web -p 8080:80 nginx:1.27", 1],
      won: (e) => serves(e, 8080, "Welcome to nginx"),
      check: (e) => ({ label: "curl localhost:8080", text: answer(e, 8080) }),
      hints: [
        "docker pull nginx:1.27: toomanyrequests. Retrying from the same address hits the same limit.",
        "Docker Hub limits anonymous pulls per IP address; a shared runner uses them up fast. Pulls by a logged-in account have their own, higher allowance.",
        "echo $DOCKERHUB_TOKEN | docker login -u kitchenci --password-stdin && docker run -d --name web -p 8080:80 nginx:1.27"
      ],
      lesson: "toomanyrequests is Docker Hub's rate limit. Authenticate your pulls, cache images in your own registry or mirror, and pull only when the image changes.",
      tries: ["docker pull nginx:1.27", "docker images", "env"]
    },
    {
      id: "stale", title: "Old image, new tag", level: "01",
      story: "The team pushed kitchen/shop:latest with version 2.4 an hour ago. You re-created the shop container, and it still says 2.3.",
      goal: "Run version 2.4 of kitchen/shop on localhost:3000.",
      done: "The shop runs version 2.4.",
      files: shopFiles(DEV_DOCKERFILE.replace("EXPOSE 3000", "ENV APP_VERSION=2.4\nEXPOSE 3000"), NODE_IGNORE, false),
      setup: [`cd ${HOME}/shop`, "docker build -t kitchen/shop:latest .", (e) => e.publish("kitchen/shop:latest", false), "sed -i 's/APP_VERSION=2.4/APP_VERSION=2.3/' Dockerfile",
        "docker build -t kitchen/shop:latest .", forget(`${HOME}/shop`), `cd ${HOME}`, 60, "docker run -d --name shop -p 3000:3000 kitchen/shop:latest", 1],
      won: (e) => serves(e, 3000, "version 2.4"),
      check: (e) => ({ label: "curl localhost:3000", text: answer(e, 3000) }),
      hints: [
        "curl localhost:3000 says version 2.3. docker images kitchen/shop shows when your local latest was made.",
        "docker run uses the local image when one has that tag; it never checks the registry for a newer latest. Re-creating the container reuses the same old image.",
        "Pull, then re-create: docker pull kitchen/shop:latest && docker rm -f shop && docker run -d --name shop -p 3000:3000 kitchen/shop:latest (or docker run --pull always)."
      ],
      lesson: "A tag is a pointer that moves, and your machine keeps the old target until you pull. Deploy by version tag or digest, and pull explicitly.",
      tries: ["curl localhost:3000", "docker images kitchen/shop", "docker pull kitchen/shop:latest"]
    },
    {
      id: "logs", title: "Logs fill the disk", level: "13",
      story: "The server's disk is almost full. The chatty service logs every request, and has been running for three days.",
      goal: "Re-create chatty with log rotation, so its logs can never fill the disk again.",
      done: "chatty's logs rotate.",
      files: service(`${HOME}/chatty`, "chatty.js", "chatty", "node", 8080, ["express"]),
      setup: [`cd ${HOME}/chatty`, "docker build -t nimbus/chatty:1.0 .", `cd ${HOME}`, 30, "docker run -d --name chatty -p 8080:8080 nimbus/chatty:1.0", (e) => { e.container("chatty").logBytes = 14.2 * GB; e.capacity = 24 * 1024 * MiB; }, 4320],
      won: (e) => runningOf(e, "nimbus/chatty").some((c) => c.log.type === "local" || (c.log.type === "json-file" && c.log.opts["max-size"])) && e.diskUsed() < 0.8 * e.capacity,
      check: (e) => { const c = byImage(e, "nimbus/chatty")[0]; return { label: "disk", text: `${Math.round(e.diskUsed() / e.capacity * 100)}% used${c ? ` · chatty log ${human(c.logBytes)}${c.log.opts["max-size"] || c.log.type === "local" ? ", rotated" : ""}` : ""}` }; },
      hints: [
        "df -h shows the disk almost full, but docker system df shows little in images and volumes. Container logs are not counted there.",
        "docker inspect chatty --format '{{.LogPath}}', then sudo du -sh on that path: the json-file log has no size limit by default. Truncating it frees the space only until it grows back.",
        "Re-create chatty with rotation (removing the old container deletes its log): docker rm -f chatty && docker run -d --name chatty -p 8080:8080 --log-opt max-size=10m --log-opt max-file=3 nimbus/chatty:1.0"
      ],
      lesson: "The default json-file log grows forever. Set max-size and max-file per container, or the local driver, or make them the default in /etc/docker/daemon.json.",
      tries: ["df -h", "docker system df", "docker inspect chatty --format '{{.LogPath}}'"]
    },
    {
      id: "diskfull", title: "No space left on device", level: "16",
      story: "The build server cannot build the shop any more: the disk is full. The pgdata volume holds the reporting database, which is stopped for maintenance.",
      goal: "Free space and build nimbus/shop:1.1, without losing the pgdata volume.",
      done: "The build works, and pgdata is safe.",
      files: shopFiles('FROM node:22-alpine\nWORKDIR /app\nCOPY package*.json ./\nRUN npm ci --omit=dev\nCOPY . .\nEXPOSE 3000\nCMD ["node", "server.js"]\n', NODE_IGNORE, true),
      setup: [`cd ${HOME}/shop`, "docker build -t nimbus/shop:1.0 .", 1440, clutter],
      won: (e) => Boolean(e.image("nimbus/shop:1.1") && e.image("nimbus/shop:1.1").built && e.volumes.pgdata),
      check: (e) => ({ label: "disk", text: `${Math.min(100, Math.round(e.diskUsed() / e.capacity * 100))}% used${e.volumes.pgdata ? "" : " · pgdata deleted"}` }),
      hints: [
        "docker build -t nimbus/shop:1.1 . fails with no space left on device. df -h agrees. Where is the space going? docker system df",
        "Most of it is reclaimable: dangling images from old builds and the build cache. The volume is not in use right now, which is exactly why a volume prune would delete it.",
        "Remove what can be rebuilt, not what cannot: docker builder prune -f && docker image prune -f, then docker build -t nimbus/shop:1.1 ."
      ],
      lesson: "Measure with docker system df, then prune the build cache and dangling images. Volumes hold data that cannot be rebuilt: never prune them blindly.",
      tries: ["docker build -t nimbus/shop:1.1 .", "df -h", "docker system df"]
    },
    {
      id: "healthcheck", title: "Unhealthy", level: "11",
      story: "The shop answers every request, but docker ps says (unhealthy), and the load balancer took it out of rotation.",
      goal: "Make the shop report healthy, with a check that really tests the app.",
      done: "The shop is healthy.",
      edit: ["Dockerfile"], editDir: `${HOME}/shop`,
      files: shopFiles(HEALTH_DOCKERFILE, NODE_IGNORE, false),
      setup: [`cd ${HOME}/shop`, "docker build -t nimbus/shop:1.0 .", 20, "docker run -d --name shop -p 3000:3000 nimbus/shop:1.0", 10],
      won: (e) => runningOf(e, "nimbus/shop").some((c) => { const hc = e.health(c); const test = (c.health || e.images[c.imageId].config.Healthcheck || []).join(" "); return hc && hc.status === "healthy" && /localhost:3000|127\.0\.0\.1:3000/.test(test); }),
      check: (e) => { const c = runningOf(e, "nimbus/shop")[0]; const hc = c && e.health(c); return { label: "shop health", text: !c ? "not running" : !hc ? "no healthcheck" : hc.status }; },
      hints: [
        "docker inspect shop --format '{{json .State.Health}}' shows the check's own output.",
        "/bin/sh: curl: not found. The image is based on alpine, which has wget but no curl, so the check fails while the app is fine.",
        "Use wget in the Dockerfile's HEALTHCHECK: CMD wget -qO- http://localhost:3000/ || exit 1. Then docker build -t nimbus/shop:1.1 . && docker rm -f shop && docker run -d --name shop -p 3000:3000 nimbus/shop:1.1"
      ],
      lesson: "A healthcheck runs inside the container, with that image's tools. Test it with docker exec first, and check the app itself, not a command that always succeeds.",
      tries: ["docker ps", "docker inspect shop --format '{{json .State.Health}}'", "docker exec shop wget -qO- http://localhost:3000/"]
    },
    {
      id: "composedns", title: "Compose: wrong host", level: "10",
      story: "The orders stack runs with docker compose. The api service keeps exiting with connection refused on 127.0.0.1:5432.",
      goal: "Let api reach the db service by its name.",
      done: "api reaches db by name.",
      edit: ["compose.yaml"], editDir: `${HOME}/orders`,
      files: ordersFiles(ORDERS_COMPOSE("localhost", HEALTHY_DEP, true), true),
      setup: [`cd ${HOME}/orders`, "docker compose up -d", 2],
      won: (e) => viaDns(e, "orders-api-1"),
      check: (e) => ({ label: "api → db:5432", text: linkText(e, "orders-api-1") }),
      hints: [
        "docker compose ps -a, then docker compose logs api: ECONNREFUSED 127.0.0.1:5432.",
        "Compose puts both services on the orders_default network, where each service name is a hostname. DB_HOST: localhost points api at itself.",
        "In compose.yaml set DB_HOST: db, then docker compose up -d (Compose re-creates only what changed)."
      ],
      lesson: "In Compose, services reach each other by service name. localhost is always the container itself.",
      tries: ["docker compose ps -a", "docker compose logs api", "cat compose.yaml"]
    },
    {
      id: "composeorder", title: "Compose: started too early", level: "11",
      story: "After every reboot the api service of the orders stack exits: the database is not ready yet. Someone restarts it by hand each time.",
      goal: "Make docker compose up start api only once db is ready.",
      done: "api waits for a healthy db.",
      edit: ["compose.yaml"], editDir: `${HOME}/orders`,
      files: ordersFiles(ORDERS_COMPOSE("db", "      - db", false), true),
      setup: [`cd ${HOME}/orders`, "docker compose up -d", 2],
      won: (e) => { const c = named(e, "orders-api-1"); return Boolean(c && c.state === "running" && c.compose.waited); },
      check: (e) => { const c = named(e, "orders-api-1"); return { label: "api", text: !c ? "not created" : c.state !== "running" ? statusOf(e, c) : c.compose.waited ? "started after db was healthy" : "running, but only by luck of timing" }; },
      hints: [
        "docker compose logs api: ECONNREFUSED on db's address. docker compose restart api works now, but only because db has finished starting in the meantime.",
        "depends_on alone waits for db's container to start, not for PostgreSQL to accept connections. Compose can wait for healthy, if db has a healthcheck.",
        "In compose.yaml give db a healthcheck (test: [\"CMD\", \"pg_isready\", \"-U\", \"postgres\"]) and change api's depends_on to db: condition: service_healthy. Then docker compose up -d"
      ],
      lesson: "depends_on orders container starts. Add a healthcheck and condition: service_healthy to wait for readiness, and still let apps retry their connections.",
      tries: ["docker compose ps -a", "docker compose logs api", "cat compose.yaml"]
    },
    {
      id: "composeenv", title: "Compose: variable not set", level: "10",
      story: "A fresh checkout of the orders stack on a new machine. docker compose up prints a warning and the db service exits.",
      goal: "Get the whole stack running, without writing the password into compose.yaml.",
      done: "db and api are running.",
      edit: ["compose.yaml"], editDir: `${HOME}/orders`,
      files: ordersFiles(ORDERS_COMPOSE("db", HEALTHY_DEP, true), false),
      setup: [`cd ${HOME}/orders`, "docker compose up -d", 2],
      won: (e) => { const api = named(e, "orders-api-1"); const db = named(e, "orders-db-1"); const f = e.host[`${HOME}/orders/compose.yaml`]; return Boolean(api && db && api.state === "running" && db.state === "running" && f && /POSTGRES_PASSWORD:\s*\$\{/.test(f.text || "")); },
      check: (e) => { const db = named(e, "orders-db-1"); return { label: "db", text: db ? statusOf(e, db) : "not created" }; },
      hints: [
        "Read the first line of docker compose up -d: the DB_PASSWORD variable is not set. docker compose logs db says why that matters.",
        "Compose fills ${DB_PASSWORD} from your shell or from a .env file next to compose.yaml. The checkout has no .env, which is right: it must not be committed.",
        "Create it (and keep it out of git): echo 'DB_PASSWORD=pick-a-long-one' > .env && docker compose up -d"
      ],
      lesson: "Compose reads variables from the shell and from .env. Keep secrets out of compose.yaml and out of git, and supply them on each machine.",
      tries: ["docker compose up -d", "docker compose logs db", "ls -a"]
    }
  ];
  const exposed = (e) => e.containers.filter((c) => c.state === "running" && c.ports.some((p) => p.hostIp !== "127.0.0.1"));
  const NOEXEC_DOCKERFILE = 'FROM node:22-alpine\nWORKDIR /app\nCOPY package*.json ./\nRUN npm ci --omit=dev\nCOPY . .\nEXPOSE 3000\nENTRYPOINT ["/app/start.sh"]\n';
  const BAD_DAEMON_JSON = '{\n  "log-driver": "json-file",\n  "log-opts": { "max-size": "10m", "max-file": "3" },\n}\n';
  MORE.push(
    {
      id: "daemon", title: "Cannot connect to the daemon", level: "16",
      story: "Someone added log rotation to /etc/docker/daemon.json and restarted Docker. Since then every docker command fails, and the web site is down.",
      goal: "Get Docker running again with the log rotation kept, and the site back on localhost:8080.",
      done: "Docker runs with log rotation, and the site is back.",
      edit: ["daemon.json"], editDir: "/etc/docker",
      files: { "/etc/docker/daemon.json": file(BAD_DAEMON_JSON, { uid: 0, gid: 0 }) },
      setup: ["docker pull nginx:1.27", "docker run -d --name web --restart unless-stopped -p 8080:80 nginx:1.27", 600, (e) => { daemonStop(e); daemonStart(e); }, 5],
      won: (e) => e.daemon.up && Boolean((e.daemon.conf["log-opts"] || {})["max-size"]) && serves(e, 8080, "Welcome to nginx"),
      check: (e) => ({ label: "docker.service", text: e.daemon.up ? `running${(e.daemon.conf["log-opts"] || {})["max-size"] ? ", logs rotate" : ", no log rotation"}` : "failed" }),
      hints: [
        "docker ps: Cannot connect to the Docker daemon. Is it running? systemctl status docker",
        "It failed to start. sudo journalctl -u docker says why: dockerd could not read /etc/docker/daemon.json. JSON allows no comma after the last entry.",
        "Remove the trailing comma (in the editor, or sudo sed -i 's/},$/}/' /etc/docker/daemon.json), then sudo systemctl start docker. web comes back by itself: its restart policy is unless-stopped."
      ],
      lesson: "When docker cannot reach the daemon, ask systemd why: systemctl status docker and journalctl -u docker. Validate daemon.json before restarting (python3 -m json.tool or jq).",
      tries: ["docker ps", "systemctl status docker", "sudo journalctl -u docker"]
    },
    {
      id: "socket", title: "Permission denied on the socket", level: "00",
      story: "A new laptop. Docker is installed and running, but docker ps says permission denied unless you put sudo in front.",
      goal: "Run docker commands without sudo, without opening the socket to every user.",
      done: "docker works for you without sudo.",
      setup: [(e) => { e.groups = ["dev", "sudo"]; }],
      won: (e) => e.groups.includes("docker") && !(e.host["/var/run/docker.sock"].mode & 0o006),
      check: (e) => ({ label: "docker without sudo", text: e.host["/var/run/docker.sock"].mode & 0o006 ? "socket open to every user" : e.groups.includes("docker") ? "allowed, through the docker group" : e.pendingGroups.includes("docker") ? "added to docker, not active in this shell yet" : "permission denied" }),
      hints: [
        "docker ps: permission denied on /var/run/docker.sock. ls -l /var/run/docker.sock shows who may use it.",
        "The socket belongs to root and the docker group, mode srw-rw----. id shows you are not in that group. chmod 666 would let every user on the machine control Docker, which is root.",
        "Join the group, then start a shell that has it: sudo usermod -aG docker dev && newgrp docker (or log out and back in)."
      ],
      lesson: "Access to the Docker socket is root on the host. Grant it through the docker group to the people who need it (or use rootless Docker), never with chmod 666.",
      tries: ["docker ps", "ls -l /var/run/docker.sock", "id"]
    },
    {
      id: "args", title: "Arguments replace CMD", level: "02",
      story: "To get more detail, ops added --verbose to the end of the shop's docker run command. Now the shop exits at once with code 9.",
      goal: "Run the shop with verbose logging, answering on localhost:3000.",
      done: "The shop runs with verbose logging.",
      files: shopFiles(DEV_DOCKERFILE, NODE_IGNORE, false),
      setup: [`cd ${HOME}/shop`, "docker build -t nimbus/shop:1.0 .", `cd ${HOME}`, 60, "docker run -d --name shop -p 3000:3000 nimbus/shop:1.0 --verbose", 1],
      won: (e) => serves(e, 3000, "shop: ok") && runningOf(e, "nimbus/shop").some((c) => c.proc.debug),
      check: (e) => { const c = byImage(e, "nimbus/shop")[0]; return { label: "shop", text: !c ? "no shop container" : c.state !== "running" ? statusOf(e, c) : c.proc.debug ? "running, verbose" : "running, not verbose" }; },
      hints: [
        "docker logs shop: node: bad option: --verbose. Who received that flag?",
        "Anything after the image name replaces CMD. The image's CMD was node server.js; now it is just --verbose, and the node image's entrypoint runs node --verbose.",
        "Pass the whole command, or use the app's setting instead: docker rm shop && docker run -d --name shop -p 3000:3000 nimbus/shop:1.0 node server.js --verbose (or -e LOG_LEVEL=debug)."
      ],
      lesson: "Arguments after the image replace CMD entirely; they are not appended. ENTRYPOINT stays, which is why images put the fixed part there and defaults in CMD.",
      tries: ["docker ps -a", "docker logs shop", "docker inspect nimbus/shop:1.0 --format '{{.Config.Entrypoint}} {{.Config.Cmd}}'"]
    },
    {
      id: "noexec", title: "Entrypoint permission denied", level: "03",
      story: "The shop now starts through a start.sh script, written on a laptop and committed as is. The container never starts.",
      goal: "Get the shop answering on localhost:3000, still starting through start.sh.",
      done: "start.sh runs and the shop answers.",
      edit: ["Dockerfile", "start.sh"], editDir: `${HOME}/shop`,
      files: { ...shopFiles(NOEXEC_DOCKERFILE, NODE_IGNORE, false), [`${HOME}/shop/start.sh`]: file('#!/bin/sh\nset -e\necho "shop: starting"\nexec node server.js "$@"\n', { mode: 0o644 }) },
      setup: [`cd ${HOME}/shop`, "docker build -t nimbus/shop:1.0 .", 10, "docker run -d --name shop -p 3000:3000 nimbus/shop:1.0", 1],
      won: (e) => serves(e, 3000, "shop: ok") && runningOf(e, "nimbus/shop").some((c) => (c.entrypoint || [])[0] === "/app/start.sh"),
      check: (e) => ({ label: "curl localhost:3000", text: answer(e, 3000) }),
      hints: [
        "docker start shop and read the end of the error: exec: \"/app/start.sh\": permission denied.",
        "ls -l start.sh: -rw-r--r--, no x bit. COPY keeps the file's mode, and nobody, not even root, can execute a file without one. --privileged or -u root does not change that.",
        "Make it executable and rebuild: chmod +x start.sh && docker build -t nimbus/shop:1.1 . && docker rm shop && docker run -d --name shop -p 3000:3000 nimbus/shop:1.1 (or COPY --chmod=755 in the Dockerfile)."
      ],
      lesson: "Scripts need the executable bit inside the image. Set it in git (git update-index --chmod=+x), with COPY --chmod, or with RUN chmod +x.",
      tries: ["docker start shop", "ls -l start.sh", "cat Dockerfile"]
    },
    {
      id: "exposed", title: "Database open to the internet", level: "15",
      story: "An external scan reached the production database on port 5432. The firewall (ufw) only allows SSH, so how did it get through?",
      goal: "Make the database unreachable from outside the host, keep its data, and keep api working.",
      done: "Only api can reach the database.",
      files: service(`${HOME}/orders`, "orders.js", "orders", "node", 8080, ["pg"]),
      setup: [`cd ${HOME}/orders`, "docker build -t nimbus/orders:1.0 .", `cd ${HOME}`, "docker network create app-net",
        "docker run -d --name db --network app-net -p 5432:5432 -e POSTGRES_PASSWORD=kitchen-practice -v pgdata:/var/lib/postgresql/data postgres:17", 2,
        "docker run -d --name api --network app-net -p 8080:8080 -e DB_HOST=db nimbus/orders:1.0", 600],
      won: (e) => { const db = e.containers.find((c) => c.state === "running" && c.proc.app === "postgres"); return Boolean(db && !exposed(e).includes(db) && db.mounts.some((m) => m.name === "pgdata") && viaDns(e, "api") && serves(e, 8080, "orders: ok")); },
      check: (e) => { const db = e.containers.find((c) => c.proc.app === "postgres" && c.state === "running"); return { label: "db from the internet", text: !db ? "db not running" : exposed(e).includes(db) ? `reachable on 0.0.0.0:${db.ports[0].host}` : "not reachable" }; },
      hints: [
        "docker ps: db publishes 0.0.0.0:5432->5432/tcp. sudo ufw status says 5432 is not allowed, yet the scan got in.",
        "Docker writes its own iptables rules for published ports (sudo iptables -L DOCKER -n), and they are checked before ufw's. A ufw rule cannot close a published port.",
        "api reaches db by name over app-net and needs no published port. Re-create db without -p, on the same volume: docker rm -f db && docker run -d --name db --network app-net -e POSTGRES_PASSWORD=kitchen-practice -v pgdata:/var/lib/postgresql/data postgres:17"
      ],
      lesson: "Publishing a port opens it on every interface, past ufw. Publish only what must be public; reach internal services over a network, or bind to 127.0.0.1.",
      tries: ["docker ps", "sudo ufw status", "sudo iptables -L DOCKER -n"]
    },
    {
      id: "hostgateway", title: "Reaching the host", level: "07",
      story: "Redis runs directly on this Linux server, not in a container. api uses REDIS_HOST=host.docker.internal, which worked on a Docker Desktop laptop, and exits here.",
      goal: "Let api reach Redis on the host, keeping api on its own network.",
      done: "api reaches Redis on the host.",
      files: service(`${HOME}/api`, "api.js", "api", "node", 8080, ["ioredis"]),
      setup: [(e) => { e.hostServices = { 6379: "redis" }; }, `cd ${HOME}/api`, "docker build -t nimbus/api:1.0 .", `cd ${HOME}`, 30, "docker run -d --name api -p 8080:8080 -e REDIS_HOST=host.docker.internal nimbus/api:1.0", 1],
      won: (e) => { const c = named(e, "api"); return Boolean(c && c.state === "running" && c.proc.via === "hosts" && c.netMode !== "host"); },
      check: (e) => { const c = named(e, "api"); return { label: "api → redis on the host", text: !c ? "no api container" : c.state !== "running" ? statusOf(e, c) : c.proc.via === "hosts" ? "through host.docker.internal" : c.proc.via === "host" ? "using the host's network" : "by IP address" }; },
      hints: [
        "docker logs api: ENOTFOUND host.docker.internal. ss -ltn shows Redis listening on 0.0.0.0:6379 on the host.",
        "Docker Desktop defines host.docker.internal for you; Docker Engine on Linux does not. localhost would be the container itself.",
        "Map the name to the host's gateway address: docker rm api && docker run -d --name api -p 8080:8080 --add-host=host.docker.internal:host-gateway -e REDIS_HOST=host.docker.internal nimbus/api:1.0"
      ],
      lesson: "On Linux, add --add-host=host.docker.internal:host-gateway (extra_hosts in Compose) to reach services on the host, and make sure they listen on an address the bridge can reach.",
      tries: ["docker logs api", "ss -ltn", "docker inspect api --format '{{.HostConfig.ExtraHosts}}'"]
    },
    {
      id: "sigterm", title: "docker stop takes 10 seconds", level: "11",
      story: "Every deploy, docker stop shop hangs for ten seconds, then the shop is killed. Customers in the middle of a checkout get errors.",
      goal: "Make docker stop shut the shop down cleanly and at once.",
      done: "The shop stops cleanly on SIGTERM.",
      edit: ["server.js", "Dockerfile"], editDir: `${HOME}/shop`,
      files: shopFiles(DEV_DOCKERFILE, NODE_IGNORE, false),
      setup: [`cd ${HOME}/shop`, "docker build -t nimbus/shop:1.0 .", 120, "docker run -d --name shop -p 3000:3000 nimbus/shop:1.0", 600],
      won: (e) => byImage(e, "nimbus/shop").some((c) => c.lastStop && c.lastStop.signal === "TERM" && (c.lastStop.code === 0 || c.lastStop.code === 143)),
      check: (e) => { const c = byImage(e, "nimbus/shop").find((x) => x.lastStop) || byImage(e, "nimbus/shop")[0]; return { label: "docker stop", text: !c || !c.lastStop ? "not stopped yet" : `Exited (${c.lastStop.code})${c.lastStop.waited ? ` after ${c.lastStop.waited}s` : " at once"}` }; },
      hints: [
        "Run docker stop shop, then docker ps -a: Exited (137). 137 means SIGKILL, so the app never stopped on its own.",
        "docker stop sends SIGTERM and waits 10 seconds. node runs as PID 1, and the kernel ignores signals that PID 1 has no handler for. A shorter -t only kills it sooner.",
        "Give it an init process that forwards the signal: docker rm -f shop && docker run -d --init --name shop -p 3000:3000 nimbus/shop:1.0, then docker stop shop. Or handle SIGTERM in server.js and rebuild."
      ],
      lesson: "PID 1 is special: it ignores signals it does not handle. Run with --init (or tini in the image), handle SIGTERM in the app, and use exec form so the app gets the signal.",
      tries: ["docker stop shop", "docker ps -a", "docker inspect shop --format '{{.HostConfig.Init}}'"]
    },
    {
      id: "pgupgrade", title: "Database files are incompatible", level: "14",
      story: "A routine update bumped the database image from postgres:16 to postgres:17. db now exits on every start.",
      goal: "Get db running again with all of its data.",
      done: "db runs on its existing data.",
      setup: ["docker pull postgres:16", "docker run -d --name db -e POSTGRES_PASSWORD=kitchen-practice -v pgdata:/var/lib/postgresql/data postgres:16", 43200, "docker rm -f db", "docker pull postgres:17",
        "docker run -d --name db -e POSTGRES_PASSWORD=kitchen-practice -v pgdata:/var/lib/postgresql/data postgres:17", 2],
      won: (e) => e.containers.some((c) => c.state === "running" && c.proc.app === "postgres" && c.mounts.some((m) => m.name === "pgdata")) && Boolean(e.volumes.pgdata && /^16/.test((e.volumes.pgdata.fs["/PG_VERSION"] || {}).text || "")),
      check: (e) => { const v = e.volumes.pgdata; const c = e.containers.find((x) => x.proc.app === "postgres" || /postgres/.test(x.image)); return { label: "db", text: `${c ? statusOf(e, c) : "no db container"} · ${v ? `data from PostgreSQL ${((v.fs["/PG_VERSION"] || {}).text || "?").trim()}` : "pgdata deleted"}` }; },
      hints: [
        "docker logs db: database files are incompatible with server. The data directory was made by version 16.",
        "A major PostgreSQL version cannot open another major's files; it needs pg_upgrade or a dump and restore. Deleting the volume would start an empty database.",
        "Go back to the version that owns the data, then plan the upgrade: docker rm db && docker run -d --name db -e POSTGRES_PASSWORD=kitchen-practice -v pgdata:/var/lib/postgresql/data postgres:16"
      ],
      lesson: "Pin database images to a major version. Upgrade majors deliberately (dump and restore, or pg_upgrade), with a backup, never through a moving tag.",
      tries: ["docker ps -a", "docker logs db", "docker volume ls"]
    }
  );
  const ORDERED_SHOP = 'FROM node:22-alpine\nWORKDIR /app\nCOPY package*.json ./\nRUN npm ci --omit=dev\nCOPY . .\nEXPOSE 3000\nCMD ["node", "server.js"]\n';
  const lastNpm = (e) => { const b = e.lastBuild; return b && b.steps.find((s) => /^RUN .*\bnpm (ci|install)\b/.test(s.text)); };
  const gate = (e, img) => vulnsOf(img).filter((v) => v[1] === "CRITICAL" || v[1] === "HIGH");
  MORE.push(
    {
      id: "cpu", title: "Throttled CPU", level: "12",
      story: "Since the cost review, the pricing service times out under load. Memory looks fine, and the logs show no errors.",
      goal: "Get pricing answering on localhost:8080 again, keeping a CPU limit.",
      done: "pricing answers, within a CPU limit it can live with.",
      files: service(`${HOME}/pricing`, "pricing.js", "pricing", "node", 8080, ["express"]),
      setup: [`cd ${HOME}/pricing`, "docker build -t nimbus/pricing:1.0 .", `cd ${HOME}`, 60, "docker run -d --name pricing -p 8080:8080 --cpus 0.1 --memory 512m nimbus/pricing:1.0", 30],
      won: (e) => serves(e, 8080, "pricing:") && runningOf(e, "nimbus/pricing").some((c) => c.cpus >= 0.8),
      check: (e) => { const c = runningOf(e, "nimbus/pricing")[0]; return { label: "curl localhost:8080", text: `${answer(e, 8080)}${c ? ` · limit ${c.cpus ? c.cpus + " CPU" : "none"}` : ""}` }; },
      hints: [
        "curl localhost:8080 times out, yet docker logs pricing is clean. Look at docker stats --no-stream: what is the CPU column stuck at?",
        "About 10% is the limit, not the load: --cpus 0.1 (docker inspect pricing --format '{{.HostConfig.NanoCpus}}' says 100000000). docker exec pricing cat /sys/fs/cgroup/cpu.stat shows nr_throttled climbing. More memory or --cpu-shares cannot lift a hard quota.",
        "Raise the quota in place, no restart needed: docker update --cpus 1 pricing"
      ],
      lesson: "A CPU limit does not crash anything; it makes the app slow. Watch CPU % pinned at the limit and nr_throttled, then size --cpus from measured use.",
      tries: ["curl localhost:8080", "docker stats --no-stream", "docker exec pricing cat /sys/fs/cgroup/cpu.stat"]
    },
    {
      id: "pids", title: "Out of processes", level: "12",
      story: "A bug in the image resizer starts a convert process per image and never reaps them. Overnight it used up every PID on the host, and the web container can no longer start its workers.",
      goal: "Contain the resizer with a PID limit, and get web answering on localhost:8080 again.",
      done: "The resizer is contained, and web is back.",
      files: service(`${HOME}/resizer`, "resizer.js", "resizer", "node", 8080, ["sharp"]),
      setup: ["docker pull nginx:1.27", `cd ${HOME}/resizer`, "docker build -t nimbus/resizer:1.0 .", `cd ${HOME}`, "docker run -d --name web -p 8080:80 nginx:1.27", "docker run -d --name resizer nimbus/resizer:1.0",
        (e) => { e.container("resizer").pids = e.pidsFree() + 11 - 20; e.container("resizer").logs.push("resizer: spawn failed: Error: spawn convert EAGAIN"); }, 480, "docker restart web", 2],
      won: (e) => serves(e, 8080, "Welcome to nginx") && runningOf(e, "nimbus/resizer").some((c) => c.pidsLimit > 0 && c.pidsLimit <= 4096 && c.pids <= c.pidsLimit),
      check: (e) => { const c = byImage(e, "nimbus/resizer")[0]; return { label: "host PIDs free", text: `${Math.max(0, e.pidsFree())}${c ? ` · resizer ${c.pids} (${c.pidsLimit ? "limit " + c.pidsLimit : "no limit"})` : ""}` }; },
      hints: [
        "curl localhost:8080 hangs. docker logs web: fork() failed (11: Resource temporarily unavailable). Then docker stats --no-stream and read the PIDS column.",
        "resizer holds about 32,000 processes; the kernel allows 32,768 in all. docker update --pids-limit lowers the cap but does not kill processes already running.",
        "Re-create the resizer with a cap, then restart web: docker rm -f resizer && docker run -d --name resizer --pids-limit 200 nimbus/resizer:1.0 && docker restart web"
      ],
      lesson: "One container can exhaust the host's process table. Give every container a --pids-limit, so a leak or a fork bomb stays inside it.",
      tries: ["curl localhost:8080", "docker logs web", "docker stats --no-stream"]
    },
    {
      id: "cicache", title: "CI rebuilds everything", level: "04",
      story: "On the CI runner the shop build takes minutes on every push: npm ci runs every time, though package.json rarely changes. Locally it is cached. The runner is already logged in to ghcr.io.",
      goal: "Make the next pipeline run reuse the npm ci layer from the run before.",
      done: "CI reuses the dependency layer.",
      ciRunner: true,
      files: shopFiles(ORDERED_SHOP, NODE_IGNORE, true),
      setup: [(e) => { e.logins.add("ghcr.io"); }, `cd ${HOME}/shop`],
      won: (e) => Boolean(e.lastBuild && e.lastBuild.user && lastNpm(e) && lastNpm(e).cached),
      check: (e) => ({ label: "npm ci on the last run", text: !e.lastBuild ? "not built yet" : lastNpm(e) && lastNpm(e).cached ? "CACHED" : "ran again" }),
      hints: [
        "Run docker build -t nimbus/shop:ci . twice. Even with nothing changed, every step runs again: each CI job starts on a fresh runner with an empty build cache.",
        "Keep the cache outside the runner, in the registry: --cache-to exports it and --cache-from imports it. The default docker driver cannot export a cache; a docker-container builder can.",
        "docker buildx create --name ci --driver docker-container --use, then docker buildx build --cache-from type=registry,ref=ghcr.io/kitchen/shop:buildcache --cache-to type=registry,ref=ghcr.io/kitchen/shop:buildcache,mode=max -t nimbus/shop:ci . Run it twice."
      ],
      lesson: "CI runners forget their build cache. Export it with --cache-to (registry, or type=gha on GitHub) and import it with --cache-from; mode=max keeps the intermediate layers too.",
      tries: ["docker build -t nimbus/shop:ci .", "docker buildx ls", "cat Dockerfile"]
    },
    {
      id: "cves", title: "Scan gate fails", level: "15",
      story: "The pipeline's scan gate (docker scout cves --exit-code --only-severity critical,high) blocks nimbus/shop: two critical and four high findings, all in packages the app never uses.",
      goal: "Build nimbus/shop with no CRITICAL or HIGH findings, still working.",
      done: "nimbus/shop passes the scan gate.",
      edit: ["Dockerfile"], editDir: `${HOME}/shop`, focus: "nimbus/shop",
      files: shopFiles(ORDERED_SHOP.replace("node:22-alpine", "node:22"), NODE_IGNORE, true),
      setup: [`cd ${HOME}/shop`, "docker build -t nimbus/shop:1.0 .", 120],
      won: (e) => { const img = newestShop(e); return Boolean(img && !gate(e, img).length && e.trial(img).ok); },
      check: (e) => { const img = newestShop(e) || e.image("nimbus/shop:1.0"); const g = gate(e, img); return { label: `${e.tagsOf(img)[0]} scan`, text: g.length ? `${g.filter((v) => v[1] === "CRITICAL").length} critical, ${g.filter((v) => v[1] === "HIGH").length} high` : "no critical or high" }; },
      hints: [
        "docker scout cves nimbus/shop:1.0, then docker scout quickview nimbus/shop:1.0: every finding comes from the base image, node:22.",
        "node:22 is a full Debian with compilers, git, curl and imagemagick. apt-get upgrade fixes some, but several have no fix yet. Filtering the scan only hides them.",
        "Change FROM to node:22-slim (or node:22-alpine) in the Dockerfile, then docker build -t nimbus/shop:1.1 . and scan it again."
      ],
      lesson: "Most vulnerabilities live in packages your app never uses. A smaller base removes them for good; rebuild regularly so fixes arrive, and gate CI on critical and high.",
      tries: ["docker scout cves nimbus/shop:1.0", "docker scout quickview nimbus/shop:1.0", "cat Dockerfile"]
    },
    {
      id: "dockersock", title: "Docker socket in a container", level: "15",
      story: "A security review flagged the status dashboard: it mounts /var/run/docker.sock. It only needs to list containers.",
      goal: "Keep the dashboard listing containers on localhost:8080, without giving it control of Docker.",
      done: "The dashboard reads through a proxy that allows only reads.",
      files: { ...service(`${HOME}/dashboard`, "dashboard.js", "dashboard", "root", 8080, ["express"]), ...service(`${HOME}/socket-proxy`, "proxy.js", "proxy", "root", 2375, ["express"]) },
      setup: ["docker pull alpine:3.20",
        (e) => { for (const d of ["dashboard"]) e.writeFile(`${HOME}/${d}/Dockerfile`, e.host[`${HOME}/${d}/Dockerfile`].text.replace("WORKDIR /app", "RUN apk add --no-cache docker-cli\nWORKDIR /app")); },
        `cd ${HOME}/dashboard`, "docker build -t nimbus/dashboard:1.0 .", `cd ${HOME}/socket-proxy`, "docker build -t nimbus/socket-proxy:1.0 .", `cd ${HOME}`, 60,
        "docker run -d --name dashboard -p 8080:8080 -v /var/run/docker.sock:/var/run/docker.sock nimbus/dashboard:1.0", 30],
      won: (e) => { const d = runningOf(e, "nimbus/dashboard").find((c) => c.proc.via === "proxy" && !c.mounts.some((m) => m.source === "/var/run/docker.sock")); return Boolean(d && serves(e, 8080, "containers running:") && e.containers.every((c) => c.proc.app !== "proxy" || ![...c.env].includes("POST=1"))); },
      check: (e) => { const d = runningOf(e, "nimbus/dashboard")[0]; return { label: "dashboard access to Docker", text: !d ? "not running" : d.mounts.some((m) => m.source === "/var/run/docker.sock") ? "full control (socket mounted)" : d.proc.via === "proxy" ? "read-only, through the proxy" : "none" }; },
      hints: [
        "See what the mount allows: docker exec dashboard docker run --rm -v /:/host alpine:3.20 cat /host/etc/shadow. Whoever controls the dashboard can start any container, and so owns the host.",
        "Mounting the socket :ro changes nothing: read-only applies to the file, not to the API calls sent through it. Put a gatekeeper in between: nimbus/socket-proxy allows reads when CONTAINERS=1 and blocks writes unless POST=1.",
        "docker network create dash && docker run -d --name socket-proxy --network dash -e CONTAINERS=1 -v /var/run/docker.sock:/var/run/docker.sock nimbus/socket-proxy:1.0 && docker rm -f dashboard && docker run -d --name dashboard --network dash -p 8080:8080 -e DOCKER_HOST=tcp://socket-proxy:2375 nimbus/dashboard:1.0"
      ],
      lesson: "Access to the Docker socket is root on the host, read-only mount or not. Give tools that only read a socket proxy that allows exactly the API calls they need.",
      tries: ["docker inspect dashboard --format '{{json .Mounts}}'", "docker exec dashboard docker ps", "curl localhost:8080"]
    },
    {
      id: "x509", title: "x509: unknown authority", level: "14",
      story: "Images moved to registry.kitchen.internal, which uses a certificate from the company's own CA. Pulls fail on this server. The CA certificate is in /home/dev/kitchen-ca.crt.",
      goal: "Run registry.kitchen.internal/shop:2.1 on localhost:3000, with TLS still verified.",
      done: "Docker trusts the company CA, and the shop runs.",
      files: { ...shopFiles(DEV_DOCKERFILE, NODE_IGNORE, false), [`${HOME}/kitchen-ca.crt`]: file("-----BEGIN CERTIFICATE-----\n(practice CA certificate for registry.kitchen.internal; not a real one)\n-----END CERTIFICATE-----\n") },
      setup: [`cd ${HOME}/shop`, "docker build -t registry.kitchen.internal/shop:2.1 .", (e) => e.publish("registry.kitchen.internal/shop:2.1", false, true), forget(`${HOME}/shop`), `cd ${HOME}`, 30,
        "docker run -d --name shop -p 3000:3000 registry.kitchen.internal/shop:2.1", 1],
      won: (e) => serves(e, 3000, "shop: ok") && !(e.daemon.conf["insecure-registries"] || []).length,
      check: (e) => ({ label: "registry.kitchen.internal", text: (e.daemon.conf["insecure-registries"] || []).length ? "TLS verification turned off" : e.trusts("registry.kitchen.internal") ? "CA trusted" : "certificate not trusted" }),
      hints: [
        "docker pull registry.kitchen.internal/shop:2.1: x509: certificate signed by unknown authority. The registry is fine; this machine does not know the CA that signed its certificate.",
        "insecure-registries in daemon.json would turn verification off for that registry, which is the opposite of the goal. Docker reads extra CAs per registry from /etc/docker/certs.d/<registry>/ca.crt.",
        "sudo mkdir -p /etc/docker/certs.d/registry.kitchen.internal && sudo cp kitchen-ca.crt /etc/docker/certs.d/registry.kitchen.internal/ca.crt && docker run -d --name shop2 -p 3000:3000 registry.kitchen.internal/shop:2.1"
      ],
      lesson: "x509: unknown authority means trust, not a broken registry. Add the CA (certs.d for Docker, or the system store and restart), and keep TLS verification on.",
      tries: ["docker pull registry.kitchen.internal/shop:2.1", "ls -la /etc/docker", "cat kitchen-ca.crt"]
    }
  );
  SCENARIOS.push(...MORE);
  // Easiest first: one container, then networks, storage, builds, registries, Compose, production, security.
  const GROUPS = [
    ["Basics", ["exits", "port", "typo", "conflict", "socket", "args"]],
    ["Networking", ["dns", "localhost", "isolated", "loopback", "portinuse", "hostgateway"]],
    ["Storage", ["volmask", "datalost", "perms"]],
    ["Images and builds", ["cache", "cicache", "bigimage", "copymissing", "exit127", "noexec", "platform"]],
    ["Registries and upgrades", ["stale", "auth", "x509", "ratelimit", "pgupgrade"]],
    ["Compose", ["composedns", "composeenv", "composeorder"]],
    ["Running in production", ["restartloop", "healthcheck", "sigterm", "oom", "cpu", "pids", "nologs", "logs", "diskfull", "daemon"]],
    ["Security", ["exposed", "dockersock", "cves", "readonly", "capdrop", "secretlayer"]]
  ];
  const ORDER = GROUPS.flatMap(([, ids]) => ids);
  SCENARIOS.sort((a, b) => ORDER.indexOf(a.id) - ORDER.indexOf(b.id));

  // Fill a cheat sheet command's <blanks> from what the open scenario has.
  function fillBlanks(e, cmd) {
    const trouble = e.containers.find((c) => c.state !== "running") || e.containers[0];
    const userNet = Object.values(e.networks).find((n) => n.user);
    const v = {
      name: trouble && trouble.name, image: trouble ? trouble.image : e.scenario.focus ? `${e.scenario.focus}:1.0` : null,
      network: userNet ? userNet.name : "app-net", volume: Object.keys(e.volumes).find((n) => !e.volumes[n].anon) || "app-data", tag: "nimbus/demo:1.0"
    };
    return cmd.replace(/<([a-z]+)>/g, (m, k) => (v[k] == null ? m : String(v[k])));
  }

  const HELP = [
    "The playground runs a modelled Docker engine. It understands:",
    "  docker run | create | start | stop | restart | kill | rm | ps [-a] | logs | inspect | exec | port | update | stats --no-stream",
    "  docker images | pull | tag | rmi | history | build [-t] [-f] [--no-cache] | system df | system prune | image prune | builder prune",
    "  docker volume ls|create|inspect|rm      docker network ls|create|inspect|rm|connect|disconnect",
    "  docker compose up|down|ps|logs|restart|exec|config      docker login|logout      docker rename",
    "  docker buildx create|use|ls|build [--cache-from] [--cache-to]      docker scout cves|quickview (practice findings)",
    "  on your machine: curl, ls, cat, cd, pwd, echo, printf, export, touch, mkdir, rm, du -sh, df -h, chown, chmod, id, sed -i, grep,",
    "  systemctl and journalctl (docker), usermod, newgrp, ufw, iptables -L, ss -ltn (and sudo)",
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
  const link = document.getElementById("pg-link");

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
        b.addEventListener("click", () => { load(s.id); history.replaceState(null, "", "#play/" + s.id); });
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
    const nets = Object.values(engine.networks).filter((n) => engine.containers.some((c) => c.nets[n.name] || c.netMode === n.name));
    for (const n of nets) {
      const box = el("div", "pg-net");
      const head = el("div", "pg-net-name", n.name);
      head.append(el("span", "pg-net-kind", n.user ? "user-defined · DNS by name" : n.name === "bridge" ? "default bridge · no DNS" : n.driver));
      box.append(head);
      engine.containers.filter((c) => c.nets[n.name] || c.netMode === n.name).forEach((c) => box.append(chip(c)));
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
    link.replaceChildren(window.DQUI.copyLink("play/" + scenario.id, "scenario"));
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
    document.dispatchEvent(new CustomEvent("dq:solved", { detail: scenario.id }));
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
    const lv = (window.TRACK && window.TRACK.levels.find((l) => l.id === scenario.level)) || null;
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
    scenarios: SCENARIOS.map((s) => ({ id: s.id, title: s.title, story: s.story, level: s.level })),
    load: (id) => { load(id); reveal(); },
    // From a #play/<id> link.
    open: (id) => { if (SCENARIOS.some((s) => s.id === id)) { if (id !== scenario.id) load(id); reveal(); } },
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
