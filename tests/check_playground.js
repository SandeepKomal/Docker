// Drives the site's Docker simulator without a browser: every scenario
// starts broken, wrong moves keep it broken, and the intended fix solves it.
// Run with: node tests/check_playground.js
"use strict";
const path = require("path");
const assert = require("assert");

require(path.resolve(__dirname, "../site/playground.js"));
const { SCENARIOS, Engine, shell, lex, parseBytes, human, fillBlanks } = globalThis.DQSim;

const fresh = (id) => new Engine(SCENARIOS.find((s) => s.id === id));
const run = (e, cmd) => shell(e, cmd).map(([t]) => t).join("\n");
const won = (e) => e.scenario.won(e);
const broken = (e, why) => assert.ok(!won(e), why);
const fixed = (e, why) => assert.ok(won(e), why);

assert.deepStrictEqual(lex(`docker run -g "daemon off;" a && b`).map((t) => t.w || t.op), ["docker", "run", "-g", "daemon off;", "a", "&&", "b"]);
assert.strictEqual(lex(`echo "open`), null);
assert.strictEqual(parseBytes("512m"), 512 * 1048576);
assert.strictEqual(parseBytes("1g"), 1073741824);
assert.strictEqual(parseBytes("lots"), null);
assert.strictEqual(human(1617000000), "1.62GB");
assert.strictEqual(human(47900000), "47.9MB");

for (const s of SCENARIOS) {
  const e = new Engine(s);
  broken(e, `${s.id}: must start broken`);
  assert.strictEqual(s.hints.length, 3, `${s.id}: three hints`);
  assert.ok(s.story && s.goal && s.done && s.lesson && s.level, `${s.id}: story, goal, done, lesson, level`);
  assert.ok(s.check(e).label && s.check(e).text, `${s.id}: live status check`);
  for (const cmd of [...s.tries, "docker ps -a", "docker images", "docker network ls", "docker system df"]) {
    assert.ok(run(e, cmd).length > 0, `${s.id}: "${cmd}" prints something`);
  }
}

// Exits immediately: nginx was started as a daemon, so PID 1 returned.
let e = fresh("exits");
assert.match(run(e, "docker ps -a"), /nginx:1\.27\s+"\/docker-entrypoint\.…"\s+3 minutes ago\s+Exited \(0\) 3 minutes ago\s+web/);
assert.doesNotMatch(run(e, "docker ps"), /web/);
assert.match(run(e, "docker logs web"), /Configuration complete; ready for start up/);
assert.strictEqual(run(e, "docker inspect web --format '{{.Config.Cmd}}'"), "[nginx]");
assert.strictEqual(run(e, "docker inspect -f '{{.State.ExitCode}}' web"), "0");
assert.match(run(e, "curl localhost:8080"), /curl: \(7\) Failed to connect to localhost port 8080/);
assert.strictEqual(run(e, "docker start web"), "web");
assert.match(run(e, "docker ps -a"), /Exited \(0\)/);
broken(e, "docker start runs the same command, which exits again");
run(e, "docker restart web");
broken(e, "restart does not change the command");
assert.match(run(e, "docker run -d --name web -p 8080:80 nginx:1.27"), /Conflict\. The container name "\/web" is already in use by container "[0-9a-f]{64}"/);
run(e, "docker run -d --restart always --name web2 -p 8080:80 nginx:1.27 nginx");
assert.match(run(e, "docker ps"), /Restarting \(0\)/);
broken(e, "a restart policy just restarts a process that exits");
run(e, "docker rm -f web2");
run(e, "docker run -d -it --name web3 -p 8080:80 nginx:1.27 nginx");
broken(e, "a TTY does not keep a daemonising nginx in the foreground");
run(e, "docker rm web3");
assert.match(run(e, "docker rm web && docker run -d --name web -p 8080:80 nginx:1.27"), /^web\n[0-9a-f]{64}$/);
fixed(e, "exits: the default CMD keeps nginx in the foreground");
assert.match(run(e, "curl localhost:8080"), /<title>Welcome to nginx!<\/title>/);
assert.match(run(e, "docker ps"), /0\.0\.0\.0:8080->80\/tcp, \[::\]:8080->80\/tcp\s+web/);
e = fresh("exits");
run(e, `docker rm web; docker run -d --name web -p 8080:80 nginx:1.27 nginx -g "daemon off;"`);
fixed(e, "exits: nginx -g 'daemon off;' works too");

