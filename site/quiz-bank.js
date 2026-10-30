// Question bank for the Docker Quest quiz: q, options, answer (index), why. Plain data, no logic.
"use strict";
window.QUEST_QUIZ = {
  "00": [
    { q: "What is the difference between an image and a container?",
      options: ["They are two names for the same thing", "An image is a read-only template; a container is a running (or stopped) instance of it with its own writable layer", "A container is a compressed image ready to upload", "An image runs on the host; a container runs in a virtual machine"], answer: 1,
      why: "An image is a stack of read-only layers plus a config. `docker run` adds a thin writable layer and starts a process: that is the container. One image can run as many containers." },
    { q: "You ran `docker run -d --name web nginx:1.27`. Which command shows what nginx printed while starting?",
      options: ["`docker inspect web`", "`docker logs web`", "`docker attach web --history`", "`docker ps --verbose`"], answer: 1,
      why: "`docker logs` shows everything the main process wrote to stdout and stderr, which is where well-built images send their logs." },
    { q: "`docker ps` shows nothing, yet you started a container a minute ago. What is the first thing to run?",
      options: ["`docker restart` on every container", "`docker ps -a`, which also lists stopped containers with their exit codes", "`docker system prune`", "Reinstall Docker"], answer: 1,
      why: "`docker ps` lists only running containers. `docker ps -a` shows the one that exited, with a STATUS like Exited (1) that tells you where to look next." }
  ],
  "01": [
    { q: "Why do teams pin `node:22.11.0-alpine` or a digest instead of `node:latest` in production?",
      options: ["`latest` is always the oldest version", "`latest` is just a tag that moves; a pinned tag or digest gives the same image on every build and every host", "Pinned tags download faster", "Docker refuses to run `latest` in production"], answer: 1,
      why: "`latest` is an ordinary tag that the publisher moves. Two builds a week apart can get different images. A digest (`@sha256:...`) always means the same content." },
    { q: "`docker pull ngnix` fails with `pull access denied for ngnix, repository does not exist`. What is the most likely cause?",
      options: ["You need `docker login` for every public image", "A typo in the image name", "The registry is down", "Your disk is full"], answer: 1,
      why: "Docker Hub answers a missing repository and a private one the same way. Check the spelling first (nginx), then whether the repository is private." },
    { q: "Two images are both built `FROM node:22-alpine`. How much disk do the base layers use?",
      options: ["Twice, once per image", "Once: layers are stored by content and shared", "Nothing, base layers stay in the registry", "It depends on which image was pulled first"], answer: 1,
      why: "Layers are content-addressed. Identical layers are stored once and shared, which is why `docker system df` can be smaller than the sum of `docker images`." }
  ],
  "02": [
    { q: "A container runs `nginx` and shows Exited (0) a second later. Why?",
      options: ["nginx crashed", "nginx daemonised itself, so PID 1 returned and the container ended", "Port 80 was taken", "The image is corrupt"], answer: 1,
      why: "A container lives as long as its main process. nginx forks to the background unless told `daemon off;`, which the image's default command does for you." },
    { q: "Exit code 137 means:",
      options: ["The image was not found", "The process was killed with SIGKILL (128 + 9), often by the OOM killer", "A syntax error in the Dockerfile", "The container exited normally"], answer: 1,
      why: "Exit codes above 128 mean a signal: 137 is signal 9. Check `docker inspect --format '{{.State.OOMKilled}}'` to see whether the memory limit was the cause." },
    { q: "A container exits with code 1 on every start. A teammate adds `--restart always`. What happens?",
      options: ["It is fixed", "It restarts in a loop and keeps failing, now harder to notice", "Docker refuses the flag", "It runs once more and then stays up"], answer: 1,
      why: "Restart policies restart a process; they do not fix why it fails. Read `docker logs` and fix the cause." }
  ],
  "03": [
    { q: "What is the difference between `CMD [\"node\", \"server.js\"]` and `CMD node server.js`?",
      options: ["None", "The exec form runs node as PID 1 and it receives signals; the shell form runs it under /bin/sh -c, which does not forward SIGTERM", "The shell form is faster", "Only the exec form can read environment variables"], answer: 1,
      why: "With the shell form, PID 1 is the shell. `docker stop` sends SIGTERM to the shell, the app never sees it, and Docker kills everything 10 seconds later." },
    { q: "What does `WORKDIR /app` do?",
      options: ["Mounts a volume at /app", "Sets (and creates if needed) the directory for later RUN, COPY, CMD and ENTRYPOINT instructions", "Copies the build context to /app", "Makes /app read-only"], answer: 1,
      why: "WORKDIR is the Dockerfile's cd that sticks. Prefer it to `RUN cd /app && ...`, which only lasts for that one RUN." },
    { q: "You add `EXPOSE 3000` to a Dockerfile. What changes when the container runs?",
      options: ["Port 3000 is published on the host", "Nothing is published; it documents the port and lets `-P` pick it", "The app is forced to listen on 3000", "A firewall rule opens 3000"], answer: 1,
      why: "EXPOSE is metadata. Only `-p host:container` (or `-P`) publishes a port on the host." }
  ],
  "04": [
    { q: "Why put `COPY package*.json ./` and `RUN npm ci` before `COPY . .`?",
      options: ["npm requires it", "So a change to your source code does not break the cache for the dependency install", "To make the image smaller", "So that .dockerignore applies"], answer: 1,
      why: "A step's cache is reused while its instruction and inputs are unchanged. Copying only the dependency files first means the install reruns only when they change." },
    { q: "In a build, step 3 is not cached. What happens to steps 4 and later?",
      options: ["They are still cached if their instructions did not change", "They all run again, because each layer builds on the one before", "Only RUN steps run again", "The build fails"], answer: 1,
      why: "Each layer's cache key includes its parent. Once one step misses, every step after it rebuilds." },
    { q: "`RUN apt-get update` is on its own line, and `RUN apt-get install -y curl` on the next. Months later you add a package to the install line. What can go wrong?",
      options: ["Nothing", "The update step comes from the old cache, so install uses stale package lists and can fail or get old versions", "apt-get refuses to run twice", "The image doubles in size"], answer: 1,
      why: "Keep `apt-get update && apt-get install ... && rm -rf /var/lib/apt/lists/*` in one RUN so they are cached, and invalidated, together." }
  ],
  "05": [
    { q: "A Node image is 1.6 GB. `docker history` shows `COPY . .` adding 310 MB. What helps most with that layer?",
      options: ["`docker image prune`", "A .dockerignore that excludes .git, node_modules and logs", "Building with `--squash`", "Compressing the image"], answer: 1,
      why: "COPY . . copies the whole build context. A .dockerignore keeps what the image does not need out of the context, the layer and the upload to the builder." },
    { q: "Why does `RUN rm -rf /tmp/big` in a later step not make the image smaller?",
      options: ["rm does not work in Docker", "Layers are additive: the earlier layer still contains the files; the later one only hides them", "Docker caches deletes", "It does, by the full size"], answer: 1,
      why: "Delete in the same RUN that created the files, or use a multi-stage build and copy only what you need into the final stage." },
    { q: "What does a multi-stage build give you?",
      options: ["Faster pulls from the registry", "A build stage with compilers and dev dependencies, and a final image that copies only the runtime artifacts from it", "Several images from one tag", "Parallel containers"], answer: 1,
      why: "`COPY --from=build` takes only the files you name. Tools, caches and source left in the build stage never reach the image you ship." }
  ],
  "06": [
    { q: "nginx listens on 80 inside the container. Which flag makes it reachable at localhost:8080?",
      options: ["`-p 80:8080`", "`-p 8080:80`", "`--expose 8080`", "`-P 8080`"], answer: 1,
      why: "The order is host:container. `-p 8080:80` forwards your machine's port 8080 to the container's port 80." },
    { q: "`curl localhost:8080` says `Connection reset by peer`. Docker shows `0.0.0.0:8080->8080/tcp`. What is wrong?",
      options: ["The port is not published", "It is published to container port 8080, but the app listens on another port inside", "The firewall blocks 8080", "curl needs https"], answer: 1,
      why: "Docker accepted the connection and forwarded it to a container port where nothing listens. Match the right side of -p to the port the app really uses." },
    { q: "How do you add a published port to a container that is already running?",
      options: ["`docker update -p 8080:80 web`", "You cannot: remove it and run a new container with the port", "`docker port web 8080:80`", "Restart Docker"], answer: 1,
      why: "Port mappings are fixed at creation. Containers are meant to be replaced, so keep the run command (or a compose file) and recreate." }
  ],
  "07": [
    { q: "Two containers started with plain `docker run` cannot reach each other by name. Why?",
      options: ["Containers never talk to each other", "They are on the default bridge, which has no DNS for container names", "Names only work with `--privileged`", "Ping is disabled in containers"], answer: 1,
      why: "User-defined networks run Docker's DNS at 127.0.0.11 and resolve container names. The default bridge only offers IP addresses and the legacy --link." },
    { q: "What does `docker network connect app-net api` do to a running container?",
      options: ["Restarts it", "Adds a second network interface on app-net, live, with an IP and DNS name there", "Moves it off its old network", "Nothing until the next restart"], answer: 1,
      why: "A container can be on several networks at once. Connecting adds an interface immediately; disconnecting removes it." },
    { q: "Why not just put the other container's IP address in the configuration?",
      options: ["IPs do not work inside containers", "IP addresses change when containers are recreated; names stay the same", "IPs are slower than names", "Docker blocks IPs"], answer: 1,
      why: "Container IPs are assigned on start from the network's pool. Use names on a user-defined network, which Compose sets up for you." }
  ],
  "08": [
    { q: "You run `-v $(pwd):/app` and the app now fails with `Cannot find module 'express'`, although the image installed it. Why?",
      options: ["The image is broken", "The bind mount lays your folder over /app and hides the image's node_modules", "npm needs network access", "Volumes are read-only"], answer: 1,
      why: "A mount replaces what the image had at that path. Add a volume for the inner path (`-v /app/node_modules`) so the image's modules show through." },
    { q: "When does Docker copy the image's files into a volume?",
      options: ["Every time a container starts", "When a new, empty volume is mounted on a path where the image has files", "Never", "Only for bind mounts"], answer: 1,
      why: "An empty named or anonymous volume is filled from the image on first use. Bind mounts are never filled: you see exactly the host folder." },
    { q: "What happens to a named volume when you `docker rm` the container that used it?",
      options: ["It is deleted", "It stays until you remove it with `docker volume rm` or a prune", "It is moved into the image", "It is archived"], answer: 1,
      why: "Volumes outlive containers on purpose. Anonymous volumes are removed by `docker rm -v` or by `--rm`; named ones only when you remove them." }
  ],
  "09": [
    { q: "A container runs as uid 10001 and cannot write to a bind-mounted folder owned by root with mode 755. Which fix keeps it secure?",
      options: ["`chmod 777` the folder", "Run the container as root", "`chown` the folder to 10001 (or a group the container's user is in)", "Add `--privileged`"], answer: 2,
      why: "Ownership is checked by number. Give the folder to the container's UID. chmod 777 lets anyone write; root and --privileged throw away the hardening." },
    { q: "Why does `chown app:app /srv/data` fail on the host when the image has a user called app?",
      options: ["chown needs Docker", "The host has no user called app; users inside the image are not users on the host", "The folder is mounted", "app is a reserved name"], answer: 1,
      why: "Names live in each system's /etc/passwd. The kernel only sees numbers, so use the UID: `docker run --rm <image> id` tells you which." },
    { q: "Why do security guides say to add a USER instruction?",
      options: ["It makes builds faster", "Without it the app runs as root, so a compromise of the app is a root process in the container", "Docker requires it", "It enables networking"], answer: 1,
      why: "Root in a container is still root on files it can reach and closer to the kernel. Run as an unprivileged user and add privileges only where needed." }
  ],
  "10": [
    { q: "In a Compose file, how does the springboot service reach the mysql service?",
      options: ["By the host's IP address", "By the service name mysql, on the network Compose creates for the project", "Through a published port only", "With --link"], answer: 1,
      why: "Compose puts every service on a project network with DNS, so service names are hostnames." },
    { q: "What does `depends_on: [mysql]` guarantee?",
      options: ["mysql is ready to accept connections first", "mysql's container is started first, not that the database is ready", "springboot restarts if mysql fails", "Both share a volume"], answer: 1,
      why: "Plain depends_on orders the start only. Add a healthcheck with `condition: service_healthy`, and have the app retry." },
    { q: "Where should the database password in a Compose setup come from?",
      options: ["Written into compose.yaml", "An environment variable or secret supplied when it runs, never committed", "The image", "A comment in the Dockerfile"], answer: 1,
      why: "The repository's compose file reads `${MYSQL_PASSWORD}` from the environment, so no real password is stored in git." }
  ],
  "11": [
    { q: "A container with `--memory 128m` loads 300 MB of data. What happens?",
      options: ["It swaps to disk and slows down", "The kernel kills it: Exited (137), OOMKilled true", "Docker raises the limit", "It keeps running at 128 MB"], answer: 1,
      why: "The memory cgroup enforces the limit. Without enough swap allowance, the OOM killer ends the process." },
    { q: "`docker update --memory 512m report` fails with `Memory limit should be smaller than already set memoryswap limit`. What should you run?",
      options: ["`docker update --memory 512m --memory-swap 512m report`", "`docker restart report`", "`docker update --oom-kill-disable report`", "Recreate Docker"], answer: 0,
      why: "The container already has a swap limit (twice the old memory limit). Set both together so memory is not above memory plus swap." },
    { q: "How should you choose a memory limit?",
      options: ["As low as possible to save money", "Measure real use under load with `docker stats`, then add headroom", "Always 1 GB", "Leave it unlimited"], answer: 1,
      why: "A limit protects the host from one runaway container; too low and it kills a healthy app. Size it from measurements." }
  ],
  "12": [
    { q: "Why is `ENV DB_PASSWORD=...` in a Dockerfile a problem?",
      options: ["Environment variables are slow", "The value is stored in the image config and history, for anyone who can pull it", "Docker strips it", "It only works at build time"], answer: 1,
      why: "Anything in ENV, ARG or a layer travels with the image. Pass secrets at run time, or use BuildKit `--mount=type=secret` during the build." },
    { q: "What does `--cap-drop ALL` do?",
      options: ["Removes all files", "Removes the Linux capabilities root normally has inside a container, so even root cannot do privileged operations", "Disables networking", "Limits CPU"], answer: 1,
      why: "Capabilities split root's powers. Drop them all and add back only what the app proves it needs." },
    { q: "Why is mounting /var/run/docker.sock into a container risky?",
      options: ["It slows Docker down", "Whoever controls the container can start privileged containers and take over the host", "It breaks logs", "It uses too much memory"], answer: 1,
      why: "The socket is full control of the Docker daemon, which runs as root. Treat access to it as root on the host." }
  ],
  "13": [
    { q: "The disk is full. What should you run first?",
      options: ["`docker system prune -a --volumes`", "`docker system df` to see whether images, containers, volumes or build cache use the space", "Delete /var/lib/docker by hand", "Reboot"], answer: 1,
      why: "Measure first. Then prune the category that is big, knowing that volumes can hold data you still need." },
    { q: "Which order of commands finds out why a container is not working?",
      options: ["restart, then rm, then run", "`docker ps -a`, then `docker logs`, then `docker inspect`", "pull, build, push", "prune, then run"], answer: 1,
      why: "State and exit code, then what the app said, then how it was configured. Most problems are solved by the second step." },
    { q: "What does `docker image prune` remove without `-a`?",
      options: ["Every image", "Only dangling images: untagged layers left by rebuilds", "Images older than a week", "Images used by stopped containers"], answer: 1,
      why: "Dangling images are the old versions a rebuild left behind. `-a` also removes every image that no container uses, which you may need to pull again." }
  ]
};
