# Docker Image Optimization

## Multi-stage builds

Keep build dependencies in the build stage when possible and copy only runtime artifacts into the final image.

## Layer caching

Place stable dependency installation steps before frequently changing application source code.

## Smaller build contexts

Use `.dockerignore` to exclude Git metadata, local build output, logs, IDE files, dependency caches, and environment files.

Example:

```text
.git
.env
.env.*
*.log
node_modules
target
dist
build
coverage
.idea
.vscode
.DS_Store
```

Tailor the file to each application.

## Inspect the result

```bash
docker image ls
docker history <image>
docker system df
```
