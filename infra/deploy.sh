#!/usr/bin/env bash
# Builds and (re)starts everything from a checkout in /opt/app-generator, and
# installs what a release can change outside of it: the sandbox launcher and
# its settings.
# Usage: sudo ./deploy.sh [git-ref]
set -euo pipefail

[[ $EUID -eq 0 ]] || { echo "run as root" >&2; exit 1; }
repo=/opt/app-generator
etc=/etc/app-generator
ref=${1:-main}

if [[ ! -d $repo/.git ]]; then
  git clone --quiet https://github.com/LukasB3/app-generator.git "$repo"
fi
git -C "$repo" fetch --quiet origin
git -C "$repo" checkout --quiet --detach "origin/$ref"
# The checkout may have brought a new version of this script. Start over with it.
if [[ -z ${DEPLOY_RESTARTED:-} ]]; then
  DEPLOY_RESTARTED=1 exec "$repo/infra/deploy.sh" "$ref"
fi

cd "$repo/orchestrator"
npm ci --ignore-scripts --no-audit --no-fund
npm run build
npm prune --omit=dev --no-audit --no-fund

cd "$repo/infra"
# The launcher and the orchestrator that calls it must be of the same release.
install -o root -g root -m 755 ag-sandbox /usr/local/sbin/ag-sandbox
install -o root -g root -m 644 sandbox.conf "$etc/sandbox.conf"

# The database gateway's secrets are made once and never overwritten: the
# secret its passes are signed with, which the orchestrator shares, and the
# password of its database role. The database learns that password from the
# statement that gate-role.mjs prints.
if [[ ! -f $etc/dbgate.env ]]; then
  random() { head -c 32 /dev/urandom | base64 | tr -d '=+/'; }
  signing=$(sed -n 's/^GATE_SIGNING_SECRET=//p' "$etc/orchestrator.env")
  if [[ -z $signing ]]; then
    signing=$(random)
    printf '\nGATE_SIGNING_SECRET=%s\n' "$signing" >> "$etc/orchestrator.env"
  fi
  install -o root -g root -m 600 /dev/null "$etc/dbgate.env"
  printf 'GATE_SIGNING_SECRET=%s\nPGPASSWORD=%s\n' "$signing" "$(random)" > "$etc/dbgate.env"
  echo "The database gateway has a new password. Give it to the database: ./gate-role.mjs"
fi

docker compose --profile build build --quiet
docker compose up --detach

systemctl restart app-generator
sleep 2
systemctl --no-pager --lines=5 status app-generator
curl -fsS http://127.0.0.1:8787/api/health && echo
# The gateway is ready once its role can log in. Until then nothing depends on it.
curl -fsS --max-time 15 http://127.0.0.1:8789/healthz && echo || echo "The database gateway is not ready, see: docker logs ag-dbgate"
