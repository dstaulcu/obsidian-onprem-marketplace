#!/bin/sh
# Rotates the registry's access log and the admin audit log, with retention you can set from the environment.
#   OM_ACCESS_LOG_DAYS   daily files of the nginx access log to keep   (default 14)
#   OM_AUDIT_LOG_DAYS    daily files of the admin audit log to keep    (default 14)
#   OM_LOG_MAX_SIZE      rotate early once a log passes this size       (default 50M)
# Bad values fall back to the default with a warning; a typo must never shorten retention to nothing.
set -u

days() { # name default
  eval "v=\${$1:-}"
  case "$v" in
    "") echo "$2" ;;
    *[!0-9]*|0|0[0-9]*) echo "logrotate: $1='$v' is not a whole number >= 1; using $2" >&2; echo "$2" ;;
    *) if [ "$v" -gt 3650 ]; then echo "logrotate: $1='$v' is above 3650; using $2" >&2; echo "$2"; else echo "$v"; fi ;;
  esac
}
size() {
  case "${OM_LOG_MAX_SIZE:-}" in
    "") echo 50M ;;
    [1-9]*[kKMG]) case "${OM_LOG_MAX_SIZE%[kKMG]}" in *[!0-9]*) echo "logrotate: OM_LOG_MAX_SIZE='$OM_LOG_MAX_SIZE' is invalid; using 50M" >&2; echo 50M ;; *) echo "$OM_LOG_MAX_SIZE" ;; esac ;;
    *) echo "logrotate: OM_LOG_MAX_SIZE='$OM_LOG_MAX_SIZE' is invalid (examples: 100k, 50M, 1G); using 50M" >&2; echo 50M ;;
  esac
}

ACCESS=$(days OM_ACCESS_LOG_DAYS 14)
AUDIT=$(days OM_AUDIT_LOG_DAYS 14)
MAX=$(size)

# copytruncate: nginx keeps its file open and the admin tails by inode+offset, so we copy and empty in place.
# Only the exact log files are named, so the admin's state directory (/audit/state) is never touched.
cat > /tmp/logrotate.conf <<EOF
/var/log/om/access.log {
  daily
  rotate $ACCESS
  maxsize $MAX
  copytruncate
  compress
  delaycompress
  missingok
  notifempty
  dateext
}
/audit/admin-audit.jsonl {
  daily
  rotate $AUDIT
  maxsize $MAX
  copytruncate
  compress
  delaycompress
  missingok
  notifempty
  dateext
}
EOF

echo "logrotate: access log ${ACCESS} days, audit log ${AUDIT} days, rotate early above ${MAX}; checked hourly"
while true; do
  logrotate -s /tmp/logrotate.state /tmp/logrotate.conf || echo "logrotate: run failed" >&2
  sleep 3600
done
