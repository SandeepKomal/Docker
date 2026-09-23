# Docker — Practical Docker Learning & DevOps Guide

A hands-on Docker reference covering **Docker commands, images, containers, Dockerfiles, networking, volumes, cleanup, Docker Compose, installation, multi-stage builds, and containerized application patterns**.

This repository is a practical companion for DevOps and cloud engineers who want reusable Docker examples rather than only theory.

## What you'll learn

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

## Repository map

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

## Contributing

Practical improvements, corrections, new examples, and documentation updates are welcome.

See [CONTRIBUTING.md](./CONTRIBUTING.md).

## Security

Never commit passwords, API keys, access tokens, private keys, registry credentials, or real environment files.

See [SECURITY.md](./SECURITY.md).

## Support the project

If this repository helps you learn Docker or solve a containerization problem, consider giving it a **star**. It helps other engineers discover the material and motivates continued improvements.

## Author

**Sandeep Komal**

Cloud / DevOps Engineer focused on AWS, Kubernetes, Terraform, CI/CD, automation, and DevSecOps.

- GitHub: [@SandeepKomal](https://github.com/SandeepKomal)
