#!/usr/bin/env bash
# Full-fidelity backup of a karakeep homelab instance.
# Archives the `data` volume (SQLite db.db + assets) into a tarball, then
# verifies the archive is non-empty and contains db.db before declaring success.
# Meilisearch is derived data — not backed up here; reindex after restore.
#
# Usage:
#   ./docker/backup.sh [output.tar.gz]
#   DATA_VOL=my_data ./docker/backup.sh        # override volume auto-detection
#   COMPOSE=/path/compose.yml ./docker/backup.sh
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
COMPOSE="${COMPOSE:-$HERE/docker-compose.homelab.yml}"
OUT="${1:-karakeep-backup-$(date +%Y%m%d-%H%M%S).tar.gz}"

# Resolve the data volume name: explicit override → compose's resolved name →
# guess from the repo dir → validate it exists (list candidates if not).
DATA_VOL="${DATA_VOL:-}"
if [ -z "$DATA_VOL" ]; then
  PROJECT=$(docker compose -f "$COMPOSE" config 2>/dev/null | awk -F': *' '/^name:/{print $2; exit}')
  [ -z "${PROJECT:-}" ] && PROJECT=$(basename "$(cd "$(dirname "$COMPOSE")/.." && pwd)")
  DATA_VOL="${PROJECT}_data"
fi
if ! docker volume inspect "$DATA_VOL" >/dev/null 2>&1; then
  echo "Data volume '$DATA_VOL' not found. Candidates ending in _data:"
  docker volume ls -q | grep -E '_data$' | sed 's/^/  /' || echo "  (none)"
  echo "Re-run with an explicit name:  DATA_VOL=<name> $0 [output.tar.gz]"
  exit 1
fi

OUTDIR=$(cd "$(dirname "$OUT")" && pwd); OUTNAME=$(basename "$OUT")

echo "Stopping stack for a consistent copy (SQLite must be at rest)…"
docker compose -f "$COMPOSE" down

echo "Archiving volume '$DATA_VOL' → $OUTDIR/$OUTNAME"
docker run --rm -v "$DATA_VOL":/data:ro -v "$OUTDIR":/backup alpine \
  tar czf "/backup/$OUTNAME" -C /data .

echo "Restarting stack…"
docker compose -f "$COMPOSE" up -d

# Verify the archive before trusting it — a silently-empty backup is the worst case.
echo "Verifying archive…"
LIST=$(tar tzf "$OUTDIR/$OUTNAME")
if ! grep -qE '(^|/)db\.db$' <<<"$LIST"; then
  echo "ERROR: db.db not found in the archive — this backup is NOT usable."
  echo "Kept for inspection: $OUTDIR/$OUTNAME"
  exit 1
fi
ASSETS=$(grep -cE '/assets/.+' <<<"$LIST" || true)
echo "OK: db.db present, ~${ASSETS} asset entries. Size $(du -h "$OUTDIR/$OUTNAME" | cut -f1)."
echo "Backup: $OUTDIR/$OUTNAME"
echo "Tip: prove it end-to-end with:  ./docker/restore.sh --verify '$OUTDIR/$OUTNAME'"
