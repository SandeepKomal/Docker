# Container Security Lab

A progressive, hands-on Docker security exercise. Start with a baseline container, then reduce privilege, control build context, minimize the runtime image, and harden the container at execution time.

## Learning path

1. **Baseline** — understand insecure defaults.
2. **Non-root** — run the service with an unprivileged identity.
3. **Build-context hygiene** — keep secrets and local artifacts out of the image.
4. **Lean runtime** — separate build concerns from runtime concerns and reduce the image surface.
5. **Runtime hardening** — use read-only storage, dropped capabilities, no-new-privileges, and resource limits.
6. **Verification** — inspect the image and runtime configuration before promotion.

## Run the lab

Build the baseline:

```bash
docker build -f Dockerfile.baseline -t docker-security:baseline .
docker run --rm -p 3000:3000 docker-security:baseline
curl http://localhost:3000/
```

The endpoint reports the effective UID. UID 0 demonstrates the root baseline.

Build the non-root version:

```bash
docker build -f Dockerfile.nonroot -t docker-security:nonroot .
docker run --rm -p 3000:3000 docker-security:nonroot
curl http://localhost:3000/
```

The application now runs under the `app` account.

## Build-context hygiene

The lab includes a dedicated `.dockerignore` that excludes Git metadata, environment files, logs, dependency caches, and editor artifacts.

Do not treat `.dockerignore` as a secret store. Keep credentials outside the build context and use a proper secret manager or BuildKit secret mechanism for sensitive build-time operations.

## Runtime minimization

The multi-stage example keeps the runtime focused on the application rather than development tooling:

```bash
docker build -f Dockerfile.multistage -t docker-security:multistage .
docker history docker-security:multistage
docker image inspect docker-security:multistage
```

For production pipelines, scan the final image with a vulnerability scanner such as Trivy and investigate important findings before release.

## Harden the runtime

Run the final image with defense-in-depth controls:

```bash
docker run --rm \
  --name docker-security-hardened \
  --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,size=64m \
  --cap-drop ALL \
  --security-opt no-new-privileges:true \
  --pids-limit 128 \
  --memory 256m \
  --cpus 0.5 \
  -p 3000:3000 \
  docker-security:multistage
```

### Why these controls matter

| Control | Security objective |
|---|---|
| Non-root user | Reduce privileges after application compromise |
| `--read-only` | Prevent arbitrary writes to the container root filesystem |
| `--tmpfs /tmp` | Provide a bounded scratch location |
| `--cap-drop ALL` | Remove unnecessary Linux capabilities |
| `no-new-privileges` | Prevent privilege escalation |
| `--pids-limit` | Limit process creation |
| `--memory` / `--cpus` | Reduce resource-abuse impact |

These are workload-dependent controls. Add a capability or writable mount only when the application demonstrably requires it.

## Verification checklist

Before publishing or deploying an image:

- [ ] Run the workload as non-root where possible.
- [ ] Use a maintained base image and update it regularly.
- [ ] Keep credentials out of image layers.
- [ ] Maintain a focused `.dockerignore`.
- [ ] Separate build dependencies from runtime dependencies.
- [ ] Scan the final image in CI.
- [ ] Drop unused Linux capabilities.
- [ ] Disable privilege escalation.
- [ ] Make writable paths intentional.
- [ ] Apply appropriate CPU, memory, and process limits.
- [ ] Inspect image history and runtime configuration.

## Inspect the result

```bash
docker image inspect docker-security:multistage
docker history docker-security:multistage
docker inspect docker-security-hardened
docker stats docker-security-hardened --no-stream
```

The central lesson is **defense in depth**: secure source and build inputs, a minimal image, least privilege, a restricted runtime, and continuous vulnerability management.

This lab is an original implementation integrated into this repository and is not a copy of another repository's files or application.