// Port not published: EXPOSE is not -p.
e = fresh("port");
assert.match(run(e, "docker ps"), /Up 10 minutes\s+80\/tcp\s+web/);
assert.strictEqual(run(e, "docker port web"), "");
run(e, "docker restart web");
broken(e, "a restart keeps the same (no) port mappings");
run(e, "docker run -d --name web2 -p 8080:8080 nginx:1.27");
assert.match(run(e, "curl localhost:8080"), /curl: \(56\) Recv failure: Connection reset by peer/);
broken(e, "publishing to the wrong container port");
run(e, "docker rm -f web2");
run(e, "docker run -d --name web3 -P nginx:1.27");
assert.match(run(e, "docker port web3"), /80\/tcp -> 0\.0\.0\.0:32768/);
broken(e, "-P picks a random host port, not 8080");
run(e, "docker rm -f web3 && docker run -d --name web4 --network host nginx:1.27");
broken(e, "host networking puts nginx on port 80, not 8080");
assert.match(run(e, "docker network connect host web"), /cannot be disconnected from host network or connected to host network/);
run(e, "docker rm -f web4");
run(e, "docker run -d --name blocker -p 8080:80 nginx:1.27");
assert.match(run(e, "docker run -d --name web5 -p 8080:80 nginx:1.27"), /Bind for 0\.0\.0\.0:8080 failed: port is already allocated/);
e = fresh("port");
run(e, "docker rm -f web && docker run -d --name web -p 8080:80 nginx:1.27");
fixed(e, "port: published 8080 to 80");

// Name not found: the default bridge has no DNS.
e = fresh("dns");
assert.match(run(e, "docker logs api"), /getaddrinfo ENOTFOUND cache/);
assert.match(run(e, "docker network inspect bridge"), /"com\.docker\.network\.bridge\.default_bridge": "true"/);
run(e, "docker start api");
broken(e, "starting again on the default bridge fails the same way");
run(e, "docker network create app-net");
run(e, "docker network connect app-net api && docker start api");
assert.match(run(e, "docker logs api --tail 9"), /ENOTFOUND cache/);
broken(e, "cache is not on app-net yet");
e = fresh("dns");
const ip = run(e, "docker inspect -f '{{.NetworkSettings.IPAddress}}' cache");
assert.match(ip, /^172\.17\.0\.\d+$/);
run(e, `docker rm api && docker run -d --name api -p 8080:8080 -e REDIS_HOST=${ip} quest/api:1.0`);
assert.match(run(e, "curl localhost:8080"), /api: ok/);
broken(e, "a hard-coded IP works today and breaks on the next restart; the goal is a name");
e = fresh("dns");
run(e, "docker rm api && docker run -d --name api -p 8080:8080 --link cache quest/api:1.0");
assert.match(run(e, "docker ps"), /Up .*api/);
broken(e, "--link is the legacy way; the goal is a user-defined network");
e = fresh("dns");
assert.match(run(e, "docker network create app-net"), /^[0-9a-f]{64}$/);
run(e, "docker network connect app-net cache && docker network connect app-net api && docker start api");
fixed(e, "dns: both on a user-defined network");
assert.match(run(e, "docker exec cache ls /data"), /^$/);
assert.match(run(e, "docker exec api ping -c 3 cache"), /64 bytes from 172\.18\.0\.\d+/);
assert.match(run(e, "docker exec api nslookup cache"), /Server:\t\t127\.0\.0\.11[\s\S]*Address: 172\.18/);
assert.match(run(e, "docker exec api curl http://cache:6379"), /executable file not found in \$PATH/);
e = fresh("dns");
run(e, "docker network create app-net && docker rm api && docker network connect app-net cache && docker run -d --name api --network app-net -p 8080:8080 quest/api:1.0");
fixed(e, "dns: also fixed by starting api on the network");

