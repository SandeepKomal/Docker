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

const ORDERS_FIXED = `services:
  api:
    build: .
    ports:
      - "8080:8080"
    environment:
      DB_HOST: db
      DB_PASSWORD: \${DB_PASSWORD}
    depends_on:
      db:
        condition: service_healthy
  db:
    image: postgres:17
    environment:
      POSTGRES_PASSWORD: \${DB_PASSWORD}
    healthcheck:
      test: ["CMD", "pg_isready", "-U", "postgres"]
      interval: 5s
volumes:
  db-data:
`;
// pull access denied: a typo in the image name.
e = fresh("typo");
assert.strictEqual(run(e, "docker ps -aq"), "");
assert.match(run(e, "docker pull ngnix"), /pull access denied for ngnix, repository does not exist/);
run(e, "docker run -d --name web -p 8080:80 ngnix:latest");
broken(e, "another tag of the typo");
assert.match(run(e, "docker login"), /pipe a token in/);
run(e, "docker run -d --name web -p 8080:80 nginx:1.27");
fixed(e, "typo: the right name");

// Name already in use: the stopped 1.0 container keeps the name web.
e = fresh("conflict");
assert.match(run(e, "docker run -d --name web -p 8080:80 quest/site:1.1"), /Conflict\. The container name "\/web" is already in use/);
run(e, "docker start web");
assert.match(run(e, "curl localhost:8080"), /v1\.0/);
broken(e, "starting the old container serves the old version");
run(e, "docker stop web && docker run -d --name web2 -p 8080:80 quest/site:1.1");
assert.match(run(e, "curl localhost:8080"), /v1\.1/);
broken(e, "the new version must run as web");
run(e, "docker rm -f web2 && docker rm web && docker run -d --name web -p 8080:80 quest/site:1.1");
fixed(e, "conflict: old container removed, new one runs as web");
e = fresh("conflict");
run(e, "docker rename web web-1.0 && docker run -d --name web -p 8080:80 quest/site:1.1");
fixed(e, "conflict: renaming the old one also works");

// Executable not found: CMD names nodejs.
e = fresh("exit127");
assert.match(run(e, "docker ps -a"), /Created\s+shop/);
assert.match(run(e, "docker start shop"), /exec: "nodejs": executable file not found in \$PATH[\s\S]*Error: failed to start containers: shop/);
run(e, "docker rm shop && docker run -d --name shop --restart always -p 3000:3000 quest/shop:1.0");
broken(e, "a restart policy cannot find the binary either");
assert.match(run(e, "docker run --rm --entrypoint ls quest/shop:1.0 /usr/local/bin"), /node/);
run(e, "docker rm -f shop && docker run -d --name shop -p 3000:3000 quest/shop:1.0 node server.js");
broken(e, "arguments go to the entrypoint, which is still nodejs");
e = fresh("exit127");
run(e, "docker rm shop && docker run -d --name shop -p 3000:3000 --entrypoint node quest/shop:1.0 server.js");
fixed(e, "exit127: overriding the entrypoint works");
e = fresh("exit127");
run(e, "sed -i 's/nodejs/node/' Dockerfile && docker build -t quest/shop:1.1 . && docker rm shop && docker run -d --name shop -p 3000:3000 quest/shop:1.1");
fixed(e, "exit127: fixing CMD and rebuilding works");

// Restarting forever: a restart policy around missing configuration.
e = fresh("restartloop");
assert.match(run(e, "docker ps"), /Restarting \(1\)/);
assert.match(run(e, "docker logs worker"), /QUEUE_URL is not set/);
run(e, "docker restart worker");
broken(e, "restarting changes nothing");
run(e, "docker update --restart no worker");
assert.match(run(e, "docker ps -a"), /Exited \(1\)/);
broken(e, "turning the policy off just stops the loop");
run(e, "docker rm -f worker && docker run -d --name worker --restart always -e QUEUE_URL= quest/worker:1.0");
broken(e, "an empty value is still missing");
run(e, "docker rm -f worker && docker run -d --name worker --restart always -e QUEUE_URL=redis://cache:6379 quest/worker:1.0");
fixed(e, "restartloop: the variable is set");

// No logs: --log-driver none.
e = fresh("nologs");
assert.match(run(e, "docker logs worker"), /configured logging driver does not support reading/);
assert.strictEqual(run(e, "docker inspect worker --format '{{.HostConfig.LogConfig.Type}}'"), "none");
run(e, "docker rm worker && docker run -d --name worker --log-driver none -e QUEUE_URL=redis://cache:6379 quest/worker:1.0");
broken(e, "running blind is not the goal");
run(e, "docker rm -f worker && docker run -d --name worker --log-driver local quest/worker:1.0");
assert.match(run(e, "docker logs worker"), /QUEUE_URL is not set/);
run(e, "docker rm worker && docker run -d --name worker --log-driver local -e QUEUE_URL=redis://cache:6379 quest/worker:1.0");
fixed(e, "nologs: readable logs and the variable");
assert.match(run(e, "docker run -d --log-driver nope quest/worker:1.0"), /no log driver named 'nope' is registered/);

