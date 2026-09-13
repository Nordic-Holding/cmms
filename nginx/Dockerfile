FROM nginx:1.27-alpine

# Baked in rather than bind-mounted: PaaS platforms (Coolify, Dokploy, ...) run the
# Compose file from a directory that doesn't hold the repository, so a relative bind
# mount of this file resolves to a missing path that Docker then creates as a directory.
COPY default.conf /etc/nginx/conf.d/default.conf
