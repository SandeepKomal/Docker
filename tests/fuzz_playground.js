// Throws thousands of random and malformed commands and Dockerfiles at the
// simulator. Any exception fails the run; every result must be printable lines.
// Run with: node tests/fuzz_playground.js [rounds]
"use strict";
const path = require("path");
const assert = require("assert");

require(path.resolve(__dirname, "../site/playground.js"));
const { SCENARIOS, Engine, shell } = globalThis.DQSim;

let seed = 20261030;
const rand = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
const pick = (list) => list[rand(list.length)];

const WORDS = ["docker", "run", "create", "start", "stop", "restart", "kill", "rm", "ps", "logs", "inspect", "exec", "port", "update", "stats", "images", "pull", "tag", "rmi",
  "history", "build", "system", "df", "prune", "image", "container", "volume", "network", "builder", "ls", "create", "connect", "disconnect", "-d", "-a", "-f", "-q", "-it",
  "-p", "8080:80", "3000:3000", "80", "-v", "/home/dev/shop:/app", "/app/node_modules", "data:/data", "-e", "A=1", "--name", "web", "api", "cache", "shop", "report", "uploader",
  "--network", "app-net", "bridge", "host", "none", "--memory", "512m", "1g", "--memory-swap", "-1", "--rm", "--restart", "always", "-u", "0", "10001", "--format",
  "{{.State.Status}}", "{{json .Mounts}}", "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}", "{{.Nope}}", "{{", "nginx:1.27", "nginx", "redis:7.4", "alpine",
  "quest/shop:1.0", "node:22-alpine", "sh", "-c", "ls", "cat", "id", "env", "ping", "nslookup", "wget", "curl", "localhost:8080", "http://cache:6379", ".", "-t", "x:1",
  "--no-cache", "--target", "deps", "&&", ";", "|", "grep", "head", "-n", "2", "wc", "-l", ">", ">>", "out.txt", "Dockerfile", ".dockerignore", "sudo", "chown", "chmod",
  "777", "o+w", "/srv/uploads", "cd", "..", "/", "~", "echo", "printf", "touch", "mkdir", "-p", "du", "-sh", "sed", "-i", "s/a/b/", "npm", "'", "\"", "\\", "$(pwd)", "--", "-"];
const LINES = ["FROM node:22-alpine AS deps", "FROM deps", "FROM scratch", "FROM", "WORKDIR /app", "WORKDIR", "COPY . .", "COPY package*.json ./", "COPY --from=deps /app/node_modules ./node_modules",
  "COPY --from=nope /x /y", "COPY --chown=app:app . .", "COPY --chown=node . .", "COPY", "ADD https://example.com/x.tgz /tmp/", "RUN npm ci", "RUN npm ci --omit=dev", "RUN npm prune --omit=dev",
  "RUN apk add --no-cache curl", "RUN apt-get update && apt-get install -y curl", "RUN addgroup -S app && adduser -S -G app app", "RUN chown -R app:app /app", "RUN rm -rf /app/*",
  "RUN nonsense", "RUN [\"npm\", \"ci\"]", "RUN cd /tmp && echo hi", "USER app", "USER 10001", "ENV A=1 B=2", "ENV A 1", "ARG X=1", "EXPOSE 3000/tcp 8080", "CMD [\"node\", \"server.js\"]",
  "CMD node server.js", "CMD [broken", "ENTRYPOINT [\"node\"]", "HEALTHCHECK CMD wget -qO- localhost:3000", "LABEL a=b", "# comment", "", "RUN echo \\", "  continued", "BOGUS x"];

const rounds = Number(process.argv[2]) || 6000;
let n = 0;
for (let i = 0; i < rounds; i++) {
  const s = SCENARIOS[i % SCENARIOS.length];
  const e = new Engine(s);
  for (let j = 0; j < 4; j++) {
    let line;
    if (rand(6) === 0) {
      e.writeFile("/home/dev/shop/Dockerfile", Array.from({ length: 1 + rand(9) }, () => pick(LINES)).join(pick(["\n", "\r\n"])));
      e.cwd = "/home/dev/shop";
      line = pick(["docker build -t quest/shop:9 .", "docker build --target deps .", "docker build -f Dockerfile .", "docker build -t BAD .", "docker build"]);
    } else if (rand(4) === 0) line = String.fromCharCode(...Array.from({ length: rand(40) }, () => 32 + rand(95)));
    else line = Array.from({ length: 1 + rand(12) }, () => pick(WORDS)).join(" ");
    if (rand(2)) line = "docker " + line;
    try {
      const out = shell(e, line);
      assert.ok(Array.isArray(out));
      for (const l of out) assert.ok(Array.isArray(l) && typeof l[0] === "string", "each line is [text, class]");
      s.won(e);
      s.check(e);
    } catch (err) {
      console.error(`scenario ${s.id}, command: ${JSON.stringify(line)}`);
      throw err;
    }
    n++;
  }
}
console.log(`fuzz ok: ${n} commands across ${SCENARIOS.length} scenarios, 0 exceptions`);