// A bind mount hides node_modules from the image.
e = fresh("volmask");
assert.match(run(e, "docker logs shop"), /Cannot find module 'express'/);
assert.match(run(e, "docker run --rm quest/shop:1.0 ls /app"), /node_modules/);
assert.doesNotMatch(run(e, "ls /home/dev/shop"), /node_modules/);
assert.match(run(e, "docker exec shop npm install"), /container [0-9a-f]{64} is not running/);
assert.match(run(e, "npm install"), /Command 'npm' not found/);
run(e, "docker restart shop");
broken(e, "restarting keeps the same mount");
run(e, "docker rm shop && docker run -d --name shop -p 3000:3000 quest/shop:1.0");
assert.match(run(e, "curl localhost:3000"), /shop: ok/);
broken(e, "dropping the bind mount loses live editing");
run(e, "docker rm -f shop && docker run -d --name shop -p 3000:3000 -v shop-code:/app quest/shop:1.0");
assert.match(run(e, "curl localhost:3000"), /shop: ok/);
broken(e, "a named volume over /app is a copy, not your folder");
e = fresh("volmask");
run(e, "docker rm shop && docker run -d --name shop -p 3000:3000 -v /home/dev/shop:/app -v /app/node_modules quest/shop:1.0");
fixed(e, "volmask: an anonymous volume brings node_modules back");
assert.match(run(e, "docker volume ls"), /local\s+[0-9a-f]{64}/);
e = fresh("volmask");
run(e, "docker rm shop && docker run -d --name shop -p 3000:3000 -v $(pwd):/app -v shop-deps:/app/node_modules quest/shop:1.0");
fixed(e, "volmask: a named volume for node_modules works too");

// Permission denied: the folder belongs to root, the app is uid 10001.
e = fresh("perms");
assert.match(run(e, "docker logs uploader"), /EACCES: permission denied, open '\/data\/uploads\/\.write-test'/);
assert.strictEqual(run(e, "docker image inspect -f '{{.Config.User}}' quest/uploader:1.0"), "app");
assert.strictEqual(run(e, "docker run --rm quest/uploader:1.0 id"), "uid=10001(app) gid=10001(app) groups=10001(app)");
assert.match(run(e, "ls -ld /srv/uploads"), /^drwxr-xr-x 2 root root\s+4096 .* \/srv\/uploads$/);
assert.match(run(e, "chown 10001:10001 /srv/uploads"), /Operation not permitted/);
assert.match(run(e, "sudo chown -R app:app /srv/uploads"), /chown: invalid user: ‘app:app’/);
run(e, "docker rm uploader && docker run -d --name uploader --privileged -p 8080:8080 -v /srv/uploads:/data/uploads quest/uploader:1.0");
broken(e, "--privileged does not change the user's uid");
run(e, "docker rm uploader && docker run -d --name uploader -u 0 -p 8080:8080 -v /srv/uploads:/data/uploads quest/uploader:1.0");
assert.match(run(e, "docker ps"), /Up .*uploader/);
broken(e, "running as root undoes the hardening");
e = fresh("perms");
run(e, "sudo chmod 777 /srv/uploads && docker start uploader");
assert.match(run(e, "docker ps"), /Up .*uploader/);
broken(e, "a world-writable folder is not the fix");
e = fresh("perms");
assert.match(run(e, "docker start uploader"), /^web$|^uploader$/);
broken(e, "starting again changes nothing");
run(e, "sudo chown -R 10001:10001 /srv/uploads && docker start uploader");
fixed(e, "perms: the folder belongs to the app's uid");
assert.match(run(e, "ls -ln /srv"), /drwxr-xr-x 2 10001 10001/);
e = fresh("perms");
run(e, "sudo chown root:10001 /srv/uploads && sudo chmod 775 /srv/uploads && docker start uploader");
fixed(e, "perms: a group-writable folder for the app's group also works");

