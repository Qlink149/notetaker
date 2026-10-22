#!/usr/bin/env bash
# Replace the worker on the droplet with an image from the Vultr registry. Installed as
# /opt/meetingid/deploy-worker.sh and run only through the CI deploy key, whose authorized_keys entry forces
# this command (the key can do nothing else). CI connects with:
#   ssh root@droplet "deploy <git sha> <registry user>"   and the registry password on stdin.
# A meeting being processed is never cut short: the deploy waits until the worker is idle (up to 30 minutes)
# and gives up otherwise. If the new worker is not healthy within a minute, the previous image runs again.
set -euo pipefail

REGISTRY=blr.vultrcr.com
REPO=blr.vultrcr.com/qlink01/meetingid-worker
NAME=meetingid-worker
ENV_FILE=/etc/meetingid/worker.env
WAIT_TRIES=60 # x 30 s = 30 min

log() { echo "[deploy $(date -u +%H:%M:%S)] $*"; }

read -r cmd tag user _ <<<"${SSH_ORIGINAL_COMMAND:-${*:-}}"
if [[ "${cmd:-}" != deploy || ! "${tag:-}" =~ ^[a-f0-9]{7,40}$ || ! "${user:-}" =~ ^[A-Za-z0-9-]{8,64}$ ]]; then
  echo "usage: deploy <git sha> <registry user>  (registry password on stdin)" >&2
  exit 2
fi
IFS= read -r password || true
if [[ -z "${password:-}" ]]; then
  echo "registry password missing on stdin" >&2
  exit 2
fi
printf '%s' "$password" | docker login "$REGISTRY" -u "$user" --password-stdin >/dev/null
unset password

image="$REPO:$tag"
log "pulling $image"
docker pull -q "$image" >/dev/null

# The busy check runs from the new image (same database query), so it works even when the running worker is
# an older build without it. Exit 0 = idle, 3 = busy; anything else counts as busy too.
for i in $(seq 1 "$WAIT_TRIES"); do
  if docker run --rm --memory 300m --env-file "$ENV_FILE" "$image" node apps/api/dist/scripts/busy.js; then
    break
  fi
  if [[ "$i" == "$WAIT_TRIES" ]]; then
    log "a meeting is still processing after 30 minutes; not deploying (run the deploy again later)"
    exit 4
  fi
  log "a meeting is processing; waiting 30 s"
  sleep 30
done

previous=$(docker inspect -f '{{.Config.Image}}' "$NAME" 2>/dev/null || true)

run() {
  docker run -d --name "$NAME" --restart unless-stopped \
    --memory 850m --memory-swap 2800m -p 10000:10000 \
    --env-file "$ENV_FILE" "$1" >/dev/null
}
healthy() {
  for _ in $(seq 1 30); do
    if curl -fsS http://127.0.0.1:10000/health >/dev/null 2>&1; then return 0; fi
    sleep 2
  done
  return 1
}

log "replacing ${previous:-nothing} with $image"
# the worker finishes or hands back its jobs within 25 s of SIGTERM; give it 40
docker stop -t 40 "$NAME" >/dev/null 2>&1 || true
docker rm "$NAME" >/dev/null 2>&1 || true
run "$image"

if healthy; then
  log "worker $tag is up"
  # drop images nothing uses that are older than a week (the previous one stays for a manual roll-back)
  docker image prune -af --filter "until=168h" >/dev/null 2>&1 || true
  exit 0
fi

log "new worker not healthy; last log lines:"
docker logs --tail 40 "$NAME" 2>&1 || true
docker rm -f "$NAME" >/dev/null 2>&1 || true
if [[ -n "$previous" ]]; then
  run "$previous"
  if healthy; then log "rolled back to $previous"; else log "roll-back to $previous is not healthy either"; fi
fi
exit 5
