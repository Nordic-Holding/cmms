# Deploy to Coolify

The `api` and `frontend` images are built by GitHub Actions and published to GHCR, then
pulled by Coolify. Nothing is compiled on the deployment server — building there needs
~6 GB of RAM and previously took the host down.

## 1. Enable public packages (org admin, one time)

GHCR packages are private by default, so Coolify cannot pull them. Making them public
allows anonymous read-only pulls.

1. Open **Organization Settings → Packages**:
   <https://github.com/organizations/Nordic-Holding/settings/packages>
2. Under **Package Creation**, tick **Public** and save.

## 2. Make the two packages public (one time)

1. <https://github.com/orgs/Nordic-Holding/packages/container/cmms-api/settings>
2. <https://github.com/orgs/Nordic-Holding/packages/container/cmms-frontend/settings>

On each: **Danger Zone → Change visibility → Public**.

Verify anonymous pulls work:

```bash
docker logout ghcr.io
docker pull ghcr.io/nordic-holding/cmms-api:latest
```

> If org policy forbids public packages, keep them private and run
> `docker login ghcr.io -u <user> -p <token>` on the Coolify host instead, using a
> classic PAT with only the `read:packages` scope.

## 3. Check the server architecture

```bash
uname -m   # expect x86_64
```

If this returns `aarch64`, change `platforms: linux/amd64` to `linux/arm64` in
`.github/workflows/deploy-images.yml` and re-run the workflow. An amd64 image will not
run on an ARM host.

## 4. Set environment variables in Coolify

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

## 5. Set the domain

Set the domain on the **`nginx`** service, pointing at container port **80**.

`nginx` is the only entry point: it proxies `/` to the frontend, `/api/` to the backend
and `/storage/` to MinIO. The other four services use `expose` only, so they are not
reachable from outside the Compose network.

## 6. Deploy

Coolify pulls both images and starts five containers. Expect well under a minute.

On first boot the backend applies 815 Liquibase changesets and creates the
`atlas-bucket` bucket in MinIO automatically.

## Redeploying after a code change

Pushing to `main` under `api/**` or `frontend/**` rebuilds and republishes `latest`
automatically. Wait for **Build & publish deployment images** to finish, then redeploy
in Coolify.

## Memory footprint

Measured at idle with the full stack running:

| Service  | Memory  |
|----------|---------|
| api      | 977 MB  |
| minio    | 224 MB  |
| postgres | 72 MB   |
| nginx x2 | ~20 MB  |
| **Total**| ~1.3 GB |

Treat this as a floor. The API's JVM claims more under load, since its default max heap
is a quarter of host RAM.

## Troubleshooting

**`denied` / `unauthorized` when pulling** — the packages are still private. Redo step 2.

**`Connection timed out during banner exchange`** — the server is alive but too
resource-starved to fork sshd, so Coolify loses its control connection. Confirm with
`journalctl -k | grep -i "out of memory"` and `free -h`, then reboot. This is what
happened when images were built on the server.

**`exec format error`** — architecture mismatch. See step 3.

**Postgres exits immediately** — `POSTGRES_PWD` is unset. See step 4.