// localhost inside a container is the container.
e = fresh("localhost");
assert.match(run(e, "docker logs api"), /ECONNREFUSED 127\.0\.0\.1:6379/);
run(e, "docker rm api && docker run -d --name api --network app-net -p 8080:8080 -e REDIS_HOST=127.0.0.1 quest/api:1.0");
broken(e, "127.0.0.1 is still the container");
run(e, "docker rm api && docker run -d --name api --network host -e REDIS_HOST=localhost quest/api:1.0");
broken(e, "host networking: nothing listens on the host's 6379");
const cacheIp = run(e, "docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' cache");
run(e, `docker rm api && docker run -d --name api --network app-net -p 8080:8080 -e REDIS_HOST=${cacheIp} quest/api:1.0`);
assert.match(run(e, "docker ps"), /Up .*api/);
broken(e, "an IP address works until cache is re-created");
run(e, "docker rm -f api && docker run -d --name api --network app-net -p 8080:8080 -e REDIS_HOST=cache quest/api:1.0");
fixed(e, "localhost: the service name");

// Listening on 127.0.0.1 inside the container.
e = fresh("loopback");
assert.match(run(e, "curl localhost:3000"), /curl: \(56\) Recv failure: Connection reset by peer/);
assert.match(run(e, "docker logs shop"), /listening on 127\.0\.0\.1:3000/);
assert.match(run(e, "docker exec shop wget -qO- localhost:3000"), /shop: ok/);
run(e, "docker rm -f shop && docker run -d --name shop -p 127.0.0.1:3000:3000 -e HOST=127.0.0.1 quest/shop:1.0");
broken(e, "publishing on the host's loopback does not change where the app listens");
run(e, "docker rm -f shop && docker run -d --name shop --network host -e HOST=127.0.0.1 quest/shop:1.0");
assert.match(run(e, "curl localhost:3000"), /shop: ok/);
broken(e, "host networking gives up the container's own network");
run(e, "docker rm -f shop && docker run -d --name shop -p 3000:3000 -e HOST=0.0.0.0 quest/shop:1.0");
fixed(e, "loopback: listening on every interface");

// Port already allocated by the old container.
e = fresh("portinuse");
assert.match(run(e, "docker start web"), /Bind for 0\.0\.0\.0:8080 failed: port is already allocated/);
run(e, "docker run -d --name web2 -p 8081:80 quest/site:1.1");
assert.match(run(e, "curl localhost:8080"), /v1\.0/);
broken(e, "another port leaves 8080 on the old version");
run(e, "docker stop web-old && docker start web");
fixed(e, "portinuse: the old container gives up the port");

// Different networks: no shared network, no name.
e = fresh("isolated");
assert.match(run(e, "docker logs api"), /ENOTFOUND cache/);
run(e, "docker network connect bridge api && docker start api");
broken(e, "the default bridge has no DNS and no cache");
run(e, "docker network connect back api && docker start api");
fixed(e, "isolated: api joins the back network");
e = fresh("isolated");
run(e, "docker network connect front cache && docker start api");
fixed(e, "isolated: or cache joins front");

// Data gone after re-create: the image's anonymous volume.
e = fresh("datalost");
assert.strictEqual(run(e, "docker exec cache redis-cli dbsize"), "(integer) 0");
assert.strictEqual(run(e, "docker volume ls -q").split("\n").length, 2);
run(e, "docker rm -f cache && docker run -d --name cache -v /data redis:7.4");
broken(e, "another anonymous volume is lost the same way");
run(e, "docker rm -f cache && docker run -d --name cache -v redis-data:/data redis:7.4");
fixed(e, "datalost: a named volume");
e = fresh("datalost");
const oldVol = run(e, "docker volume ls -q").split("\n").find((v) => !run(e, "docker inspect cache --format '{{json .Mounts}}'").includes(v));
run(e, `docker rm -f cache && docker run -d --name cache -v ${oldVol}:/data redis:7.4`);
assert.strictEqual(run(e, "docker exec cache redis-cli dbsize"), "(integer) 1532");
fixed(e, "datalost: mounting the old volume by name brings the keys back");

