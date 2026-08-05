#!/usr/bin/env bash
# One-time server setup for refusalgpt.cyou. NEEDS SUDO, so it needs a real
# terminal — sudo cannot prompt through Claude Code's Bash tool.
#
# Run it ON THE DROPLET:
#   scp deploy/refusalgpt.cyou deploy/install-nginx.sh eric@68.183.63.41:~/
#   ssh eric@68.183.63.41
#   sudo bash ~/install-nginx.sh
#
# Everything else — the app, the static site — deploys as `eric` with no sudo.
# This script is the only root-owned step, and it only has to run once.
set -euo pipefail

DOMAIN="refusalgpt.cyou"
ROOT="/var/www/${DOMAIN}"
OWNER="eric"
CONF_SRC="$(dirname "$(readlink -f "$0")")/${DOMAIN}"

if [[ $EUID -ne 0 ]]; then
  echo "  This needs root. Run: sudo bash $0" >&2
  exit 1
fi

echo "[1/5] Static root at ${ROOT}, owned by ${OWNER}"
# Owned by eric so web/deploy.sh can rsync into it without sudo, which is what
# keeps every subsequent deploy runnable from a non-interactive shell.
mkdir -p "${ROOT}"
chown -R "${OWNER}:${OWNER}" "${ROOT}"
chmod 755 "${ROOT}"

echo "[2/5] Installing the vhost"
if [[ ! -f "${CONF_SRC}" ]]; then
  echo "  Cannot find ${CONF_SRC} — scp it up alongside this script." >&2
  exit 1
fi
if [[ -f "/etc/nginx/sites-available/${DOMAIN}" ]]; then
  # Certbot rewrites the live file in place. Clobbering it would drop the TLS
  # block and take the site down until certbot were re-run.
  backup="/etc/nginx/sites-available/${DOMAIN}.bak.$(date +%s)"
  echo "  Existing config found — backing up to ${backup}"
  cp "/etc/nginx/sites-available/${DOMAIN}" "${backup}"
fi
cp "${CONF_SRC}" "/etc/nginx/sites-available/${DOMAIN}"
ln -sfn "/etc/nginx/sites-available/${DOMAIN}" "/etc/nginx/sites-enabled/${DOMAIN}"

echo "[3/5] Validating"
# Never reload a broken config. If this fails nothing has changed yet, because
# a reload only swaps in a config that already validated.
nginx -t

echo "[4/5] Reloading nginx"
systemctl reload nginx

echo "[5/5] TLS"
# refusalgpt.cyou is not covered by the *.pinecone.website wildcard, so it needs
# its own certificate. --nginx rewrites the vhost above to add the 443 block and
# the port-80 redirect.
echo "  Requesting a certificate for ${DOMAIN} and www.${DOMAIN}…"
certbot --nginx -d "${DOMAIN}" -d "www.${DOMAIN}" --agree-tos --redirect

echo
echo "  Done. Now, from the repo on your laptop:"
echo "    cd api && ./deploy.sh     # the gateway"
echo "    cd web && ./deploy.sh     # the site"
