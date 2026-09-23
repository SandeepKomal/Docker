# Docker Troubleshooting Guide

## Container exits immediately

```bash
docker ps -a
docker logs <container>
docker inspect <container>
```

Check the entrypoint, command, environment, mounted files, and application logs.

## Port already in use

```bash
sudo lsof -i :8080
```

Change the host-side published port or stop the process using it.

## Containers cannot communicate

```bash
docker network ls
docker network inspect <network>
```

Ensure the containers share an appropriate user-defined network.

## Build is slow

Check the build context, layer ordering, dependency caching, and multi-stage builds. Add a tailored `.dockerignore` to avoid sending unnecessary files to the daemon.

## Disk space is low

```bash
docker system df
docker image ls
docker container ls -a
docker volume ls
```

Prune selectively rather than deleting everything blindly.
