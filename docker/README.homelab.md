# Homelab / self-built karakeep

Personal deployment of karakeep built from this fork's `local-integration`
branch, which stacks two features on top of upstream:

- **Link-shortener resolution** (search.app / share.google) — always on.
- **Instagram text extraction** — opt-in via `CRAWLER_INSTAGRAM_ENABLED`.

Everything here is additive to upstream and lives on the `homelab-config`
branch, so it is reproducible by the weekly refresh (see the bottom).

## Files

| File | Purpose |
|------|---------|
| `docker-compose.homelab.yml` | Builds the all-in-one image from this checkout (not the published image) + Chrome + Meilisearch. |
| `.env.homelab.example` | Template for secrets and the feature flags. Copy to `docker/.env`. |
| `backup.sh` | Archive the `data` volume (SQLite db + assets) to a tarball. |
| `restore.sh` | Restore that tarball into the `data` volume (destructive). |

## Deploy

```bash
git clone https://github.com/bcamarneiro/karakeep.git
cd karakeep && git checkout local-integration

cp docker/.env.homelab.example docker/.env
# edit docker/.env: NEXTAUTH_SECRET, MEILI_MASTER_KEY (openssl rand -base64 36),
#                   NEXTAUTH_URL (your homelab address)

docker compose -f docker/docker-compose.homelab.yml up -d --build
```

Open `http://<host>:3000`. The first build is slow (compiles the monorepo,
pulls yt-dlp + Chrome). Update later with:

```bash
git pull && docker compose -f docker/docker-compose.homelab.yml up -d --build
```

## Instagram feature

Needs a logged-in session as cookies. `--cookies-from-browser` does **not**
work in the headless container — export a `cookies.txt` (Netscape format, via a
browser extension) and mount it:

```
# docker/.env
CRAWLER_INSTAGRAM_ENABLED=true
CRAWLER_YTDLP_ARGS=--cookies%%/cookies/instagram.txt
```

```bash
cp /path/to/cookies.txt docker/instagram-cookies.txt   # mounted read-only by the compose file
```

Instagram sessions expire — refresh the file when extraction stops resolving.
Reel *media* download additionally needs `CRAWLER_VIDEO_DOWNLOAD=true`.

## Backup & restore

All your data (bookmarks, users, settings, assets, archives) is in the `data`
volume. Meilisearch is a derived search index — not backed up; rebuild it after
a restore via **Admin Settings → Background Jobs → Reindex All Bookmarks**.

```bash
./docker/backup.sh                      # → karakeep-backup-<timestamp>.tar.gz
./docker/backup.sh /mnt/nas/kk.tar.gz   # or a path of your choice
./docker/restore.sh <backup.tar.gz>     # destructive; asks for confirmation
```

Both auto-detect the volume name; override with `DATA_VOL=<name>` if needed.
`backup.sh` stops the stack first so SQLite is copied at rest.

## Migrating homelab ↔ local (no data loss)

1. On the machine you used **last**: `./docker/backup.sh`
2. Copy the tarball to the other machine (`scp` / `rsync`).
3. There: `./docker/restore.sh <file>`, then reindex.
4. Keep the same `NEXTAUTH_SECRET` on both (a different one keeps your data but
   forces re-login); set `NEXTAUTH_URL` per host.

⚠️ This is a one-way snapshot each time, **not** bidirectional sync. Treat one
machine as the source of truth at a time — copy the full state across before
switching, and don't edit both in parallel (last copy wins).

Keep both machines on the same build (both use `local-integration`); karakeep
runs schema migrations forward-only on startup, so restoring newer data onto an
older image can break.

## Staying current with upstream

`local-integration` is kept fresh by a GitHub Action on the fork
(`.github/workflows/refresh-integration.yml`, weekly + manual): it rebuilds the
branch from `upstream/main` + the feature branches + `homelab-config`, pushing
only when the content changed, and opens a tracking issue if a merge ever
conflicts. To pick up refreshes on the homelab, re-run the update command above
(or add a cron that does `git fetch fork && git reset --hard fork/local-integration`
followed by the `up -d --build`).
