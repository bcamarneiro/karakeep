#!/usr/bin/env bash
# Restore a karakeep `data` volume from a backup.sh tarball.
# DESTRUCTIVE: replaces everything in the target volume.
#
# Usage:
#   ./docker/restore.sh <backup.tar.gz>
#   DATA_VOL=my_data ./docker/restore.sh <backup.tar.gz>   # override auto-detection
#   COMPOSE=/path/compose.yml ./docker/restore.sh <backup.tar.gz>
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
COMPOSE="${COMPOSE:-$HERE/docker-compose.homelab.yml}"
ARCHIVE="${1:?Usage: $0 <backup.tar.gz>}"
[ -f "$ARCHIVE" ] || { echo "No such file: $ARCHIVE"; exit 1; }

DATA_VOL="${DATA_VOL:-}"
if [ -z "$DATA_VOL" ]; then
  PROJECT=$(docker compose -f "$COMPOSE" config 2>/dev/null | awk -F': *' '/^name:/{print $2; exit}')
  [ -z "${PROJECT:-}" ] && PROJECT=$(basename "$(cd "$(dirname "$COMPOSE")/.." && pwd)")
  DATA_VOL="${PROJECT}_data"
fi

echo "This REPLACES all data in volume '$DATA_VOL' with '$ARCHIVE'."
printf "Type 'restore' to confirm: "
read -r ans
[ "$ans" = "restore" ] || { echo "Aborted."; exit 1; }

echo "Stopping stack…"
docker compose -f "$COMPOSE" down
docker volume create "$DATA_VOL" >/dev/null

ARCDIR=$(cd "$(dirname "$ARCHIVE")" && pwd); ARCNAME=$(basename "$ARCHIVE")
echo "Restoring into '$DATA_VOL'…"
docker run --rm -v "$DATA_VOL":/data -v "$ARCDIR":/backup alpine \
  sh -c "rm -rf /data/* /data/..?* 2>/dev/null; tar xzf '/backup/$ARCNAME' -C /data"

echo "Starting stack…"
docker compose -f "$COMPOSE" up -d

echo "Restored. Rebuild the search index: Admin Settings → Background Jobs → Reindex All Bookmarks."
