# Deploy to Coolify

Coolify builds the `api` and `frontend` images from source on the deployment server, so
the only setup needed is environment variables and a domain.

Use the **Docker Compose** build pack with `docker-compose.yml` at the repository root.

## Server requirements

The builds need real memory. Docker Compose builds both images concurrently, so peak
usage is the sum of the two, on top of whatever is already running:

| Phase | Memory |
|-------|--------|
| React/webpack build | up to 4 GB (heap ceiling set in `frontend/Dockerfile`) |
| Maven/JVM build | ~1–1.5 GB |
| Previous version still running during a redeploy | ~1.3 GB |
| **Peak during a redeploy** | **~6 GB** |

16 GB is comfortable. Below about 8 GB the build will starve the host — see
[Troubleshooting](#troubleshooting).

The images are built for whatever architecture the server runs, so there is nothing to
configure for ARM hosts.

## 1. Set environment variables

These have no defaults. A blank `POSTGRES_PWD` stops Postgres from initialising at all.

```
POSTGRES_USER=atlas
POSTGRES_PWD=<strong-password>
MINIO_USER=atlasminio
MINIO_PASSWORD=<strong-password>
JWT_SECRET_KEY=<openssl rand -base64 32>
PUBLIC_SERVER_URL=https://cmms.example.com
SPRING_PROFILES_ACTIVE=prod
```

The variable is `MINIO_PASSWORD`, not `MINIO_PWD` as the README's env table states.

`PUBLIC_SERVER_URL` must exactly match the public domain including `https://` — the
backend uses it to build presigned attachment URLs and email links.

## 2. Set the domain

Set the domain on the **`nginx`** service, pointing at container port **80**.

`nginx` is the only entry point: it proxies `/` to the frontend, `/api/` to the backend
and `/storage/` to MinIO. The other four services use `expose` only, so they are not
reachable from outside the Compose network.

## 3. Deploy

Expect 8–10 minutes on the first deploy, less afterwards once Docker layer caching
warms up. Coolify builds both images, then starts five containers.

On first boot the backend applies 815 Liquibase changesets and creates the
`atlas-bucket` bucket in MinIO automatically.

## Redeploying after a code change

Push to `main` and redeploy. Both images rebuild from the new source; Maven and npm
dependency layers are reused unless `pom.xml` or `package-lock.json` changed.

## Runtime memory footprint

Measured at idle with the full stack running:

| Service | Memory |
|----------|---------|
| api | 977 MB |
| minio | 224 MB |
| postgres | 72 MB |
| nginx x2 | ~20 MB |
| **Total** | **~1.3 GB** |

Treat this as a floor. The API's JVM claims more under load, since its default max heap
is a quarter of host RAM.

## Troubleshooting

**`Connection timed out during banner exchange`** — the server is alive but too
resource-starved to fork `sshd`, so Coolify loses the control connection it needs to
drive the deployment. This means the build exhausted the host. Confirm with:

```bash
free -h
journalctl -k | grep -i "out of memory"
```

Reboot from the provider console if the host stays unresponsive, then either give it
more RAM or lower `--max_old_space_size` in `frontend/Dockerfile`.

**`pull access denied for minio/minio`** — MinIO removed their images from Docker Hub.
The Compose file pulls `quay.io/minio/minio` instead; don't change it back.

**Postgres exits immediately** — `POSTGRES_PWD` is unset. See step 1.

**Frontend build fails with `JavaScript heap out of memory`** — raise
`--max_old_space_size` in `frontend/Dockerfile`, and check the host has headroom for it.