// A 1.6 GB image: context, base and dev dependencies.
const shop = (e2, dockerfile, ignore) => {
  if (ignore !== undefined) e2.writeFile("/home/dev/shop/.dockerignore", ignore);
  if (dockerfile) e2.writeFile("/home/dev/shop/Dockerfile", dockerfile);
  return run(e2, "docker build -t quest/shop:1.1 .");
};
const size = (e2) => run(e2, "docker images quest/shop --format '{{.Tag}} {{.Size}}'");
const IGNORE = ".git\nnode_modules\nlogs\n.env\n";
const MULTI = 'FROM node:22-alpine AS deps\nWORKDIR /app\nCOPY package*.json ./\nRUN npm ci --omit=dev\n\nFROM node:22-alpine\nWORKDIR /app\nCOPY --from=deps /app/node_modules ./node_modules\nCOPY . .\nUSER node\nCMD ["node", "server.js"]\n';
e = fresh("bigimage");
assert.match(run(e, "docker images"), /quest\/shop\s+1\.0\s+[0-9a-f]{12}\s+24 hours ago\s+1\.62GB/);
assert.match(run(e, "docker history quest/shop:1.0"), /COPY \. \. # buildkit\s+310MB/);
assert.match(run(e, "docker run --rm quest/shop:1.0 ls -a /app"), /\.env\s+\.git/);
assert.match(run(e, "docker build --squash -t quest/shop:1.1 ."), /squash is removed with BuildKit/);
assert.match(run(e, "docker image prune -f"), /Total reclaimed space: 0B/);
broken(e, "pruning does not shrink an image");
assert.match(run(e, "sed -i 's/FROM node:22/FROM node:22-alpine/' Dockerfile && docker build -t quest/shop:1.1 ."), /transferring context: 310\.\d+MB/);
assert.match(size(e), /1\.1 656MB/);
broken(e, "a small base alone still carries .git and node_modules");
e = fresh("bigimage");
assert.match(shop(e, null, IGNORE), /transferring context: 1\.39MB/);
assert.match(size(e), /1\.1 1\.31GB/);
broken(e, ".dockerignore alone leaves the 1.12GB base");
shop(e, 'FROM node:22-alpine\nWORKDIR /app\nCOPY . .\nRUN npm ci\nCMD ["node", "server.js"]\n');
assert.match(size(e), /1\.1 347MB/);
broken(e, "dev dependencies still ship");
shop(e, MULTI.replace("COPY --from=deps /app/node_modules ./node_modules\n", ""));
assert.ok(/1\.1 1\d\dMB/.test(size(e)) && !won(e), "a small image that cannot start is not a fix");
shop(e, MULTI, ".git\nnode_modules\nlogs\n");
assert.match(run(e, "docker run --rm quest/shop:1.1 ls -a /app"), /\.env/);
broken(e, ".env must stay out of the image");
e = fresh("bigimage");
run(e, "rm -rf .git .env node_modules");
shop(e, MULTI, ".git\nnode_modules\nlogs\n");
broken(e, "deleting the project's history and settings is not the fix");
e = fresh("bigimage");
assert.match(shop(e, MULTI, IGNORE), /\[deps 4\/4\] RUN npm ci --omit=dev[\s\S]*\[stage-1 3\/4\] COPY --from=deps \/app\/node_modules \.\/node_modules[\s\S]*naming to docker\.io\/quest\/shop:1\.1/);
assert.match(size(e), /1\.1 209MB/);
fixed(e, "bigimage: .dockerignore and a two-stage build on alpine");
assert.match(run(e, "docker run -d -p 3000:3000 quest/shop:1.1 && curl localhost:3000"), /shop: ok/);
e = fresh("bigimage");
run(e, `printf '.git\\nnode_modules\\nlogs\\n.env\\n' > .dockerignore`);
run(e, `printf 'FROM node:22-alpine\\nWORKDIR /app\\nCOPY package*.json ./\\nRUN npm ci --omit=dev\\nCOPY . .\\nCMD ["node", "server.js"]\\n' > Dockerfile`);
run(e, "docker build -t quest/shop:slim .");
fixed(e, "bigimage: one stage with production dependencies also fits");

// Build cache: COPY . . before npm ci reruns the install on every edit.
const ORDERED = 'FROM node:22-alpine\nWORKDIR /app\nCOPY package*.json ./\nRUN npm ci --omit=dev\nCOPY . .\nEXPOSE 3000\nCMD ["node", "server.js"]\n';
e = fresh("cache");
const first = run(e, "docker build -t quest/shop:1.1 .");
assert.match(first, /CACHED \[2\/4\] WORKDIR \/app/);
assert.match(first, / => \[4\/4\] RUN npm ci --omit=dev/);
broken(e, "the original order reruns npm ci");
assert.match(run(e, "docker build -t quest/shop:1.1 ."), /CACHED \[4\/4\] RUN npm ci/);
broken(e, "everything cached because nothing changed: no source change was built");
run(e, "echo '// x' >> server.js");
assert.match(run(e, "docker build -t quest/shop:1.1 ."), / => \[4\/4\] RUN npm ci/);
broken(e, "with COPY . . first, any edit reruns npm ci");
run(e, "touch server.js");
e.writeFile("/home/dev/shop/Dockerfile", ORDERED);
run(e, "docker build -t quest/shop:1.2 .");
broken(e, "the first build after reordering installs once");
run(e, "echo '// y' >> server.js");
assert.match(run(e, "docker build --no-cache -t quest/shop:1.3 ."), / => \[4\/5\] RUN npm ci/);
broken(e, "--no-cache throws the cache away");
run(e, "echo '// z' >> server.js");
const good = run(e, "docker build -t quest/shop:1.4 .");
assert.match(good, /CACHED \[4\/5\] RUN npm ci --omit=dev/);
assert.match(good, / => \[5\/5\] COPY \. \./);
fixed(e, "cache: dependencies before source");
run(e, "docker builder prune -f && docker build -t quest/shop:1.5 .");
broken(e, "after pruning the cache, everything runs again");

// OOMKilled: exit 137, a limit below what the app needs.
e = fresh("oom");
assert.match(run(e, "docker ps -a"), /Exited \(137\) 4 minutes ago\s+report/);
assert.strictEqual(run(e, "docker inspect report --format '{{.State.OOMKilled}}'"), "true");
assert.strictEqual(run(e, "docker inspect report --format '{{.HostConfig.Memory}}'"), "134217728");
assert.match(run(e, "docker logs report"), /loading 1\.2M rows into memory$/);
run(e, "docker restart report");
broken(e, "a restart hits the same limit");
assert.match(run(e, "docker update --memory 512m report"), /Memory limit should be smaller than already set memoryswap limit, update the memoryswap at the same time/);
assert.strictEqual(run(e, "docker update --memory 256m report"), "report");
run(e, "docker start report");
assert.match(run(e, "docker ps -a"), /Exited \(137\)/);
broken(e, "256 MiB is still below the 300 MB it loads");
run(e, "docker rm report && docker run -d --name report -p 8080:8080 quest/report:2.0");
assert.match(run(e, "curl localhost:8080"), /report: ok/);
broken(e, "removing the limit is not the fix");
run(e, "docker rm -f report && docker run -d --name report -p 8080:8080 --memory 128m --oom-kill-disable quest/report:2.0");
assert.match(run(e, "curl localhost:8080"), /curl: \(28\)/);
broken(e, "disabling the OOM killer leaves it stuck");
assert.match(run(e, "docker run -d --memory 4m quest/report:2.0"), /Minimum memory limit allowed is 6MB/);
e = fresh("oom");
run(e, "docker update --memory 512m --memory-swap 512m report && docker start report");
fixed(e, "oom: a limit it can live with");
assert.match(run(e, "docker stats --no-stream"), /report\s+0\.02%\s+282\.29MiB \/ 512\.00MiB/);

// Real error text for common slips.
e = fresh("exits");
assert.match(run(e, "docker run ngnix"), /Unable to find image 'ngnix:latest' locally\ndocker: Error response from daemon: pull access denied for ngnix, repository does not exist/);
assert.match(run(e, "docker pull nginx:9.9"), /manifest for nginx:9\.9 not found: manifest unknown/);
assert.match(run(e, "docker run -d nginx:1.27 nginxx"), /exec: "nginxx": executable file not found in \$PATH/);
assert.match(run(e, "docker ps -a"), /Created\s+\w+_\w+/);
assert.match(run(e, "docker rm nope"), /No such container: nope/);
assert.match(run(e, "docker run --nope nginx"), /^unknown flag: --nope\nSee 'docker run --help'\.$/);
assert.match(run(e, "docker logs"), /requires 1 argument/);
assert.match(run(e, "docker run -d --name w2 nginx:1.27 && docker rm w2"), /cannot remove container "\/w2": container is running/);
assert.match(run(e, "docker rmi nginx:1.27"), /conflict: unable to remove repository reference "nginx:1\.27" \(must force\)/);
assert.match(run(e, "docker exec web ls"), /is not running/);
assert.match(run(e, "docker inspect web --format '{{.State.Nope}}'"), /map has no entry for key "Nope"/);
assert.match(run(e, "docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' w2"), /^172\.17\.0\.\d+$/);
assert.match(run(e, "docker build ."), /failed to read dockerfile: open Dockerfile: no such file or directory/);
assert.match(run(e, "dockr ps"), /bash: dockr: command not found/);
assert.match(run(e, "docker system prune"), /Are you sure you want to continue\?/);
assert.match(run(e, "docker compose up -d"), /Lab/);
e = fresh("bigimage");
e.writeFile("/home/dev/shop/Dockerfile", "FROM node:22\nCOPPY . .\n");
assert.match(run(e, "docker build ."), /dockerfile parse error on line 2: unknown instruction: COPPY/);
e.writeFile("/home/dev/shop/Dockerfile", "FROM node:22-alpine\nWORKDIR /app\nCOPY package.json ./\nRUN npm ci\n");
assert.match(run(e, "docker build ."), /npm error The `npm ci` command can only install with an existing package-lock\.json[\s\S]*did not complete successfully: exit code: 1/);
e.writeFile("/home/dev/shop/Dockerfile", "FROM nodee:22\n");
assert.match(run(e, "docker build ."), /pull access denied, repository does not exist/);
e.writeFile("/home/dev/shop/Dockerfile", "FROM node:22-alpine\nCOPY yarn.lock ./\n");
assert.match(run(e, "docker build ."), /"\/yarn\.lock": not found/);

// The cheat sheet: each command marked Try runs as written in its scenario,
// and each one left to the lab really cannot run here.
global.window = {};
require(path.resolve(__dirname, "../site/data.js"));
const Q = window.QUEST;
const runsIn = (id, cmd) => {
  const e2 = fresh(id);
  const full = fillBlanks(e2, cmd);
  if (/<[a-z]+>/.test(full)) return false;
  return !shell(e2, full).some(([t, k]) => k === "na" || /command not found|^(Error|ERROR|docker:)/.test(t));
};
for (const [cmd, , , where] of Q.cheats) {
  if (where) assert.ok(runsIn(where === "any" ? "exits" : where, cmd), `cheat sheet: "${cmd}" should run in ${where}`);
  else assert.ok(!SCENARIOS.some((s) => runsIn(s.id, cmd)), `cheat sheet: "${cmd}" now runs in the playground; give it a Try`);
}

// Scenarios name real levels, and references link only to scenarios that exist.
const ids = new Set(SCENARIOS.map((x) => x.id));
for (const s of SCENARIOS) assert.ok(Q.levels.some((l) => l.id === s.level), `${s.id}: level ${s.level} exists`);
for (const d of Q.doctor) for (const id of d.scenarios || []) assert.ok(ids.has(id), `doctor "${d.status}" links to unknown scenario ${id}`);
for (const lv of Q.levels) for (const id of lv.practise || []) assert.ok(ids.has(id), `level ${lv.id} links to unknown scenario ${id}`);
for (const c of Q.architecture.components) for (const id of c.practise) assert.ok(ids.has(id), `architecture ${c.id} links to unknown scenario ${id}`);
for (const id of ids) assert.ok(Q.doctor.some((d) => (d.scenarios || []).includes(id)), `scenario ${id} has a troubleshooting entry`);

console.log(`playground ok: ${SCENARIOS.length} scenarios, ${Q.cheats.length} cheat sheet rows`);
