# Deployment

Production runs on the DigitalOcean droplet `cloud-mining` (SGP1). It serves https://cloud.bitqube.org behind Cloudflare's proxy.

```
visitor ──https──▶ Cloudflare ──https (Full strict)──▶ Caddy :443 ──▶ web container 127.0.0.1:3000
                                                                       worker container
                                both ──private network──▶ managed PostgreSQL 18 (bitqube_cloud)
```

## Server

| Item | Detail |
| --- | --- |
| OS | Ubuntu 24.04 |
| SSH | Port 24223, key login only, no root login, no passwords; fail2ban guards SSH. |
| Firewall | ufw: SSH open to all. 80/443 only from Cloudflare's IP ranges, so the origin can't be reached around Cloudflare. |
| Swap | 2 GB |
| Updates | Unattended security upgrades on. |
| Containers | Docker with log rotation. The app containers publish only on 127.0.0.1, because Docker's port rules bypass ufw. |
| Front proxy | Caddy (`/etc/caddy/Caddyfile`, copy of `deploy/Caddyfile`). |
| TLS | A Cloudflare Origin Certificate in `/etc/caddy/certs/` (valid to 2041). A Cloudflare Configuration Rule sets SSL to **Full (strict)** for this hostname only; the rest of the zone stays as it is. |
| Real visitor IPs | Taken from `CF-Connecting-IP`, trusted only from Cloudflare ranges. |

Run `sudo deploy/cloudflare-ips.sh` on the server now and then to refresh Cloudflare's ranges in both ufw and Caddy.

## Database

DigitalOcean managed PostgreSQL 18, reached over the private network. Daily backups and point-in-time restore are part of the service.

- The app uses its own `bqcloud` user, which owns the `bitqube_cloud` database. It is not a superuser and is limited to 15 connections; Prisma uses at most 5 per process.
- The `doadmin` admin connection is kept only in `~/.db-admin-url` on the server, mode 600.

## Deploying

From a checkout with the SSH key loaded in your agent:

```sh
DEPLOY_SSH_OPTS="-o IdentitiesOnly=yes -i /path/to/bitqube2026.pub" deploy/deploy.sh
```

The script:
1. Copies the source to `~/bitqube-cloud`. It never copies `.env`; the server keeps its own.
2. Builds the image on the server.
3. Restarts the stack. Prisma migrations run first in a one-off `migrate` container, and `web` and `worker` start only if they succeed.

Useful on the server (`cd ~/bitqube-cloud`):

```sh
docker compose ps
docker compose logs -f worker      # or web
docker compose exec web node --import tsx scripts/seed.ts --admin someone@example.com   # create/promote an admin
```
