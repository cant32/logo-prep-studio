# Railway (or any Docker host) serves the tool's files with Caddy.
# The tool runs in each person's browser; this server only hands out the
# page, scripts and AI models, and never sees a logo.
FROM caddy:2.8.4-alpine
COPY Caddyfile /etc/caddy/Caddyfile
COPY . /srv