// Read-only root: nginx needs two writable paths.
e = fresh("readonly");
assert.match(run(e, "docker logs web"), /can not modify \/etc\/nginx\/conf\.d\/default\.conf[\s\S]*mkdir\(\) "\/var\/cache\/nginx\/client_temp" failed \(30: Read-only file system\)/);
run(e, "docker rm web && docker run -d --name web --read-only --tmpfs /var/cache/nginx -p 8080:80 nginx:1.27");
assert.match(run(e, "docker logs web"), /nginx\.pid" failed \(30: Read-only file system\)/);
broken(e, "one tmpfs is not enough");
run(e, "docker rm web && docker run -d --name web -p 8080:80 nginx:1.27");
broken(e, "dropping --read-only is not the goal");
run(e, "docker rm -f web && docker run -d --name web --read-only --tmpfs /var/cache/nginx --tmpfs /var/run -p 8080:80 nginx:1.27");
fixed(e, "readonly: tmpfs where nginx writes");

// Capabilities: nginx needs CHOWN, SETUID and SETGID.
e = fresh("capdrop");
assert.match(run(e, "docker logs web"), /chown\("\/var\/cache\/nginx\/client_temp", 101\) failed \(1: Operation not permitted\)/);
run(e, "docker rm web && docker run -d --name web --cap-drop ALL --cap-add CHOWN -p 8080:80 nginx:1.27");
assert.match(run(e, "docker logs web"), /setgid\(101\) failed/);
assert.match(run(e, "curl localhost:8080"), /curl: \(28\)/);
broken(e, "CHOWN alone leaves nginx without workers");
run(e, "docker rm -f web && docker run -d --name web --privileged -p 8080:80 nginx:1.27");
broken(e, "--privileged is the opposite of hardening");
run(e, "docker rm -f web && docker run -d --name web --cap-drop ALL --cap-add ALL -p 8080:80 nginx:1.27");
broken(e, "adding everything back undoes the drop");
run(e, "docker rm -f web && docker run -d --name web --cap-drop ALL --cap-add CHOWN --cap-add SETUID --cap-add SETGID -p 8080:80 nginx:1.27");
fixed(e, "capdrop: only what nginx needs");

// A token in a layer: rm in a later step, ARG and ENV all leave it behind.
const pay = (e2, dockerfile, build) => { if (dockerfile) e2.writeFile("/home/dev/payments/Dockerfile", dockerfile); return run(e2, build || "docker build -t quest/payments:1.1 ."); };
const PAY_FROM = "FROM node:22-alpine\nWORKDIR /app\n";
const PAY_END = 'COPY server.js ./\nUSER node\nCMD ["node", "server.js"]\n';
e = fresh("secretlayer");
assert.match(run(e, "docker history quest/payments:1.0"), /COPY package\*\.json \.npmrc \.\/ # buildkit/);
assert.match(run(e, "docker run --rm quest/payments:1.0 ls -a /app"), /^(?![\s\S]*\.npmrc)/);
assert.match(pay(e, PAY_FROM + "COPY package*.json ./\nRUN npm ci --omit=dev\n" + PAY_END), /npm error 401 Unauthorized/);
pay(e, PAY_FROM + "ARG NPM_TOKEN\nCOPY package*.json ./\nRUN echo \"//npm.pkg.github.com/:_authToken=${NPM_TOKEN}\" > .npmrc && npm ci --omit=dev && rm .npmrc\n" + PAY_END, "docker build --build-arg NPM_TOKEN=practice-token-not-real -t quest/payments:1.1 .");
assert.match(run(e, "docker history --no-trunc quest/payments:1.1"), /\|1 NPM_TOKEN=practice-token-not-real/);
broken(e, "a build argument is recorded in the history");
const SECRET_RUN = PAY_FROM + "COPY package*.json ./\nRUN --mount=type=secret,id=npmrc,target=/root/.npmrc npm ci --omit=dev\n" + PAY_END;
assert.match(pay(e, SECRET_RUN), /npm error 401/);
broken(e, "the secret mount needs --secret on the build");
assert.match(pay(e, SECRET_RUN, "docker build --secret id=npmrc,src=.npmrc -t quest/payments:1.2 ."), /naming to docker\.io\/quest\/payments:1\.2/);
assert.doesNotMatch(run(e, "docker history --no-trunc quest/payments:1.2"), /practice-token|\.npmrc \.\//);
fixed(e, "secretlayer: a BuildKit secret mount");
assert.match(run(e, "docker run -d -p 3000:3000 quest/payments:1.2 && curl localhost:3000"), /payments: ok/);

// COPY: not found because .dockerignore excludes dist.
e = fresh("copymissing");
assert.match(run(e, "docker build -t quest/web:1.0 ."), /"\/dist": not found/);
assert.match(run(e, "docker build --no-cache -t quest/web:1.0 ."), /"\/dist": not found/);
e.writeFile("/home/dev/web/Dockerfile", "FROM nginx:1.27\nCOPY . /usr/share/nginx/html/\n");
run(e, "docker build -t quest/web:1.0 .");
broken(e, "copying the whole context still leaves dist out");
e = fresh("copymissing");
run(e, "sed -i '/^dist$/d' .dockerignore && docker build -t quest/web:1.0 .");
fixed(e, "copymissing: dist back in the context");
assert.match(run(e, "docker run -d -p 8080:80 quest/web:1.0 && curl localhost:8080"), /Kitchen web/);

// exec format error: an arm64 image on an amd64 host.
e = fresh("platform");
assert.match(run(e, "docker logs shop"), /exec \/usr\/local\/bin\/docker-entrypoint\.sh: exec format error/);
assert.match(run(e, "docker ps -a"), /Exited \(255\)/);
assert.strictEqual(run(e, "docker image inspect quest/shop:2.0 --format '{{.Architecture}}'"), "arm64");
assert.match(run(e, "docker rm shop && docker run -d --name shop -p 3000:3000 quest/shop:2.0"), /WARNING: The requested image's platform \(linux\/arm64\/v8\) does not match the detected host platform/);
broken(e, "running it again fails the same way");
assert.match(run(e, "docker run -d --platform linux/amd64 -p 3001:3000 quest/shop:2.0"), /its platform \(linux\/arm64\) does not match the specified platform \(linux\/amd64\)/);
run(e, "docker rm -f shop && docker build --platform linux/amd64 -t quest/shop:2.0 . && docker run -d --name shop -p 3000:3000 quest/shop:2.0");
fixed(e, "platform: built for amd64");

// Private registry: log in to the right registry.
e = fresh("auth");
assert.match(run(e, "docker pull ghcr.io/kitchen/shop:2.1"), /Head "https:\/\/ghcr\.io\/v2\/kitchen\/shop\/manifests\/2\.1": unauthorized/);
assert.match(run(e, "echo $GHCR_TOKEN | docker login -u kitchen-ci --password-stdin"), /Login Succeeded/);
assert.match(run(e, "docker pull ghcr.io/kitchen/shop:2.1"), /unauthorized/);
broken(e, "logging in to Docker Hub does not help with ghcr.io");
assert.match(run(e, "docker login ghcr.io --password-stdin"), /Must provide --username with --password-stdin/);
assert.match(run(e, "echo $GHCR_TOKEN | docker login ghcr.io -u kitchen-ci --password-stdin"), /^Login Succeeded$/);
assert.match(run(e, "docker run -d --name shop2 -p 3000:3000 ghcr.io/kitchen/shop:2.1"), /2\.1: Pulling from kitchen\/shop[\s\S]*Status: Downloaded newer image for ghcr\.io\/kitchen\/shop:2\.1/);
fixed(e, "auth: logged in to ghcr.io");
assert.match(run(e, "docker logout ghcr.io"), /Removing login credentials for ghcr\.io/);

// Docker Hub rate limit: authenticate the pulls.
e = fresh("ratelimit");
assert.match(run(e, "docker pull nginx:1.27"), /toomanyrequests: You have reached your unauthenticated pull rate limit/);
run(e, "docker pull nginx:latest");
broken(e, "another tag hits the same limit");
assert.match(run(e, "docker login -u kitchenci -p $DOCKERHUB_TOKEN"), /WARNING! Using --password via the CLI is insecure/);
e = fresh("ratelimit");
run(e, "echo $DOCKERHUB_TOKEN | docker login -u kitchenci --password-stdin && docker run -d --name web2 -p 8080:80 nginx:1.27");
fixed(e, "ratelimit: authenticated pulls");

// Old image under a moving tag.
e = fresh("stale");
assert.match(run(e, "curl localhost:3000"), /version 2\.3/);
run(e, "docker rm -f shop && docker run -d --name shop -p 3000:3000 kitchen/shop:latest");
broken(e, "re-creating reuses the local image");
assert.match(run(e, "docker pull kitchen/shop:latest"), /Status: Downloaded newer image for kitchen\/shop:latest/);
broken(e, "pulling alone does not change the running container");
run(e, "docker rm -f shop && docker run -d --name shop -p 3000:3000 kitchen/shop:latest");
fixed(e, "stale: pulled and re-created");
assert.match(run(e, "docker images"), /<none>\s+<none>/);
e = fresh("stale");
run(e, "docker rm -f shop && docker run -d --pull always --name shop -p 3000:3000 kitchen/shop:latest");
fixed(e, "stale: --pull always");

// Logs fill the disk: rotation, not truncation.
e = fresh("logs");
assert.match(run(e, "df -h"), /\/dev\/sda1\s+24G\s+2\dG\s+\d\.\dG\s+8\d%/);
const logPath = run(e, "docker inspect chatty --format '{{.LogPath}}'");
assert.match(logPath, /^\/var\/lib\/docker\/containers\/[0-9a-f]{64}\/[0-9a-f]{64}-json\.log$/);
assert.match(run(e, `sudo du -sh ${logPath}`), /^13\.2G\t/);
run(e, `sudo truncate -s 0 ${logPath}`);
broken(e, "truncating frees space today; the log grows back");
run(e, "docker restart chatty");
broken(e, "a restart keeps the same log settings");
run(e, "docker rm -f chatty && docker run -d --name chatty -p 8080:8080 --log-opt max-size=10m --log-opt max-file=3 quest/chatty:1.0");
fixed(e, "logs: rotation");
assert.match(run(e, "docker inspect chatty --format '{{json .HostConfig.LogConfig}}'"), /"max-size":"10m"/);
e = fresh("logs");
run(e, "docker rm -f chatty && docker run -d --name chatty -p 8080:8080 --log-driver local quest/chatty:1.0");
fixed(e, "logs: the local driver rotates too");

// No space left: prune what can be rebuilt, keep the volume.
e = fresh("diskfull");
assert.match(run(e, "docker build -t quest/shop:1.1 ."), /no space left on device/);
assert.match(run(e, "docker system df"), /Local Volumes\s+1\s+0\s+2\.1GB\s+2\.1GB \(100%\)\nBuild Cache\s+4\d\s+0\s+14GB/);
assert.match(run(e, "docker system prune"), /Are you sure you want to continue/);
broken(e, "the prompt was not answered");
run(e, "docker volume prune -a -f && docker build -t quest/shop:1.1 .");
broken(e, "deleting the database volume is not the fix");
e = fresh("diskfull");
assert.match(run(e, "docker system prune -a --volumes"), /all anonymous volumes not used by at least one container/);
run(e, "docker system prune -a --volumes -f && docker build -t quest/shop:1.1 .");
fixed(e, "diskfull: system prune removes only anonymous volumes, so pgdata survives");
e = fresh("diskfull");
run(e, "docker builder prune -f && docker image prune -f");
assert.match(run(e, "docker build -t quest/shop:1.1 ."), /naming to docker\.io\/quest\/shop:1\.1/);
fixed(e, "diskfull: build cache and dangling images pruned");

// Unhealthy: the healthcheck uses curl in an alpine image.
e = fresh("healthcheck");
assert.match(run(e, "docker ps"), /Up \d+ minutes \(unhealthy\)/);
assert.match(run(e, "docker inspect shop --format '{{json .State.Health}}'"), /\/bin\/sh: curl: not found/);
run(e, "docker restart shop");
broken(e, "restarting does not install curl");
run(e, "docker rm -f shop && docker run -d --name shop -p 3000:3000 --no-healthcheck quest/shop:1.0");
broken(e, "no healthcheck is not the goal");
run(e, "docker rm -f shop && docker run -d --name shop -p 3000:3000 --health-cmd 'exit 0' quest/shop:1.0");
assert.match(run(e, "docker ps"), /\(healthy\)/);
broken(e, "a check that always passes tests nothing");
run(e, "docker rm -f shop && docker run -d --name shop -p 3000:3000 --health-cmd 'wget -qO- http://localhost:3000/ || exit 1' quest/shop:1.0");
fixed(e, "healthcheck: a check with wget");
e = fresh("healthcheck");
run(e, "sed -i 's#curl -f#wget -qO-#' Dockerfile && docker build -t quest/shop:1.1 . && docker rm -f shop && docker run -d --name shop -p 3000:3000 quest/shop:1.1");
fixed(e, "healthcheck: fixed in the Dockerfile");
e = fresh("healthcheck");
run(e, "sed -i 's#^EXPOSE#RUN apk add --no-cache curl\\nEXPOSE#' Dockerfile && docker build -t quest/shop:1.1 . && docker rm -f shop && docker run -d --name shop -p 3000:3000 quest/shop:1.1");
fixed(e, "healthcheck: or curl installed in the image");

// Compose: localhost instead of the service name.
e = fresh("composedns");
assert.match(run(e, "docker compose ps -a"), /orders-api-1\s+orders-api\s+.*api\s+.*Exited \(1\)/);
assert.match(run(e, "docker compose logs api"), /api-1\s+\| Error: connect ECONNREFUSED 127\.0\.0\.1:5432/);
run(e, "docker compose restart api");
broken(e, "compose restart keeps the old settings");
const dbIp = run(e, "docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' orders-db-1");
run(e, `sed -i 's/DB_HOST: localhost/DB_HOST: ${dbIp}/' compose.yaml && docker compose up -d`);
broken(e, "an IP address is not a name");
run(e, `sed -i 's/DB_HOST: ${dbIp}/DB_HOST: db/' compose.yaml`);
assert.match(run(e, "docker compose up -d"), /Container orders-db-1\s+Healthy[\s\S]*Container orders-api-1\s+Recreated/);
fixed(e, "composedns: the service name");
assert.match(run(e, "curl localhost:8080"), /orders: ok/);
assert.match(run(e, "docker compose down"), /Container orders-api-1\s+Removed[\s\S]*Network orders_default\s+Removed/);
assert.match(run(e, "docker volume ls"), /orders_db-data/);

// Compose: depends_on without a healthy condition.
e = fresh("composeorder");
assert.match(run(e, "docker compose logs api"), /ECONNREFUSED 172\.\d+\.0\.\d+:5432/);
run(e, "docker compose restart api");
assert.match(run(e, "docker compose ps"), /orders-api-1.*Up/);
broken(e, "restarting by hand works only because db is ready by now");
e = fresh("composeorder");
run(e, "sed -i 's/    restart: no//' compose.yaml");
e.writeFile("/home/dev/orders/compose.yaml", e.host["/home/dev/orders/compose.yaml"].text.replace("    ports:", "    restart: always\n    ports:"));
run(e, "docker compose up -d && docker ps && docker ps && docker ps && docker ps && docker ps && docker ps");
assert.match(run(e, "docker compose ps"), /orders-api-1.*Up/);
broken(e, "restart: always recovers eventually, but still starts too early");
e = fresh("composeorder");
e.writeFile("/home/dev/orders/compose.yaml", ORDERS_FIXED);
assert.match(run(e, "docker compose up -d"), /orders-db-1\s+Healthy/);
fixed(e, "composeorder: healthcheck and service_healthy");
assert.match(run(e, "docker compose config"), /condition: service_healthy/);

// Compose: DB_PASSWORD not set.
e = fresh("composeenv");
assert.match(run(e, "docker compose up -d"), /WARN\[0000\] The "DB_PASSWORD" variable is not set\. Defaulting to a blank string\.[\s\S]*dependency failed to start: container orders-db-1 exited \(1\)/);
assert.match(run(e, "docker compose logs db"), /superuser password is not specified/);
e.writeFile("/home/dev/orders/compose.yaml", e.host["/home/dev/orders/compose.yaml"].text.replace(/\$\{DB_PASSWORD\}/g, "hunter2hunter2"));
run(e, "docker compose up -d");
broken(e, "a password written into compose.yaml ends up in git");
e = fresh("composeenv");
run(e, "echo 'DB_PASSWORD=long-practice-value' > .env && docker compose up -d");
fixed(e, "composeenv: a .env file");
e = fresh("composeenv");
run(e, "export DB_PASSWORD=long-practice-value && docker compose up -d");
fixed(e, "composeenv: or a shell variable");
assert.match(run(e, "docker compose exec db pg_isready"), /accepting connections/);
assert.match(run(e, "docker compose down -v"), /Volume orders_db-data\s+Removed/);

// The daemon will not start: a trailing comma in daemon.json.
e = fresh("daemon");
assert.match(run(e, "docker ps"), /^Cannot connect to the Docker daemon at unix:\/\/\/var\/run\/docker\.sock\. Is the docker daemon running\?$/);
assert.match(run(e, "sudo journalctl -u docker"), /invalid character '}' looking for beginning of object key string/);
assert.match(run(e, "sudo systemctl restart docker"), /Job for docker\.service failed/);
broken(e, "restarting without fixing the file fails again");
assert.match(run(e, "systemctl start docker"), /Access denied/);
run(e, "sudo rm /etc/docker/daemon.json && sudo systemctl start docker");
assert.match(run(e, "docker ps"), /web/);
broken(e, "deleting daemon.json loses the log rotation");
e = fresh("daemon");
run(e, "sudo sed -i 's/},$/}/' /etc/docker/daemon.json && sudo systemctl start docker");
fixed(e, "daemon: valid JSON, rotation kept, web restarted by its policy");
run(e, "docker run -d --name w2 nginx:1.27");
assert.match(run(e, "docker inspect w2 --format '{{json .HostConfig.LogConfig}}'"), /"max-size":"10m"/);

// Permission denied on the Docker socket.
e = fresh("socket");
assert.match(run(e, "docker ps"), /permission denied while trying to connect to the Docker daemon socket at unix:\/\/\/var\/run\/docker\.sock/);
assert.match(run(e, "sudo docker ps"), /CONTAINER ID/);
broken(e, "sudo works, but is not the goal");
assert.match(run(e, "usermod -aG docker dev"), /Permission denied/);
run(e, "sudo usermod -aG docker dev");
assert.match(run(e, "docker ps"), /permission denied/);
broken(e, "the new group needs a new login or newgrp");
run(e, "newgrp docker");
fixed(e, "socket: in the docker group");
e = fresh("socket");
run(e, "sudo chmod 666 /var/run/docker.sock");
assert.match(run(e, "docker ps"), /CONTAINER ID/);
broken(e, "a world-writable socket gives every user root");

// Arguments after the image replace CMD.
e = fresh("args");
assert.match(run(e, "docker logs shop"), /^node: bad option: --verbose$/);
assert.match(run(e, "docker ps -a"), /Exited \(9\)/);
run(e, "docker rm shop && docker run -d --name shop -p 3000:3000 quest/shop:1.0");
assert.match(run(e, "curl localhost:3000"), /shop: ok/);
broken(e, "dropping --verbose loses the detail ops wanted");
run(e, "docker rm -f shop && docker run -d --name shop -p 3000:3000 quest/shop:1.0 node --verbose server.js");
broken(e, "node itself does not know --verbose");
run(e, "docker rm -f shop && docker run -d --name shop -p 3000:3000 quest/shop:1.0 node server.js --verbose");
fixed(e, "args: the whole command, with the app's flag after the script");
e = fresh("args");
run(e, "docker rm shop && docker run -d --name shop -p 3000:3000 -e LOG_LEVEL=debug quest/shop:1.0");
fixed(e, "args: or the app's own setting");

// Entrypoint script without the executable bit.
e = fresh("noexec");
assert.match(run(e, "docker start shop"), /exec: "\/app\/start\.sh": permission denied: unknown/);
run(e, "docker rm shop && docker run -d --name shop -u root --privileged -p 3000:3000 quest/shop:1.0");
broken(e, "root cannot execute a file without an x bit either");
run(e, "docker rm -f shop && docker run -d --name shop -p 3000:3000 --entrypoint node quest/shop:1.0 server.js");
assert.match(run(e, "curl localhost:3000"), /shop: ok/);
broken(e, "bypassing start.sh skips what it is there to do");
e = fresh("noexec");
run(e, "chmod +x start.sh && docker build -t quest/shop:1.1 . && docker rm shop && docker run -d --name shop -p 3000:3000 quest/shop:1.1");
fixed(e, "noexec: executable script");
e = fresh("noexec");
run(e, "sed -i 's#COPY . .#COPY --chmod=755 . .#' Dockerfile && docker build -t quest/shop:1.1 . && docker rm shop && docker run -d --name shop -p 3000:3000 quest/shop:1.1");
fixed(e, "noexec: COPY --chmod");

// A published database port bypasses ufw.
e = fresh("exposed");
assert.match(run(e, "docker ps"), /0\.0\.0\.0:5432->5432\/tcp.*db/);
assert.match(run(e, "sudo ufw deny 5432"), /Rule added/);
broken(e, "ufw cannot close a port Docker publishes");
assert.match(run(e, "sudo iptables -L DOCKER -n"), /ACCEPT\s+tcp\s+--\s+0\.0\.0\.0\/0\s+172\.\d+\.0\.\d+\s+tcp dpt:5432/);
run(e, "docker rm -f db && docker run -d --name db --network app-net -e POSTGRES_PASSWORD=kitchen-practice postgres:17");
broken(e, "without the volume the data is gone");
e = fresh("exposed");
run(e, "docker rm -f db && docker run -d --name db --network app-net -e POSTGRES_PASSWORD=kitchen-practice -v pgdata:/var/lib/postgresql/data postgres:17");
fixed(e, "exposed: no published port, same volume");
e = fresh("exposed");
run(e, "docker rm -f db && docker run -d --name db --network app-net -p 127.0.0.1:5432:5432 -e POSTGRES_PASSWORD=kitchen-practice -v pgdata:/var/lib/postgresql/data postgres:17");
fixed(e, "exposed: or bound to the host's loopback only");

// Reaching a service on the host from a container on Linux.
e = fresh("hostgateway");
assert.match(run(e, "docker logs api"), /ENOTFOUND host\.docker\.internal/);
assert.match(run(e, "ss -ltn"), /0\.0\.0\.0:6379/);
run(e, "docker rm api && docker run -d --name api -p 8080:8080 -e REDIS_HOST=localhost quest/api:1.0");
broken(e, "localhost is the container");
run(e, "docker rm -f api && docker run -d --name api --network host -e REDIS_HOST=localhost quest/api:1.0");
assert.match(run(e, "docker logs api"), /redis says PONG/);
broken(e, "host networking gives up the container's network");
run(e, "docker rm -f api && docker run -d --name api -p 8080:8080 --add-host=host.docker.internal:host-gateway -e REDIS_HOST=host.docker.internal quest/api:1.0");
fixed(e, "hostgateway: host-gateway");
assert.match(run(e, "docker inspect api --format '{{.HostConfig.ExtraHosts}}'"), /\[host\.docker\.internal:172\.17\.0\.1\]/);

// A major PostgreSQL upgrade through the image tag.
e = fresh("pgupgrade");
assert.match(run(e, "docker logs db"), /FATAL:  database files are incompatible with server[\s\S]*initialized by PostgreSQL version 16, which is not compatible with this version 17/);
run(e, "docker restart db");
broken(e, "a restart does not change the version");
run(e, "docker rm db && docker run -d --name db -e POSTGRES_PASSWORD=kitchen-practice -v pgdata:/var/lib/postgresql/data postgres:latest");
broken(e, "latest is 17 too");
run(e, "docker rm -f db && docker volume rm pgdata && docker run -d --name db -e POSTGRES_PASSWORD=kitchen-practice -v pgdata:/var/lib/postgresql/data postgres:17");
assert.match(run(e, "docker ps"), /Up .*db/);
broken(e, "a new empty database is not the data");
e = fresh("pgupgrade");
run(e, "docker rm db && docker run -d --name db -e POSTGRES_PASSWORD=kitchen-practice -v pgdata:/var/lib/postgresql/data postgres:16");
fixed(e, "pgupgrade: back on the version that owns the data");
assert.match(run(e, "docker-compose up -d"), /use docker compose \(with a space\)/);

const SHOP_SRC = 'const express = require("express");\nconst app = express();\nconst server = app.listen(3000);\n';
// docker stop waits 10 seconds: PID 1 ignores SIGTERM without a handler.
e = fresh("sigterm");
assert.match(run(e, "docker stop shop"), /^shop\n\(Docker waited 10s for shop to exit after SIGTERM, then sent SIGKILL\)$/);
assert.match(run(e, "docker ps -a"), /Exited \(137\)/);
broken(e, "the default stop ends in SIGKILL");
run(e, "docker start shop && docker stop -t 1 shop");
broken(e, "a shorter timeout only kills it sooner");
run(e, "docker start shop && docker kill -s TERM shop");
assert.match(run(e, "docker ps"), /Up .*shop/);
run(e, "docker kill shop");
broken(e, "SIGKILL is not a clean shutdown");
run(e, "docker rm shop && docker run -d --init --name shop -p 3000:3000 quest/shop:1.0 && docker stop shop");
assert.match(run(e, "docker ps -a"), /Exited \(143\)/);
fixed(e, "sigterm: --init forwards the signal");
e = fresh("sigterm");
e.writeFile("/home/dev/shop/server.js", SHOP_SRC + 'process.on("SIGTERM", () => server.close(() => process.exit(0)));\n');
run(e, "docker build -t quest/shop:1.1 . && docker rm -f shop && docker run -d --name shop -p 3000:3000 quest/shop:1.1 && docker stop shop");
assert.match(run(e, "docker logs shop"), /SIGTERM received/);
fixed(e, "sigterm: the app handles SIGTERM");
assert.match(run(e, "docker run -d --name ng nginx:1.27 && docker stop ng && docker ps -a"), /Exited \(0\).*\bng$/m);

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
assert.match(run(e, "docker compose up -d"), /no configuration file provided: not found/);
assert.match(run(e, "docker push quest/site:1.0"), /Lab/);
e = fresh("bigimage");
e.writeFile("/home/dev/shop/Dockerfile", "FROM node:22\nCOPPY . .\n");
assert.match(run(e, "docker build ."), /dockerfile parse error on line 2: unknown instruction: COPPY/);
e.writeFile("/home/dev/shop/Dockerfile", "FROM node:22-alpine\nWORKDIR /app\nCOPY package.json ./\nRUN npm ci\n");
assert.match(run(e, "docker build ."), /npm error The `npm ci` command can only install with an existing package-lock\.json[\s\S]*did not complete successfully: exit code: 1/);
e.writeFile("/home/dev/shop/Dockerfile", "FROM node:22-alpine AS deps\nCOPY --from=deps /a /b\n");
assert.match(run(e, "docker build ."), /circular dependency detected on stage: deps/);
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
// A Lab command, run anywhere in the playground, says it needs a real host or fails.
const labOnly = (id, cmd) => { const e2 = fresh(id); return shell(e2, fillBlanks(e2, cmd)).some(([, k]) => k === "na" || k === "warn"); };
for (const [cmd, , , where] of Q.cheats) {
  if (where) assert.ok(runsIn(where === "any" ? "exits" : where, cmd), `cheat sheet: "${cmd}" should run in ${where}`);
  else assert.ok(SCENARIOS.every((s) => labOnly(s.id, cmd)), `cheat sheet: "${cmd}" now runs in the playground; give it a Try`);
}

// Scenarios name real levels, and references link only to scenarios that exist.
const ids = new Set(SCENARIOS.map((x) => x.id));
for (const s of SCENARIOS) assert.ok(Q.levels.some((l) => l.id === s.level), `${s.id}: level ${s.level} exists`);
for (const d of Q.doctor) for (const id of d.scenarios || []) assert.ok(ids.has(id), `doctor "${d.status}" links to unknown scenario ${id}`);
for (const lv of Q.levels) for (const id of lv.practise || []) assert.ok(ids.has(id), `level ${lv.id} links to unknown scenario ${id}`);
for (const c of Q.architecture.components) for (const id of c.practise) assert.ok(ids.has(id), `architecture ${c.id} links to unknown scenario ${id}`);
for (const id of ids) assert.ok(Q.doctor.some((d) => (d.scenarios || []).includes(id)), `scenario ${id} has a troubleshooting entry`);

console.log(`playground ok: ${SCENARIOS.length} scenarios, ${Q.cheats.length} cheat sheet rows`);
