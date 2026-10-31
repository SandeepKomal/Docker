// Checks the Dockerfile X-ray: every line of the repository's own Dockerfiles
// gets a note, risky lines warn, the review lists what is missing, and the
// annotated examples on the site match the files they come from.
// Run with: node tests/check_xray.js
"use strict";
const fs = require("fs");
const path = require("path");
const assert = require("assert");

const root = path.resolve(__dirname, "..");
require(path.join(root, "site/xray.js"));
global.window = {};
require(path.join(root, "site/data.js"));
const { explain } = globalThis.DQExplain;
const Q = window.TRACK;

const sample = `# syntax=docker/dockerfile:1
FROM node:latest
ARG NPM_TOKEN
RUN apt-get update
RUN apt-get install curl
WORKDIR app
COPY . .
RUN npm install
ENV DB_PASSWORD=hunter2
ADD https://example.com/tool.tgz /opt/
ADD config.json /etc/app/
VOLUME /data
EXPOSE 3000
#RUN echo old
CMD npm start
BOGUS line
`;
const r = explain(sample);
const at = (start) => r.lines.find((l) => l.line.startsWith(start));
const warned = (start, re) => assert.match(at(start).warns.join(" "), re, `${start}: ${re}`);
assert.match(at("# syntax").note, /parser directive/);
warned("FROM node:latest", /:latest moves/);
assert.match(at("FROM node:latest").note, /over 1 GB/);
warned("ARG NPM_TOKEN", /docker history/);
warned("RUN apt-get update", /stale package lists/);
warned("RUN apt-get install", /No -y/);
warned("RUN apt-get install", /no-install-recommends/);
warned("RUN apt-get install", /var\/lib\/apt\/lists/);
warned("WORKDIR app", /absolute path/);
warned("COPY . .", /reruns the install/);
assert.match(at("RUN npm install").note, /npm ci/);
warned("ENV DB_PASSWORD", /baked into the image/);
warned("ADD https", /no integrity check/);
warned("ADD config.json", /use COPY/);
warned("VOLUME", /anonymous volume/);
assert.match(at("EXPOSE").note, /does not publish/);
assert.match(at("#RUN").note, /commented-out instruction/);
warned("CMD npm start", /SIGTERM never reaches the app/);
assert.strictEqual(at("BOGUS").level, "unknown");
assert.match(at("BOGUS").note, /unknown instruction: BOGUS/);
for (const re of [/No USER/, /whole build context/, /pinned version/, /looks like a secret/, /Build tools and dev dependencies/, /No HEALTHCHECK/]) {
  assert.ok(r.review.some((n) => re.test(n)), `review: ${re}`);
}

const good = explain(`FROM node:22-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

FROM node:22-alpine
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --chown=node:node . .
USER node
HEALTHCHECK CMD wget -qO- localhost:3000/healthz || exit 1
CMD ["node", "server.js"]
`);
assert.deepStrictEqual(good.review, ["It copies the whole build context. Keep a .dockerignore beside the Dockerfile with at least .git, node_modules (or target, dist), .env and logs."]);
assert.ok(good.lines.every((l) => !l.warns.length), "a good Dockerfile has no warnings");
assert.match(good.lines.find((l) => l.line.startsWith("COPY --from")).note, /from the `deps` stage/);
assert.match(good.lines.find((l) => l.line.startsWith("CMD")).note, /Exec form/);

const cont = explain("FROM debian:12\nRUN apt-get update \\\n  && apt-get install -y --no-install-recommends curl \\\n  && rm -rf /var/lib/apt/lists/*\nUSER 10001\nCMD [\"curl\", \"--version\"]\n");
assert.strictEqual(cont.lines[2].level, "cont");
assert.deepStrictEqual(cont.lines[1].warns, [], "a well-formed apt install across lines has no warnings");
assert.match(explain("FROM nginx:1.27\nCMD [\"nginx\"]\n").lines[1].warns.join(" "), /daemon off/);
assert.match(explain("FROM centos:7\n").lines[0].warns.join(" "), /end of life/);
assert.match(explain("RUN echo hi\n").lines[0].warns.join(" "), /starts with FROM/);
assert.match(explain("x\n".repeat(500)).error, /up to 400 lines/);

// The annotated examples are the repository's own files, line for line.
for (const ex of Q.xray) {
  const text = fs.readFileSync(path.join(root, ex.path), "utf8").replace(/\n$/, "");
  assert.deepStrictEqual(ex.lines, text.split("\n"), `site example "${ex.name}" matches ${ex.path}`);
}

// Every Dockerfile in the repository: no crash, and every line explained.
let files = 0, total = 0;
const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
  d.name === ".git" || d.name === "node_modules" ? [] : d.isDirectory() ? walk(path.join(dir, d.name)) : /^Dockerfile/.test(d.name) ? [path.join(dir, d.name)] : []);
for (const f of walk(root)) {
  const res = explain(fs.readFileSync(f, "utf8"));
  files++;
  for (const l of res.lines) {
    if (l.level === "blank") continue;
    assert.ok(l.note && l.level !== "unknown", `${path.relative(root, f)}: no note for "${l.line}"`);
    total++;
  }
}
assert.ok(files >= 10, `found ${files} Dockerfiles`);
console.log(`xray ok: ${files} Dockerfiles, ${total} lines explained`);
