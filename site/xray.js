// Explains a pasted Dockerfile line by line, offline: what each instruction
// does, the mistakes people make with it, and what the file is missing.
// Nothing leaves the browser. tests/check_xray.js drives it under Node.
"use strict";

(function (root) {
  const MAX_LINES = 400;
  const SECRET = /(pass(word)?|secret|token|api[_-]?key|private[_-]?key|credentials?)/i;
  const INSTALLS = /\b(npm (ci|install|i)\b|yarn( install)?\b|pip3? install|mvn\b|gradle\b|go mod download|bundle install|composer install)/;
  // Releases past their end of life: no more security fixes.
  const EOL = [[/^node:(1[0-8]|[0-9])([.-]|$)/, "This Node.js release is past its end of life and gets no security fixes. Move to an active LTS (node:22)."],
    [/^centos:/, "CentOS Linux reached its end of life (CentOS 7 in June 2024) and gets no security fixes. Use a maintained base such as rockylinux, almalinux or debian."],
    [/^(ubuntu:(1[0-8]\.|20\.04)|debian:(stretch|buster|9|10)\b)/, "This release is past its standard support. Move to a current one."],
    [/^python:(2|3\.[0-8])([.-]|$)/, "This Python release is past its end of life. Move to a supported 3.x."]];

  // Split a Dockerfile into instructions, keeping the lines each one spans.
  function instructions(lines) {
    const out = [];
    let cur = null;
    lines.forEach((line, i) => {
      const t = line.trim();
      if (cur) {
        cur.lines.push(i);
        if (!/^#/.test(t)) cur.text += " " + t.replace(/\\$/, "").trim();
        if (!/\\$/.test(t)) cur = null;
        return;
      }
      if (!t || t.startsWith("#")) return;
      cur = { start: i, lines: [i], text: t.replace(/\\$/, "").trim() };
      out.push(cur);
      if (!/\\$/.test(t)) cur = null;
    });
    return out;
  }

  const execForm = (rest) => {
    if (!rest.startsWith("[")) return null;
    try { const a = JSON.parse(rest); return Array.isArray(a) ? a : null; } catch { return null; }
  };

  function explain(text) {
    const lines = String(text).replace(/\t/g, "  ").split(/\r?\n/);
    if (lines.length > MAX_LINES) return { error: `That is ${lines.length} lines. Paste one Dockerfile of up to ${MAX_LINES} lines.` };
    const rows = lines.map((line) => ({ line, note: null, level: "blank", warns: [] }));
    const instrs = instructions(lines);
    const stages = [];
    let stage = null;
    let secrets = false;
    let seenInstruction = false;

    lines.forEach((line, i) => {
      const t = line.trim();
      if (!t.startsWith("#")) return;
      const r = rows[i];
      r.level = "info";
      if (!seenInstruction && /^#\s*(syntax|escape|check)\s*=/i.test(t)) r.note = "A parser directive. It must come before any instruction; `# syntax=docker/dockerfile:1` picks the newest stable Dockerfile syntax.";
      else if (/^#\s*(FROM|RUN|COPY|ADD|CMD|ENTRYPOINT|ENV|ARG|USER|WORKDIR|EXPOSE)\b/i.test(t)) r.note = "A commented-out instruction. The builder ignores it; delete it when it is no longer needed.";
      else r.note = "A comment. The builder ignores it.";
      if (instrs.some((x) => x.start < i)) seenInstruction = true;
    });

    instrs.forEach((ins, n) => {
      seenInstruction = true;
      const m = /^(\S+)\s*([\s\S]*)$/.exec(ins.text);
      const name = m[1].toUpperCase();
      const rest = m[2].trim();
      const r = rows[ins.start];
      const warns = r.warns;
      let note;
      r.level = "info";
      for (const j of ins.lines.slice(1)) rows[j] = { line: lines[j], note: "Part of the instruction above (the line before ends with \\).", level: "cont", warns: [] };
      const sameStageLater = [];
      for (const x of instrs.slice(n + 1)) { if (/^FROM\b/i.test(x.text)) break; sameStageLater.push(x.text); }

      if (!stage && name !== "FROM" && name !== "ARG") warns.push("Every Dockerfile starts with FROM (only ARG may come before it). The build fails with: no build stage in current context.");

      switch (name) {
        case "FROM": {
          const f = /^(?:--platform=(\S+)\s+)?(\S+)(?:\s+(as)\s+(\S+))?$/i.exec(rest) || [];
          const image = f[2] || "";
          stage = { image, name: f[4], instrs: [], line: ins.start };
          stages.push(stage);
          note = image === "scratch" ? "Starts from an empty image: no shell, no libraries. Only for static binaries." : `Starts ${stages.length > 1 ? "a new stage" : "the image"} from \`${image}\`.${f[4] ? ` The stage is named \`${f[4]}\`, so later stages can \`COPY --from=${f[4]}\`.` : ""}${stages.length > 1 ? " Nothing from earlier stages is kept unless it is copied." : ""}`;
          if (f[1]) note += ` --platform builds for ${f[1]}.`;
          const tagged = /:[^/]+$/.test(image) || image.includes("@");
          if (image !== "scratch" && !stages.find((s) => s !== stage && s.name === image)) {
            if (!tagged) warns.push("No tag means :latest, which moves whenever the publisher pushes. Pin a version (node:22-alpine) or a digest.");
            else if (/:latest$/.test(image)) warns.push(":latest moves whenever the publisher pushes, so two builds can differ. Pin a version or a digest.");
            for (const [re, w] of EOL) if (re.test(image.replace(/^docker\.io\/(library\/)?/, ""))) warns.push(w);
            if (/^node:\d+(\.\d+)*$|^node:(latest|lts)$/.test(image)) note += " The full node image is over 1 GB; -slim or -alpine is a fraction of that.";
          }
          if (f[3] && f[3] !== "AS" && /^FROM/.test(m[1])) warns.push("BuildKit warns about mixed case: write `AS` in capitals to match `FROM` (FromAsCasing).");
          break;
        }
        case "RUN": {
          const exec = execForm(rest);
          const cmd = exec ? exec.join(" ") : rest.replace(/^--\S+\s+/g, "");
          note = exec ? "Runs a command at build time in exec form (no shell, so no && or variables). Its changes become a new layer." : "Runs a shell command at build time. Everything it writes becomes a new layer of the image.";
          if (/apt-get update/.test(cmd) && !/apt-get (-\S+ )*install/.test(cmd)) warns.push("`apt-get update` alone in a RUN is cached on its own, so a later install line uses stale package lists. Update and install in one RUN.");
          if (/apt-get (-\S+ )*install/.test(cmd)) {
            note = "Installs Debian or Ubuntu packages in a new layer.";
            if (!/\s-y\b|--yes|-qq?y/.test(cmd)) warns.push("No -y: apt asks for confirmation, gets no answer and the build fails.");
            if (!/--no-install-recommends/.test(cmd)) warns.push("Add --no-install-recommends to skip optional packages you did not ask for.");
            if (!/rm -rf \/var\/lib\/apt\/lists/.test(cmd)) warns.push("The package lists stay in this layer. End the same RUN with `rm -rf /var/lib/apt/lists/*`.");
          }
          if (/\bapk add\b/.test(cmd)) { note = "Installs Alpine packages in a new layer."; if (!/--no-cache/.test(cmd)) warns.push("Use `apk add --no-cache` so the package index is not kept in the layer."); }
          if (/\b(yum|dnf|microdnf) (-\S+ )*install\b/.test(cmd)) { note = "Installs RPM packages in a new layer."; if (!/(yum|dnf) clean all/.test(cmd)) warns.push("Add `&& yum clean all` (or dnf) in the same RUN, so the package cache does not stay in the layer."); }
          if (/\bnpm install\b|\bnpm i\b/.test(cmd)) note = "Installs Node dependencies. `npm ci` installs exactly what package-lock.json says, which makes builds repeatable; add --omit=dev for the image you ship.";
          if (/\bnpm ci\b/.test(cmd)) note = `Installs exactly the versions in package-lock.json.${/--omit=dev|--production|--only=prod/.test(cmd) ? " --omit=dev leaves out test and build tools." : " Without --omit=dev it also installs test and build tools; leave those in a build stage."}`;
          if (/\byarn( install)?\b/.test(cmd) && !/yarn (build|run|test)/.test(cmd)) note = "Installs Node dependencies with Yarn. `yarn install --frozen-lockfile` fails instead of changing yarn.lock, which keeps builds repeatable.";
          if (/\b(yarn|npm run) build\b/.test(cmd)) note = "Builds the app (for example into dist/). In a multi-stage build only the output is copied on.";
          if (/\bmvn\b|\bgradle\b/.test(cmd)) note = "Compiles and packages a Java app. The build tool and its cache belong in a build stage, not in the image you ship.";
          if (/\bpip3? install\b/.test(cmd) && !/--no-cache-dir/.test(cmd)) warns.push("Add --no-cache-dir so pip's download cache is not kept in the layer.");
          if (/(curl|wget)[^|]*\|\s*(sudo\s+)?(ba)?sh\b/.test(cmd)) warns.push("Piping a download straight into a shell runs whatever the server sends. Download, verify a checksum, then run it.");
          if (/\bchmod\s+(-R\s+)?777\b/.test(cmd)) warns.push("chmod 777 lets every user write here. Give the files to the user that needs them instead.");
          if (/\bsudo\b/.test(cmd)) warns.push("RUN already runs as the current USER, root by default. sudo adds a package and a way to escalate; switch USER instead.");
          if (/(^|&&\s*|;\s*)cd\s/.test(cmd)) warns.push("`cd` only lasts for this RUN. Use WORKDIR to change directory for the instructions that follow.");
          if (/\brm -rf \.\/\*|\brm -rf \/[a-z]+\/\*/.test(cmd) && !/apt\/lists/.test(cmd)) note += " Deleting files here hides them, but any earlier layer that added them still carries their size.";
          if (/(groupadd|useradd|addgroup|adduser)/.test(cmd)) note = "Creates a group and user to run the app as, so it does not run as root. Fix the UID (-u 10001) if mounted folders need a known owner.";
          if (SECRET.test(cmd) && /[=:]\s*\S{4,}|--password\b/.test(cmd)) { warns.push("This looks like a secret on the command line, which is stored in the image history. Use `RUN --mount=type=secret`."); secrets = true; }
          if (/--mount=type=secret/.test(rest)) note += " The secret is mounted only for this step and never stored in a layer.";
          if (/--mount=type=cache/.test(rest)) note += " The cache mount keeps the package cache between builds without putting it in the image.";
          break;
        }
        case "COPY": case "ADD": {
          const flags = Object.fromEntries((rest.match(/--[\w-]+(=\S+)?/g) || []).map((f) => f.slice(2).split("=")));
          const args = (execForm(rest.replace(/^(--\S+\s+)+/, "")) || rest.replace(/^(--\S+\s+)+/, "").split(/\s+/)).filter(Boolean);
          const dest = args[args.length - 1] || "";
          const srcs = args.slice(0, -1);
          const into = /^\.\/?$/.test(dest) ? "the working directory" : `\`${dest}\``;
          note = flags.from ? `Copies ${srcs.join(" ")} from the \`${flags.from}\` stage (or image) into ${into}. Only these files reach this stage; the rest of \`${flags.from}\` is left behind.`
            : `Copies ${srcs.join(" ") || "files"} from the build context into ${into}, as a new layer.`;
          if (flags.chown) note += ` --chown=${flags.chown} sets the owner as it copies, which avoids a separate chown layer that would double the size.`;
          if (flags.link) note += " --link makes the layer independent of the ones below, so it can be reused when the base changes.";
          if (!flags.from && srcs.some((s) => s === "." || s === "./" || s === "/." || s === "/")) {
            note = `Copies the whole build context into ${into}. Whatever .dockerignore does not exclude ends up in the image: .git, node_modules, .env, logs.`;
            if (sameStageLater.some((x) => /^RUN\b/i.test(x) && INSTALLS.test(x))) warns.push("Copied before the dependency install below, so every source change reruns the install. Copy the dependency files (package*.json) first, install, then copy the rest.");
          }
          if (!flags.from && srcs.some((s) => s.startsWith("/"))) warns.push("Source paths are relative to the build context. A leading / means the context root, not the host's root, which is easy to misread.");
          if (name === "ADD") {
            if (srcs.some((s) => /^https?:\/\//.test(s))) warns.push(flags.checksum ? "ADD fetches the URL at build time and checks it against --checksum." : "ADD fetches the URL with no integrity check. Add --checksum=sha256:..., or download with curl and verify it.");
            else if (!srcs.some((s) => /\.(tar|tgz|tar\.(gz|xz|bz2|zst))$/.test(s))) warns.push("For local files use COPY. ADD also unpacks archives and fetches URLs, which can surprise the next reader.");
            else note = `Copies ${srcs.join(" ")} into ${into} and unpacks the archive there.`;
          }
          break;
        }
        case "CMD": case "ENTRYPOINT": {
          const exec = execForm(rest);
          const cmd = exec ? exec.join(" ") : rest;
          note = name === "CMD"
            ? "The default command when the container starts. `docker run <image> other args` replaces it."
            : "The program the container always runs. CMD, or the arguments to docker run, are passed to it. --entrypoint replaces it.";
          if (exec) note += " Exec form: the program runs as PID 1 and receives docker stop's SIGTERM.";
          else if (rest) warns.push(`Shell form runs this under /bin/sh -c, so PID 1 is the shell and docker stop's SIGTERM never reaches the app; it is killed after 10 seconds. Use exec form: ${name} ${JSON.stringify(rest.split(/\s+/))}.`.replace(/","/g, "\", \""));
          if (rest.startsWith("[") && !exec) warns.push("This is not valid JSON (use double quotes), so Docker treats it as shell form.");
          if (/\bnginx\b/.test(cmd) && !/daemon off/.test(cmd)) warns.push("nginx starts in the background unless told `-g 'daemon off;'`. PID 1 then returns and the container exits with code 0.");
          if (/\bservice \S+ start\b|systemctl start|&\s*$/.test(cmd)) warns.push("This starts a process in the background and returns, so the container exits at once. Run the program in the foreground.");
          if (name === "ENTRYPOINT" && exec && /^java$/.test(exec[0]) && exec.length === 2) note += " With an incomplete argument list like this, the CMD below supplies the rest (the jar).";
          break;
        }
        case "ENV": {
          note = "Sets an environment variable for later instructions and for the running container. It is stored in the image config, visible to anyone with the image.";
          const keys = rest.includes("=") ? (rest.match(/([\w.-]+)=/g) || []).map((k) => k.slice(0, -1)) : [rest.split(/\s+/)[0]];
          if (keys.some((k) => SECRET.test(k))) {
            warns.push("A secret in ENV is baked into the image and shown by docker inspect. Pass it at run time (-e or a secret file) instead.");
            secrets = true;
          }
          if (/^VITE_|^REACT_APP_|^NEXT_PUBLIC_/.test(keys[0] || "")) note += " Front-end build variables like this are compiled into the JavaScript the browser downloads, so they are public.";
          break;
        }
        case "ARG": {
          note = "A build-time variable, set with --build-arg. It does not exist in the running container, but values used by RUN are recorded in the image history.";
          if (SECRET.test(rest)) { warns.push("Build arguments are visible in docker history. For secrets use `RUN --mount=type=secret,id=...` with `docker build --secret`."); secrets = true; }
          break;
        }
        case "WORKDIR":
          note = "Sets the working directory for the instructions that follow and for the container, creating it if needed.";
          if (!rest.startsWith("/") && !rest.startsWith("$")) warns.push("A relative WORKDIR depends on the one before it. Use an absolute path.");
          break;
        case "USER":
          note = `Runs the following instructions, and the container, as \`${rest}\`. A fixed numeric UID makes ownership of mounted folders predictable.`;
          if (/^(root|0)(:|$)/.test(rest)) warns.push("Switching to root: make sure a later USER switches back, or the app runs as root.");
          break;
        case "EXPOSE":
          note = `Documents that the app listens on ${rest}. It does not publish anything: use -p host:container when you run it.`;
          break;
        case "LABEL": note = "Metadata on the image (source, version, maintainer). Tools and registries read labels; the container does not."; break;
        case "MAINTAINER": note = "Deprecated."; warns.push("MAINTAINER is deprecated. Use `LABEL org.opencontainers.image.authors=\"...\"`."); break;
        case "HEALTHCHECK": note = "How Docker checks the app is healthy. docker ps shows (healthy) or (unhealthy), and Compose can wait for it."; break;
        case "VOLUME":
          note = `Declares ${rest} as a volume: each container gets an anonymous volume there, even if you do not ask for one.`;
          warns.push("Changes to this path in later instructions are thrown away, and every run leaves an anonymous volume behind. Prefer mounting volumes at run time.");
          break;
        case "STOPSIGNAL": note = "The signal docker stop sends first, instead of SIGTERM."; break;
        case "SHELL": note = "Changes the shell used by shell-form RUN, CMD and ENTRYPOINT."; break;
        case "ONBUILD": note = "An instruction stored for images built FROM this one. It runs in their build, which can surprise their authors."; break;
        default:
          r.level = "unknown";
          note = `Not a Dockerfile instruction. The build stops with: unknown instruction: ${m[1]}.`;
      }
      r.note = note;
      if (stage) stage.instrs.push({ name, rest, line: ins.start });
    });

    lines.forEach((line, i) => { if (!line.trim()) rows[i] = { line, note: null, level: "blank", warns: [] }; });
    return { lines: rows, review: review(stages, secrets) };
  }

  // What the file is missing, judged on the final stage.
  function review(stages, secrets) {
    const notes = [];
    if (!stages.length) return ["No FROM instruction: this is not a Dockerfile yet."];
    const last = stages[stages.length - 1];
    const has = (name) => last.instrs.filter((x) => x.name === name);
    const users = has("USER");
    if (!users.length || /^(root|0)(:|$)/.test(users[users.length - 1].rest)) notes.push("No USER in the final stage, so the app runs as root. Create a user and switch to it with USER.");
    if (!has("CMD").length && !has("ENTRYPOINT").length) notes.push("No CMD or ENTRYPOINT in the final stage: the container runs whatever the base image's default command is.");
    if (has("CMD").length > 1) notes.push("More than one CMD in the final stage. Only the last one counts.");
    if (stages.length === 1 && last.instrs.some((x) => x.name === "RUN" && (/\b(mvn|gradle|gcc|make|go build|yarn build|npm run build)\b/.test(x.rest) || (/\bnpm (ci|install|i)\b/.test(x.rest) && !/--omit=dev|--production/.test(x.rest))))) {
      notes.push("Build tools and dev dependencies end up in the image you ship. A multi-stage build keeps them in a build stage and copies only the result.");
    }
    if (stages.some((s) => s.instrs.some((x) => (x.name === "COPY" || x.name === "ADD") && /(^|\s)(\.|\.\/|\/\.|\/)\s/.test(x.rest + " ") && !/--from/.test(x.rest)))) {
      notes.push("It copies the whole build context. Keep a .dockerignore beside the Dockerfile with at least .git, node_modules (or target, dist), .env and logs.");
    }
    if (stages.some((s) => s.image && s.image !== "scratch" && !stages.some((o) => o.name === s.image) && (!/:[^/]+$/.test(s.image) || /:latest$/.test(s.image)) && !s.image.includes("@"))) {
      notes.push("A base image without a pinned version: rebuilds can silently pick up a different base.");
    }
    if (secrets) notes.push("Something that looks like a secret is stored in the image. Anyone who can pull the image can read it with docker history or docker inspect.");
    if (!has("HEALTHCHECK").length) notes.push("No HEALTHCHECK. Docker cannot tell a hung app from a working one (orchestrators such as Kubernetes use their own probes instead).");
    return notes;
  }

  root.DQExplain = { explain };
})(typeof window !== "undefined" ? window : globalThis);
