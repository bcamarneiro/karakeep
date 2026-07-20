#!/usr/bin/env bash
# Restore (or verify) a karakeep `data` volume from a backup.sh tarball.
#
#   ./docker/restore.sh <backup.tar.gz>            # DESTRUCTIVE: replaces the real volume
#   ./docker/restore.sh --verify <backup.tar.gz>   # SAFE: proves the backup in a throwaway volume, touches nothing real
#   DATA_VOL=my_data ./docker/restore.sh ...        # override volume auto-detection
#   COMPOSE=/path/compose.yml ./docker/restore.sh ...
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
COMPOSE="${COMPOSE:-$HERE/docker-compose.homelab.yml}"

VERIFY=0
ARGS=()
for a in "$@"; do
  case "$a" in
    --verify) VERIFY=1 ;;
    *) ARGS+=("$a") ;;
  esac
done
ARCHIVE="${ARGS[0]:?Usage: $0 [--verify] <backup.tar.gz>}"
[ -f "$ARCHIVE" ] || { echo "No such file: $ARCHIVE"; exit 1; }
ARCDIR=$(cd "$(dirname "$ARCHIVE")" && pwd); ARCNAME=$(basename "$ARCHIVE")

# ---- SAFE verify mode: restore into a throwaway volume and check the DB ----
if [ "$VERIFY" = "1" ]; then
  THROW="karakeep_verify_$$"
  echo "Verifying '$ARCNAME' in throwaway volume '$THROW' (nothing real is touched)…"
  docker volume create "$THROW" >/dev/null
  trap 'docker volume rm "$THROW" >/dev/null 2>&1 || true' EXIT
  docker run --rm -v "$THROW":/data -v "$ARCDIR":/backup alpine sh -c '
    set -e
    tar xzf "/backup/'"$ARCNAME"'" -C /data
    apk add --no-cache sqlite >/dev/null 2>&1
    integ=$(sqlite3 /data/db.db "PRAGMA integrity_check;" 2>&1 | head -1)
    objects=$(sqlite3 /data/db.db "select count(*) from sqlite_master;" 2>/dev/null || echo 0)
    books=$(sqlite3 /data/db.db "select count(*) from bookmarks;" 2>/dev/null || echo n/a)
    assets=$(find /data/assets -type f 2>/dev/null | wc -l | tr -d " ")
    echo "  integrity:      $integ"
    echo "  schema objects: $objects"
    echo "  bookmarks:      $books"
    echo "  assets:         $assets"
    [ "$integ" = "ok" ] || { echo "  -> integrity check FAILED"; exit 1; }
    [ "$objects" -gt 0 ] 2>/dev/null || { echo "  -> empty schema"; exit 1; }
  '
  echo "VERIFIED: '$ARCNAME' restores cleanly and the database is intact."
  exit 0
fi

# ---- DESTRUCTIVE restore into the real volume ----
DATA_VOL="${DATA_VOL:-}"
if [ -z "$DATA_VOL" ]; then
  PROJECT=$(docker compose -f "$COMPOSE" config 2>/dev/null | awk -F': *' '/^name:/{print $2; exit}')
  [ -z "${PROJECT:-}" ] && PROJECT=$(basename "$(cd "$(dirname "$COMPOSE")/.." && pwd)")
  DATA_VOL="${PROJECT}_data"
fi

echo "This REPLACES all data in volume '$DATA_VOL' with '$ARCHIVE'."
echo "(Roll back later by restoring your previous backup into the same volume.)"
printf "Type 'restore' to confirm: "
read -r ans
[ "$ans" = "restore" ] || { echo "Aborted."; exit 1; }

echo "Stopping stack…"
docker compose -f "$COMPOSE" down
docker volume create "$DATA_VOL" >/dev/null

echo "Restoring into '$DATA_VOL'…"
docker run --rm -v "$DATA_VOL":/data -v "$ARCDIR":/backup alpine \
  sh -c "rm -rf /data/* /data/..?* 2>/dev/null; tar xzf '/backup/$ARCNAME' -C /data"

echo "Starting stack…"
docker compose -f "$COMPOSE" up -d

echo "Restored. Rebuild the search index: Admin Settings → Background Jobs → Reindex All Bookmarks."
