#!/bin/sh
# Encrypted Postgres backup for DentalBOT.
#
#   backup.sh once   one backup now
#   backup.sh loop   one backup a day at BACKUP_HOUR_UTC (the container's default)
#
# The dump is encrypted with `age` for BACKUP_AGE_RECIPIENT (a public key). The private
# key never goes to the VPS, so a stolen backup is unreadable. Files older than
# BACKUP_KEEP_DAYS are removed. With RCLONE_REMOTE set (e.g. "drive:dentalbot-backups"),
# each backup is also copied off the VPS with rclone.
set -eu
set -o pipefail
umask 077

: "${BACKUP_AGE_RECIPIENT:?BACKUP_AGE_RECIPIENT is required: backups are never stored unencrypted}"
KEEP_DAYS="${BACKUP_KEEP_DAYS:-14}"
HOUR="${BACKUP_HOUR_UTC:-6}"
DIR=/backups

run() {
  file="$DIR/dentalbot-$(date -u +%Y%m%dT%H%M%SZ).dump.age"
  pg_dump --format=custom -h postgres -U dentalbot dentalbot |
    age -r "$BACKUP_AGE_RECIPIENT" >"$file.tmp"
  mv "$file.tmp" "$file"
  find "$DIR" -name 'dentalbot-*.dump.age' -mtime +"$KEEP_DAYS" -delete
  if [ -n "${RCLONE_REMOTE:-}" ]; then
    rclone copy "$DIR" "$RCLONE_REMOTE" --include 'dentalbot-*.dump.age'
    rclone delete "$RCLONE_REMOTE" --include 'dentalbot-*.dump.age' --min-age "${KEEP_DAYS}d"
  fi
  echo "backup ok: $(basename "$file") ($(wc -c <"$file") bytes)"
}

seconds_until_next_run() {
  now=$(date -u +%s)
  next=$(date -u -d "$(date -u +%Y-%m-%d) $(printf '%02d' "$HOUR"):00:00" +%s)
  [ "$next" -gt "$now" ] || next=$((next + 86400))
  echo $((next - now))
}

case "${1:-loop}" in
  once) run ;;
  loop)
    while true; do
      sleep "$(seconds_until_next_run)"
      # A failed night must not stop the next ones; the log shows it.
      run || echo "backup FAILED at $(date -u +%FT%TZ)" >&2
    done
    ;;
  *)
    echo "usage: backup.sh once|loop" >&2
    exit 2
    ;;
esac
