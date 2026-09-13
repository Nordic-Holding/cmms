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

Set the domain on the **`nginx`** service, and include the container port explicitly:

```
https://cmms.example.com:80
```

The `:80` suffix is not optional. Coolify infers a service's target port from its
`ports:` mapping, and `nginx` only uses `expose`, so without it Coolify emits Traefik
*routers* with no matching *service*. The hostname then resolves but every request
returns `503 no available server`.

`nginx` is the only entry point: it proxies `/` to the frontend, `/api/` to the backend
and `/storage/` to MinIO. The other four services use `expose` only, so they are not
reachable from outside the Compose network.

Two settings are easy to miss:

- **Advanced → Connect To Predefined Network** joins every container to the shared
  `coolify` network, in addition to the per-resource network Coolify already attaches
  Traefik to. Coolify's docs say to enable it only when the stack must reach other Coolify
  resources, which this stack doesn't. It works either way here, and it is not a cause of
  `503 no available server` on its own.
- **Ports 80 and 443 must both be open** on the host firewall (AWS security group, Hetzner
  firewall, `ufw`, ...). Port 80 is not optional: Let's Encrypt validates over HTTP, so
  with it closed Traefik keeps serving its self-signed `TRAEFIK DEFAULT CERT` and browsers
  refuse the connection.

Set `PUBLIC_SERVER_URL` to the **`https://`** form of the domain, not `http://`. Traefik
terminates TLS, and the frontend bakes this value in at build time, so an `http://` value
makes the browser issue mixed-content requests that get blocked on an HTTPS page.

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

**`503 no available server` on the domain** — Traefik matched a route but has no backend
behind it. There are two causes, so check the labels first:

```bash
C=$(docker ps -qf name=nginx)
docker inspect $C --format '{{range $k,$v := .Config.Labels}}{{$k}}={{$v}}
{{end}}' | grep -i traefik
```

If you see `traefik.http.routers.*` lines but no
`traefik.http.services.*.loadbalancer.server.port`, the domain is missing its `:80`
suffix — see step 2. Traefik knows which hostname to match but not what port to forward
to, so the router has no server.

If the port label **is** present and it still 503s, Traefik isn't reading labels at all.
Check its own logs:

```bash
docker logs --since 5m coolify-proxy 2>&1 | grep -iE "error|too old" | tail -5
```

`client version 1.24 is too old. Minimum supported API version is 1.40` means the proxy's
Traefik predates Docker API auto-negotiation, which landed in **v3.6.1**. Its Docker
provider then fails every poll and freezes on the last config it managed to read, so
corrected labels are never picked up. Fix it under **Servers → Proxy → Configuration** by
raising the image, e.g. `traefik:v3.1` to `traefik:v3.7.13`, then restart the proxy. Edit
it there rather than in `/data/coolify/proxy/docker-compose.yml`, which Coolify
regenerates. No redeploy is needed — Traefik recovers on its next poll.

To check the container is on a network Traefik can reach:

```bash
docker network inspect coolify --format '{{range .Containers}}{{.Name}} {{end}}'
```

To rule out the app itself, confirm nginx serves from inside its own container — a 200
here means the problem is entirely in the proxy layer:

```bash
docker exec $(docker ps -qf name=nginx) wget -qO- -S http://127.0.0.1/ 2>&1 | head -3
```

**Browser warns about `TRAEFIK DEFAULT CERT`, or the `http://` URL times out** — port 80
is blocked at the firewall, so certificate issuance never completed. Open it, then
redeploy to trigger a new certificate order.

**`error mounting ".../nginx.conf" ... not a directory`** — a relative bind mount of a
single file can't work here. Coolify rewrites relative paths to
`/data/coolify/applications/<uuid>/` and creates any missing source with `mkdir -p`, so
the config becomes a directory and nginx refuses to start. The `nginx` service therefore
builds `nginx/default.conf` into its image instead of mounting it; keep it that way. Same
rule for any file you'd otherwise mount — bake it in, or declare it under Coolify's
**Storages → File mount**, which writes real files.

**Frontend build fails with `JavaScript heap out of memory`** — raise
`--max_old_space_size` in `frontend/Dockerfile`, and check the host has headroom for it.
