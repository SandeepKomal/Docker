# DevOps Nimbus Docker

**Docker, zero to on-call.** Practical Docker commands, Dockerfiles and Compose examples, plus a free browser site with a playground of real container incidents, for DevOps and cloud engineers learning containers.

[![Learning site](https://img.shields.io/badge/learn-DevOps%20Nimbus-1d1d1f)](https://sandeepkomal.github.io/Docker/)
[![CI](https://github.com/SandeepKomal/Docker/actions/workflows/ci.yml/badge.svg)](https://github.com/SandeepKomal/Docker/actions/workflows/ci.yml)
[![Pages](https://github.com/SandeepKomal/Docker/actions/workflows/pages.yml/badge.svg)](https://github.com/SandeepKomal/Docker/actions/workflows/pages.yml)
[![Docker](https://img.shields.io/badge/Docker-containers-2496ED?logo=docker&logoColor=white)](https://docs.docker.com/)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
![No trackers](https://img.shields.io/badge/site-no%20trackers%20%C2%B7%20no%20cookies-2ea44f)
[![Contributions welcome](https://img.shields.io/badge/contributions-welcome-brightgreen)](CONTRIBUTING.md)
![Last commit](https://img.shields.io/github/last-commit/SandeepKomal/Docker)
[![GitHub stars](https://img.shields.io/github/stars/SandeepKomal/Docker?style=social)](https://github.com/SandeepKomal/Docker/stargazers)
[![GitHub forks](https://img.shields.io/github/forks/SandeepKomal/Docker?style=social)](https://github.com/SandeepKomal/Docker/network/members)
[![Open in GitHub Codespaces](https://github.com/codespaces/badge.svg)](https://codespaces.new/SandeepKomal/Docker)

**[Open the learning site](https://sandeepkomal.github.io/Docker/)** · [Troubleshoot an error](https://sandeepkomal.github.io/Docker/#doctor) · [Every error on one page](https://sandeepkomal.github.io/Docker/problems.html) · [All DevOps Nimbus tracks](https://sandeepkomal.github.io/devops-nimbus/)

## Contents

- [Learn it in your browser](#learn-it-in-your-browser)
- [What's in this repository](#whats-in-this-repository)
- [Quick start](#quick-start)
- [Build an image](#build-an-image)
- [Docker Compose](#docker-compose)
- [Docker networking](#docker-networking)
- [Persistent storage](#persistent-storage)
- [Multi-stage builds](#multi-stage-builds)
- [Cleanup](#cleanup)
- [Production-oriented guides](#production-oriented-guides)
- [Learning roadmap](#learning-roadmap)
- [Who is this for?](#who-is-this-for)
- [Repository layout](#repository-layout)
- [Troubleshooting](#troubleshooting)
- [Contributing](#contributing)
- [Security](#security)
- [Privacy and cost](#privacy-and-cost)
- [License and trademarks](#license-and-trademarks)
- [Author and contributors](#author-and-contributors)

## Learn it in your browser

The [DevOps Nimbus Docker site](https://sandeepkomal.github.io/Docker/) (source in [`site/`](./site/)) turns this repository into a hands-on course:

- **Playground**: a `docker` CLI over a modelled engine with 46 real incidents, from a container that exits at once to OOM kills, Compose start order, registry limits and security hardening. Every scenario has its own link (`#play/<id>`).
- **Troubleshoot**: paste an error message and get what it means, how to confirm it, the fix and how to prevent it. Every problem has its own link (`#fix/<id>`), and all of them are on one plain page, [problems.html](https://sandeepkomal.github.io/Docker/problems.html).
- **Dockerfile X-ray**, a **quiz** for each of the 17 levels, a **cheat sheet** whose commands run in the playground, and an **architecture** diagram.
- **Scoreboard**: a score, a skill radar, learning uptime and on-call shifts against the clock; **Download my progress** and **Load my progress** move it to another device.

Nothing is installed and nothing leaves your browser.

## What's in this repository

A hands-on Docker reference covering **Docker commands, images, containers, Dockerfiles, networking, volumes, cleanup, Docker Compose, installation, multi-stage builds, and containerized application patterns**.

This repository is a practical companion for DevOps and cloud engineers who want reusable Docker examples rather than only theory.

### What you'll learn

- Docker CLI fundamentals
- Images and containers
- Dockerfile patterns and multi-stage builds
- Container networking
- Volumes and persistent data
- Docker Compose
- Nginx and Java/Spring Boot examples
- Docker cleanup and disk-space management
- Container troubleshooting
- Image optimization and security practices

## Quick start

Check your installation:

```bash
docker --version
docker info
```

Run a container:

```bash
docker run --name nginx-demo -d -p 8080:80 nginx:alpine
docker ps
```

Open `http://localhost:8080`.

Inspect logs and clean up:

```bash
docker logs nginx-demo
docker stop nginx-demo
docker rm nginx-demo
```

## Build an image

Example:

```dockerfile
FROM nginx:alpine
COPY ./website /usr/share/nginx/html
EXPOSE 80
```

Build and run:

```bash
docker build -t my-web-app:1.0 .
docker run --name my-web-app -d -p 8080:80 my-web-app:1.0
```

## Docker Compose

Modern Docker installations use the `docker compose` command.

```bash
docker compose up -d
docker compose ps
docker compose logs -f
docker compose down
```

See [docker-compose/](./docker-compose/) for the application/database example.

## Docker networking

```bash
docker network ls
docker network create app-net
docker network connect app-net <container>
docker network inspect app-net
docker network disconnect app-net <container>
```

Use user-defined networks when containers need reliable service-to-service communication.

## Persistent storage

Named volumes persist data beyond a container lifecycle:

```bash
docker volume create app-data
docker run --rm -v app-data:/data alpine sh -c 'echo hello > /data/message.txt'
docker run --rm -v app-data:/data alpine cat /data/message.txt
```

See [docker volumes.md](./docker%20volumes.md).

## Multi-stage builds

The repository contains Java and frontend multi-stage examples that separate build dependencies from the runtime image.

Typical pattern:

```dockerfile
FROM maven:3.9-eclipse-temurin-17 AS build
WORKDIR /app
COPY pom.xml .
RUN mvn -q -DskipTests dependency:go-offline
COPY src ./src
RUN mvn -q -DskipTests package

FROM eclipse-temurin:17-jre
WORKDIR /app
COPY --from=build /app/target/app.jar app.jar
ENTRYPOINT ["java", "-jar", "app.jar"]
```

## Cleanup

Inspect disk usage first:

```bash
docker system df
```

Then use targeted cleanup:

```bash
docker container prune
docker image prune
docker volume prune
docker network prune
```

Use broad pruning carefully because unused resources may still be needed later.

## Production-oriented guides

- [Docker Security](./docs/security.md)
- [Docker Troubleshooting](./docs/troubleshooting.md)
- [Image Optimization](./docs/image-optimization.md)

## Learning roadmap

```text
Docker basics
  -> Images & containers
  -> Dockerfiles
  -> Networking
  -> Volumes
  -> Compose
  -> Multi-stage builds
  -> Security & optimization
  -> CI/CD
  -> Kubernetes
```

## Who is this for?

- DevOps engineers
- Cloud engineers
- SREs
- Developers learning containerization
- Docker beginners
- Engineers preparing for Docker/Kubernetes interviews

## Repository layout

| Area | Path |
|---|---|
| Docker commands | [docker-commands.md](./docker-commands.md) |
| Docker installation | [docker_installation.md](./docker_installation.md) |
| Ubuntu installation | [docker_installation_ubuntu.md](./docker_installation_ubuntu.md) |
| Networking | [Docker Networks](./Docker%20Networks) |
| Volumes | [docker volumes.md](./docker%20volumes.md) |
| Cleanup | [docker cleanup commands](./docker%20cleanup%20commands) |
| Docker Compose | [docker-compose/](./docker-compose/) |
| Dockerfile examples | [Dockerfile's/](./Dockerfile's/) |
| Security guide | [docs/security.md](./docs/security.md) |
| Troubleshooting | [docs/troubleshooting.md](./docs/troubleshooting.md) |
| Image optimization | [docs/image-optimization.md](./docs/image-optimization.md) |

## Troubleshooting

- Paste an error into the site's [Troubleshoot](https://sandeepkomal.github.io/Docker/#doctor) tab, or browse [every error on one page](https://sandeepkomal.github.io/Docker/problems.html).
- For diagnosing real containers, see [docs/troubleshooting.md](./docs/troubleshooting.md).

## Contributing

Practical improvements, corrections, new examples, and documentation updates are welcome.

See [CONTRIBUTING.md](./CONTRIBUTING.md).

To run the checks locally (Node.js, no dependencies):

```bash
node tests/check_site_data.js && node tests/check_playground.js && node tests/check_xray.js && node tests/fuzz_playground.js
node tools/build-problems.js   # after changing troubleshooting entries in site/data.js
```

## Security

Never commit passwords, API keys, access tokens, private keys, registry credentials, or real environment files.

See [SECURITY.md](./SECURITY.md). To report a vulnerability, contact the repository owner privately through GitHub rather than opening a public issue. CI runs the site tests; no separate security scanners run in CI.

## Privacy and cost

The site runs entirely in your browser: no accounts, cookies, trackers or database. Your progress stays in your own browser's storage. It is hosted free on GitHub Pages, and nothing in this repository costs money to use.

## License and trademarks

MIT. See [LICENSE](./LICENSE). Docker® is a trademark of Docker, Inc. This project is independent and not affiliated with Docker, Inc.

## Author and contributors

**Sandeep Komal** · [github.com/SandeepKomal](https://github.com/SandeepKomal)

Cloud / DevOps Engineer focused on AWS, Kubernetes, Terraform, CI/CD, automation, and DevSecOps.

Built and maintained with [DevopsNimbus](https://github.com/DevopsNimbus). See everyone who has contributed in the [contributors graph](https://github.com/SandeepKomal/Docker/graphs/contributors).

If this repository helps you learn Docker or solve a containerization problem, consider giving it a **star**. It helps other engineers discover the material and motivates continued improvements.
