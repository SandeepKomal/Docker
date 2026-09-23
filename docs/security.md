# Docker Security Guide

- Use maintained and trusted base images.
- Pin versions where reproducibility matters.
- Avoid running applications as root when possible.
- Never bake passwords, tokens, or private keys into images.
- Use CI/CD secret stores or BuildKit secrets for sensitive build-time data.
- Scan images for vulnerabilities in CI.
- Minimize packages in runtime images.
- Drop unnecessary Linux capabilities where practical.
- Avoid exposing the Docker daemon socket to untrusted containers.

Inspect runtime configuration with:

```bash
docker inspect <container>
docker image inspect <image>
docker history <image>
docker stats <container>
```

Review exposed ports, mounts, environment variables, capabilities, and image layers before production use.

> The examples in this repository are educational. Review them against your organization's security requirements before production deployment.
