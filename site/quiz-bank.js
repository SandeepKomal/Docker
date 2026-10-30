// Question bank for the Docker Quest quiz: q, options, answer (index), why. Plain data, no logic.
"use strict";
window.QUEST_QUIZ = {
  "00": [
    { q: "What is the difference between an image and a container?",
      options: [
        "They are two names for the same thing",
        "An image is a read-only template; a container is a running (or stopped) instance of it with its own writable layer",
        "A container is a compressed image ready to upload",
        "An image runs on the host; a container runs in a virtual machine"
      ], answer: 1,
      why: "An image is a stack of read-only layers plus a config. `docker run` adds a thin writable layer and starts a process: that is the container. One image can run as many containers." },
    { q: "You ran `docker run -d --name web nginx:1.27`. Which command shows what nginx printed while starting?",
      options: [
        "`docker inspect web`",
        "`docker logs web`",
        "`docker attach web --history`",
        "`docker ps --verbose`"
      ], answer: 1,
      why: "`docker logs` shows everything the main process wrote to stdout and stderr, which is where well-built images send their logs." },
    { q: "`docker ps` shows nothing, yet you started a container a minute ago. What is the first thing to run?",
      options: [
        "`docker restart` on every container",
        "`docker ps -a`, which also lists stopped containers with their exit codes",
        "`docker system prune`",
        "Reinstall Docker"
      ], answer: 1,
      why: "`docker ps` lists only running containers. `docker ps -a` shows the one that exited, with a STATUS like Exited (1) that tells you where to look next." },
    { q: "`docker ps` says permission denied on /var/run/docker.sock, but `sudo docker ps` works. What is the safe fix?",
      options: [
        "`sudo chmod 666 /var/run/docker.sock`",
        "Add your user to the docker group, then start a new login session (or `newgrp docker`)",
        "Always use sudo",
        "Reinstall Docker"
      ], answer: 1,
      why: "The socket is owned by root and the docker group. Joining the group grants access (it is root-equivalent, so grant it deliberately); chmod 666 would give every user on the machine control of Docker." }
  ],
  "01": [
    { q: "Why do teams pin `node:22.11.0-alpine` or a digest instead of `node:latest` in production?",
      options: [
        "`latest` is always the oldest version",
        "`latest` is just a tag that moves; a pinned tag or digest gives the same image on every build and every host",
        "Pinned tags download faster",
        "Docker refuses to run `latest` in production"
      ], answer: 1,
      why: "`latest` is an ordinary tag that the publisher moves. Two builds a week apart can get different images. A digest (`@sha256:...`) always means the same content." },
    { q: "`docker pull ngnix` fails with `pull access denied for ngnix, repository does not exist`. What is the most likely cause?",
      options: [
        "You need `docker login` for every public image",
        "A typo in the image name",
        "The registry is down",
        "Your disk is full"
      ], answer: 1,
      why: "Docker Hub answers a missing repository and a private one the same way. Check the spelling first (nginx), then whether the repository is private." },
    { q: "Two images are both built `FROM node:22-alpine`. How much disk do the base layers use?",
      options: [
        "Twice, once per image",
        "Once: layers are stored by content and shared",
        "Nothing, base layers stay in the registry",
        "It depends on which image was pulled first"
      ], answer: 1,
      why: "Layers are content-addressed. Identical layers are stored once and shared, which is why `docker system df` can be smaller than the sum of `docker images`." },
    { q: "You re-create a container from `kitchen/shop:latest`, but it still runs last week's version. Why?",
      options: [
        "Docker caches containers, not images",
        "`docker run` uses the local image for that tag and never checks the registry for a newer one",
        "The registry is down",
        "latest always means the oldest version"
      ], answer: 1,
      why: "A tag is a pointer. Your machine keeps what it last pulled until you `docker pull` (or use `docker run --pull always`). Deploy immutable version tags or digests instead." }
  ],
  "02": [
    { q: "A container runs `nginx` and shows Exited (0) a second later. Why?",
      options: [
        "nginx crashed",
        "nginx daemonised itself, so PID 1 returned and the container ended",
        "Port 80 was taken",
        "The image is corrupt"
      ], answer: 1,
      why: "A container lives as long as its main process. nginx forks to the background unless told `daemon off;`, which the image's default command does for you." },
    { q: "Exit code 137 means:",
      options: [
        "The image was not found",
        "The process was killed with SIGKILL (128 + 9), often by the OOM killer",
        "A syntax error in the Dockerfile",
        "The container exited normally"
      ], answer: 1,
      why: "Exit codes above 128 mean a signal: 137 is signal 9. Check `docker inspect --format '{{.State.OOMKilled}}'` to see whether the memory limit was the cause." },
    { q: "A container exits with code 1 on every start. A teammate adds `--restart always`. What happens?",
      options: [
        "It is fixed",
        "It restarts in a loop and keeps failing, now harder to notice",
        "Docker refuses the flag",
        "It runs once more and then stays up"
      ], answer: 1,
      why: "Restart policies restart a process; they do not fix why it fails. Read `docker logs` and fix the cause." },
    { q: "`docker run shop:1.0 --verbose` exits with `node: bad option: --verbose`. Why?",
      options: [
        "The image is broken",
        "Arguments after the image replace CMD entirely, so node received only --verbose",
        "Docker does not allow flags after the image",
        "--verbose needs -e"
      ], answer: 1,
      why: "CMD was `node server.js`. Anything after the image name replaces it, and the node image's entrypoint runs `node --verbose`. Pass the whole command, or put the fixed part in ENTRYPOINT." }
  ],
  "03": [
    { q: "What is the difference between `CMD [\"node\", \"server.js\"]` and `CMD node server.js`?",
      options: [
        "None",
        "The exec form runs node as PID 1 and it receives signals; the shell form runs it under /bin/sh -c, which does not forward SIGTERM",
        "The shell form is faster",
        "Only the exec form can read environment variables"
      ], answer: 1,
      why: "With the shell form, PID 1 is the shell. `docker stop` sends SIGTERM to the shell, the app never sees it, and Docker kills everything 10 seconds later." },
    { q: "What does `WORKDIR /app` do?",
      options: [
        "Mounts a volume at /app",
        "Sets (and creates if needed) the directory for later RUN, COPY, CMD and ENTRYPOINT instructions",
        "Copies the build context to /app",
        "Makes /app read-only"
      ], answer: 1,
      why: "WORKDIR is the Dockerfile's cd that sticks. Prefer it to `RUN cd /app && ...`, which only lasts for that one RUN." },
    { q: "You add `EXPOSE 3000` to a Dockerfile. What changes when the container runs?",
      options: [
        "Port 3000 is published on the host",
        "Nothing is published; it documents the port and lets `-P` pick it",
        "The app is forced to listen on 3000",
        "A firewall rule opens 3000"
      ], answer: 1,
      why: "EXPOSE is metadata. Only `-p host:container` (or `-P`) publishes a port on the host." },
    { q: "`docker build` fails with `\"/dist\": not found`, yet `ls dist` shows the folder. What do you check first?",
      options: [
        "Disk space",
        "The .dockerignore file: an excluded path never reaches the builder",
        "File permissions",
        "The base image"
      ], answer: 1,
      why: "COPY reads from the build context that Docker sends, and .dockerignore decides what is in it. A pattern such as dist removes the folder, whatever is on your disk." }
  ],
  "04": [
    { q: "Why put `COPY package*.json ./` and `RUN npm ci` before `COPY . .`?",
      options: [
        "npm requires it",
        "So a change to your source code does not break the cache for the dependency install",
        "To make the image smaller",
        "So that .dockerignore applies"
      ], answer: 1,
      why: "A step's cache is reused while its instruction and inputs are unchanged. Copying only the dependency files first means the install reruns only when they change." },
    { q: "In a build, step 3 is not cached. What happens to steps 4 and later?",
      options: [
        "They are still cached if their instructions did not change",
        "They all run again, because each layer builds on the one before",
        "Only RUN steps run again",
        "The build fails"
      ], answer: 1,
      why: "Each layer's cache key includes its parent. Once one step misses, every step after it rebuilds." },
    { q: "`RUN apt-get update` is on its own line, and `RUN apt-get install -y curl` on the next. Months later you add a package to the install line. What can go wrong?",
      options: [
        "Nothing",
        "The update step comes from the old cache, so install uses stale package lists and can fail or get old versions",
        "apt-get refuses to run twice",
        "The image doubles in size"
      ], answer: 1,
      why: "Keep `apt-get update && apt-get install ... && rm -rf /var/lib/apt/lists/*` in one RUN so they are cached, and invalidated, together." },
    { q: "Which change makes `docker build` reuse the dependency install after a one-line source edit?",
      options: [
        "`--no-cache`",
        "Copy package*.json, run the install, and only then COPY the rest of the source",
        "Use ADD instead of COPY",
        "Put the install after COPY . ."
      ], answer: 1,
      why: "The install step's cache depends only on the files copied before it. When those are just the dependency files, source edits leave it CACHED." }
  ],
  "05": [
    { q: "A Node image is 1.6 GB. `docker history` shows `COPY . .` adding 310 MB. What helps most with that layer?",
      options: [
        "`docker image prune`",
        "A .dockerignore that excludes .git, node_modules and logs",
        "Building with `--squash`",
        "Compressing the image"
      ], answer: 1,
      why: "COPY . . copies the whole build context. A .dockerignore keeps what the image does not need out of the context, the layer and the upload to the builder." },
    { q: "Why does `RUN rm -rf /tmp/big` in a later step not make the image smaller?",
      options: [
        "rm does not work in Docker",
        "Layers are additive: the earlier layer still contains the files; the later one only hides them",
        "Docker caches deletes",
        "It does, by the full size"
      ], answer: 1,
      why: "Delete in the same RUN that created the files, or use a multi-stage build and copy only what you need into the final stage." },
    { q: "What does a multi-stage build give you?",
      options: [
        "Faster pulls from the registry",
        "A build stage with compilers and dev dependencies, and a final image that copies only the runtime artifacts from it",
        "Several images from one tag",
        "Parallel containers"
      ], answer: 1,
      why: "`COPY --from=build` takes only the files you name. Tools, caches and source left in the build stage never reach the image you ship." },
    { q: "A two-stage build still produces a 350 MB Node image. Which is the likely leftover?",
      options: [
        "The final stage copies node_modules built with dev dependencies",
        "Multi-stage builds do not reduce size",
        "EXPOSE adds size",
        "The image has too many labels"
      ], answer: 0,
      why: "Only what you copy reaches the final stage, so copy production dependencies (`npm ci --omit=dev`, or `npm prune --omit=dev` in the build stage), not the full install." }
  ],
  "06": [
    { q: "nginx listens on 80 inside the container. Which flag makes it reachable at localhost:8080?",
      options: [
        "`-p 80:8080`",
        "`-p 8080:80`",
        "`--expose 8080`",
        "`-P 8080`"
      ], answer: 1,
      why: "The order is host:container. `-p 8080:80` forwards your machine's port 8080 to the container's port 80." },
    { q: "`curl localhost:8080` says `Connection reset by peer`. Docker shows `0.0.0.0:8080->8080/tcp`. What is wrong?",
      options: [
        "The port is not published",
        "It is published to container port 8080, but the app listens on another port inside",
        "The firewall blocks 8080",
        "curl needs https"
      ], answer: 1,
      why: "Docker accepted the connection and forwarded it to a container port where nothing listens. Match the right side of -p to the port the app really uses." },
    { q: "How do you add a published port to a container that is already running?",
      options: [
        "`docker update -p 8080:80 web`",
        "You cannot: remove it and run a new container with the port",
        "`docker port web 8080:80`",
        "Restart Docker"
      ], answer: 1,
      why: "Port mappings are fixed at creation. Containers are meant to be replaced, so keep the run command (or a compose file) and recreate." },
    { q: "The app logs `listening on 127.0.0.1:3000` and `-p 3000:3000` is set, but curl gets `Connection reset by peer`. Why?",
      options: [
        "The port is not published",
        "127.0.0.1 inside the container accepts only connections from inside it; published traffic arrives on the container's own interface",
        "curl needs -k",
        "The firewall"
      ], answer: 1,
      why: "Make the server listen on 0.0.0.0 in the container. To keep the port private, publish it as `-p 127.0.0.1:3000:3000` on the host instead." }
  ],
  "07": [
    { q: "Two containers started with plain `docker run` cannot reach each other by name. Why?",
      options: [
        "Containers never talk to each other",
        "They are on the default bridge, which has no DNS for container names",
        "Names only work with `--privileged`",
        "Ping is disabled in containers"
      ], answer: 1,
      why: "User-defined networks run Docker's DNS at 127.0.0.11 and resolve container names. The default bridge only offers IP addresses and the legacy --link." },
    { q: "What does `docker network connect app-net api` do to a running container?",
      options: [
        "Restarts it",
        "Adds a second network interface on app-net, live, with an IP and DNS name there",
        "Moves it off its old network",
        "Nothing until the next restart"
      ], answer: 1,
      why: "A container can be on several networks at once. Connecting adds an interface immediately; disconnecting removes it." },
    { q: "Why not just put the other container's IP address in the configuration?",
      options: [
        "IPs do not work inside containers",
        "IP addresses change when containers are recreated; names stay the same",
        "IPs are slower than names",
        "Docker blocks IPs"
      ], answer: 1,
      why: "Container IPs are assigned on start from the network's pool. Use names on a user-defined network, which Compose sets up for you." },
    { q: "On a Linux server, a container cannot resolve `host.docker.internal` to reach a service on the host. What fixes it?",
      options: [
        "`--network none`",
        "`--add-host=host.docker.internal:host-gateway`",
        "Using localhost",
        "Restarting Docker"
      ], answer: 1,
      why: "Docker Desktop defines host.docker.internal; Docker Engine on Linux adds it only when asked. localhost would be the container itself." }
  ],
  "08": [
    { q: "You run `-v $(pwd):/app` and the app now fails with `Cannot find module 'express'`, although the image installed it. Why?",
      options: [
        "The image is broken",
        "The bind mount lays your folder over /app and hides the image's node_modules",
        "npm needs network access",
        "Volumes are read-only"
      ], answer: 1,
      why: "A mount replaces what the image had at that path. Add a volume for the inner path (`-v /app/node_modules`) so the image's modules show through." },
    { q: "When does Docker copy the image's files into a volume?",
      options: [
        "Every time a container starts",
        "When a new, empty volume is mounted on a path where the image has files",
        "Never",
        "Only for bind mounts"
      ], answer: 1,
      why: "An empty named or anonymous volume is filled from the image on first use. Bind mounts are never filled: you see exactly the host folder." },
    { q: "What happens to a named volume when you `docker rm` the container that used it?",
      options: [
        "It is deleted",
        "It stays until you remove it with `docker volume rm` or a prune",
        "It is moved into the image",
        "It is archived"
      ], answer: 1,
      why: "Volumes outlive containers on purpose. Anonymous volumes are removed by `docker rm -v` or by `--rm`; named ones only when you remove them." },
    { q: "redis is re-created with `docker rm -f cache && docker run -d --name cache redis:7.4` and its data is gone. Why?",
      options: [
        "Redis does not save data",
        "The image's VOLUME /data gives each new container a new anonymous volume",
        "docker rm deletes all volumes",
        "The data was in /tmp"
      ], answer: 1,
      why: "Anonymous volumes are not reused by name. Mount a named volume (`-v redis-data:/data`) so the next container finds the same data." }
  ],
  "09": [
    { q: "A container runs as uid 10001 and cannot write to a bind-mounted folder owned by root with mode 755. Which fix keeps it secure?",
      options: [
        "`chmod 777` the folder",
        "Run the container as root",
        "`chown` the folder to 10001 (or a group the container's user is in)",
        "Add `--privileged`"
      ], answer: 2,
      why: "Ownership is checked by number. Give the folder to the container's UID. chmod 777 lets anyone write; root and --privileged throw away the hardening." },
    { q: "Why does `chown app:app /srv/data` fail on the host when the image has a user called app?",
      options: [
        "chown needs Docker",
        "The host has no user called app; users inside the image are not users on the host",
        "The folder is mounted",
        "app is a reserved name"
      ], answer: 1,
      why: "Names live in each system's /etc/passwd. The kernel only sees numbers, so use the UID: `docker run --rm <image> id` tells you which." },
    { q: "Why do security guides say to add a USER instruction?",
      options: [
        "It makes builds faster",
        "Without it the app runs as root, so a compromise of the app is a root process in the container",
        "Docker requires it",
        "It enables networking"
      ], answer: 1,
      why: "Root in a container is still root on files it can reach and closer to the kernel. Run as an unprivileged user and add privileges only where needed." },
    { q: "An image runs as uid 10001. Which command shows that without reading the Dockerfile?",
      options: [
        "`docker ps`",
        "`docker run --rm --entrypoint id <image>`",
        "`docker logs`",
        "`docker port`"
      ], answer: 1,
      why: "Running `id` in the image prints the effective uid and gid, which is what file ownership on mounts is compared against." }
  ],
  "10": [
    { q: "In a Compose file, how does the springboot service reach the mysql service?",
      options: [
        "By the host's IP address",
        "By the service name mysql, on the network Compose creates for the project",
        "Through a published port only",
        "With --link"
      ], answer: 1,
      why: "Compose puts every service on a project network with DNS, so service names are hostnames." },
    { q: "What does `depends_on: [mysql]` guarantee?",
      options: [
        "mysql is ready to accept connections first",
        "mysql's container is started first, not that the database is ready",
        "springboot restarts if mysql fails",
        "Both share a volume"
      ], answer: 1,
      why: "Plain depends_on orders the start only. Add a healthcheck with `condition: service_healthy`, and have the app retry." },
    { q: "Where should the database password in a Compose setup come from?",
      options: [
        "Written into compose.yaml",
        "An environment variable or secret supplied when it runs, never committed",
        "The image",
        "A comment in the Dockerfile"
      ], answer: 1,
      why: "The repository's compose file reads `${MYSQL_PASSWORD}` from the environment, so no real password is stored in git." },
    { q: "`docker compose up` prints `The \"DB_PASSWORD\" variable is not set. Defaulting to a blank string.` What is the right fix?",
      options: [
        "Write the password into compose.yaml",
        "Supply it from a .env file kept out of git, or from the shell",
        "Ignore it",
        "Use docker-compose v1"
      ], answer: 1,
      why: "Compose fills ${DB_PASSWORD} from the shell and from .env beside the file. Keep the value out of git; `${DB_PASSWORD:?}` makes a missing value stop the start." }
  ],
  "11": [
    { q: "What does `depends_on: [db]` wait for in Compose?",
      options: [
        "db to accept connections",
        "db's container to start, not its readiness",
        "db to be healthy",
        "Nothing"
      ], answer: 1,
      why: "Plain depends_on orders container starts. Give db a healthcheck and use `condition: service_healthy` to wait for readiness." },
    { q: "A container shows `(unhealthy)` but answers requests. Its check is `curl -f http://localhost:3000/` in an alpine image. Why?",
      options: [
        "The app is slow",
        "alpine has no curl, so the check itself fails",
        "Healthchecks only work in Compose",
        "Port 3000 is not published"
      ], answer: 1,
      why: "The check runs inside the container with that image's tools. Use wget (BusyBox has it) or install curl. `docker inspect --format '{{json .State.Health}}'` shows the check's output." },
    { q: "A worker shows `Restarting (1)` every few seconds with `--restart always`. What does the policy tell you?",
      options: [
        "It is healthy",
        "Its process keeps exiting with code 1; the policy only hides the crash",
        "The host is out of memory",
        "Docker is restarting"
      ], answer: 1,
      why: "Read `docker logs` to find why it exits, fix the cause and re-create the container. Restart policies keep healthy services up; they cannot fix broken ones." },
    { q: "After a host reboot, which containers start again by themselves?",
      options: [
        "All of them",
        "Those with restart policy always, or unless-stopped that were not stopped by hand",
        "Only Compose services",
        "None"
      ], answer: 1,
      why: "The daemon restarts containers according to their policy. `no` (the default) never restarts; unless-stopped respects a manual `docker stop`." }
  ],
  "12": [
    { q: "A container with `--memory 128m` loads 300 MB of data. What happens?",
      options: [
        "It swaps to disk and slows down",
        "The kernel kills it: Exited (137), OOMKilled true",
        "Docker raises the limit",
        "It keeps running at 128 MB"
      ], answer: 1,
      why: "The memory cgroup enforces the limit. Without enough swap allowance, the OOM killer ends the process." },
    { q: "`docker update --memory 512m report` fails with `Memory limit should be smaller than already set memoryswap limit`. What should you run?",
      options: [
        "`docker update --memory 512m --memory-swap 512m report`",
        "`docker restart report`",
        "`docker update --oom-kill-disable report`",
        "Recreate Docker"
      ], answer: 0,
      why: "The container already has a swap limit (twice the old memory limit). Set both together so memory is not above memory plus swap." },
    { q: "How should you choose a memory limit?",
      options: [
        "As low as possible to save money",
        "Measure real use under load with `docker stats`, then add headroom",
        "Always 1 GB",
        "Leave it unlimited"
      ], answer: 1,
      why: "A limit protects the host from one runaway container; too low and it kills a healthy app. Size it from measurements." },
    { q: "`docker run --memory 512` fails with `Minimum memory limit allowed is 6MB`. Why?",
      options: [
        "512 MB is too small",
        "Without a unit the value is bytes",
        "Memory limits need --memory-swap",
        "The host has no cgroups"
      ], answer: 1,
      why: "Always give a unit: `--memory 512m`. Docker reads a bare number as bytes." }
  ],
  "13": [
    { q: "`df -h` shows the disk 90% full, but `docker system df` shows little. Where should you look next?",
      options: [
        "Volumes only",
        "Container logs under /var/lib/docker/containers, which docker system df does not count",
        "The registry",
        "Swap"
      ], answer: 1,
      why: "The json-file driver keeps every line forever by default. `docker inspect --format '{{.LogPath}}'` and `du` find the big ones." },
    { q: "How do you stop a container's logs from growing forever?",
      options: [
        "`truncate` the file weekly",
        "`--log-opt max-size=10m --log-opt max-file=3`, or the local driver, or the same in daemon.json",
        "`--log-driver none`",
        "Restart it daily"
      ], answer: 1,
      why: "Rotation keeps logs readable and bounded. Turning logging off leaves you blind; truncating only buys time." },
    { q: "The build server is full. Which is safe to prune first?",
      options: [
        "`docker volume prune -a`",
        "The build cache and dangling images",
        "Every volume",
        "/var/lib/docker by hand"
      ], answer: 1,
      why: "Build cache and dangling images can be rebuilt. Volumes hold data that cannot; check them one by one." },
    { q: "`docker logs worker` says `configured logging driver does not support reading`. Why?",
      options: [
        "The container is stopped",
        "It runs with a driver such as none, syslog or gelf that docker logs cannot read",
        "Logs were rotated",
        "The daemon is down"
      ], answer: 1,
      why: "Only local, json-file and journald (or dual logging) can be read back. Re-create with a readable driver to see what happens." }
  ],
  "14": [
    { q: "`docker pull ghcr.io/team/app:2.1` says `unauthorized`, though you ran `docker login`. Why?",
      options: [
        "The tag does not exist",
        "Plain docker login logs in to Docker Hub; credentials are per registry",
        "GHCR blocks Docker",
        "The image is too big"
      ], answer: 1,
      why: "Log in to the registry the image names: `echo $TOKEN | docker login ghcr.io -u <user> --password-stdin`." },
    { q: "Shared CI runners start failing with `toomanyrequests` from Docker Hub. What helps?",
      options: [
        "Retry until it works",
        "Authenticate the pulls and mirror base images into your own registry",
        "Pull :latest instead",
        "Use a bigger runner"
      ], answer: 1,
      why: "Anonymous pulls are limited per IP address. Authenticated pulls have their own allowance, and a mirror avoids Docker Hub on every job." },
    { q: "An image built on an Apple-silicon laptop exits on the server with `exec format error`. Why?",
      options: [
        "The file is corrupt",
        "It was built for arm64 and the server is amd64",
        "The entrypoint is not executable",
        "The server lacks memory"
      ], answer: 1,
      why: "Build with `--platform linux/amd64`, or publish a multi-platform image with `docker buildx build --platform linux/amd64,linux/arm64 --push`." },
    { q: "postgres:16 data is started with postgres:17 and fails with `database files are incompatible with server`. What is the safe next step?",
      options: [
        "Delete the volume",
        "Go back to postgres:16, then upgrade deliberately with a dump and restore or pg_upgrade",
        "Use postgres:latest",
        "Run with --privileged"
      ], answer: 1,
      why: "A major version cannot open another major's files. Pin database images to a major version and upgrade on purpose, with a backup." }
  ],
  "15": [
    { q: "Why is `ENV DB_PASSWORD=...` in a Dockerfile a problem?",
      options: [
        "Environment variables are slow",
        "The value is stored in the image config and history, for anyone who can pull it",
        "Docker strips it",
        "It only works at build time"
      ], answer: 1,
      why: "Anything in ENV, ARG or a layer travels with the image. Pass secrets at run time, or use BuildKit `--mount=type=secret` during the build." },
    { q: "What does `--cap-drop ALL` do?",
      options: [
        "Removes all files",
        "Removes the Linux capabilities root normally has inside a container, so even root cannot do privileged operations",
        "Disables networking",
        "Limits CPU"
      ], answer: 1,
      why: "Capabilities split root's powers. Drop them all and add back only what the app proves it needs." },
    { q: "Why is mounting /var/run/docker.sock into a container risky?",
      options: [
        "It slows Docker down",
        "Whoever controls the container can start privileged containers and take over the host",
        "It breaks logs",
        "It uses too much memory"
      ], answer: 1,
      why: "The socket is full control of the Docker daemon, which runs as root. Treat access to it as root on the host." },
    { q: "A database runs with `-p 5432:5432` and ufw denies 5432, yet an external scan reaches it. Why?",
      options: [
        "ufw is broken",
        "Docker's own iptables rules for published ports are evaluated before ufw's",
        "Port scans ignore firewalls",
        "PostgreSQL opens the port itself"
      ], answer: 1,
      why: "Do not publish internal services: reach them over a Docker network, or bind with `-p 127.0.0.1:5432:5432`." }
  ],
  "16": [
    { q: "The disk is full. What should you run first?",
      options: [
        "`docker system prune -a --volumes`",
        "`docker system df` to see whether images, containers, volumes or build cache use the space",
        "Delete /var/lib/docker by hand",
        "Reboot"
      ], answer: 1,
      why: "Measure first. Then prune the category that is big, knowing that volumes can hold data you still need." },
    { q: "Which order of commands finds out why a container is not working?",
      options: [
        "restart, then rm, then run",
        "`docker ps -a`, then `docker logs`, then `docker inspect`",
        "pull, build, push",
        "prune, then run"
      ], answer: 1,
      why: "State and exit code, then what the app said, then how it was configured. Most problems are solved by the second step." },
    { q: "What does `docker image prune` remove without `-a`?",
      options: [
        "Every image",
        "Only dangling images: untagged layers left by rebuilds",
        "Images older than a week",
        "Images used by stopped containers"
      ], answer: 1,
      why: "Dangling images are the old versions a rebuild left behind. `-a` also removes every image that no container uses, which you may need to pull again." },
    { q: "Every docker command says `Cannot connect to the Docker daemon`. What do you run first?",
      options: [
        "Reinstall Docker",
        "`systemctl status docker` and `journalctl -u docker` to see why dockerd is not running",
        "`docker system prune`",
        "Reboot"
      ], answer: 1,
      why: "The CLI only reports that nothing answers on the socket. The daemon's own log names the reason, often an invalid /etc/docker/daemon.json." }
  ]
};
