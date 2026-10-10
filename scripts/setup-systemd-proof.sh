#!/bin/sh
# Provision only the CI runner's own user manager and an ephemeral unit.
set -eu
uid=$(id -u)
sudo loginctl enable-linger "$(id -un)"
sudo systemctl start "user@$uid.service"
export XDG_RUNTIME_DIR="/run/user/$uid"
export DBUS_SESSION_BUS_ADDRESS="unix:path=$XDG_RUNTIME_DIR/bus"
unit="proc-safe-proof-${GITHUB_RUN_ID:-local}-$$.service"
systemd-run --user --unit="$unit" --property=Type=oneshot --property=RemainAfterExit=yes /bin/true
if [ -n "${GITHUB_ENV:-}" ]; then
  echo "XDG_RUNTIME_DIR=$XDG_RUNTIME_DIR" >> "$GITHUB_ENV"
  echo "DBUS_SESSION_BUS_ADDRESS=$DBUS_SESSION_BUS_ADDRESS" >> "$GITHUB_ENV"
  echo "PROC_SAFE_SYSTEMD_UNIT=$unit" >> "$GITHUB_ENV"
  echo "PROC_SAFE_SYSTEMD_PROOF=1" >> "$GITHUB_ENV"
  echo "PROC_SAFE_SYSTEMD_MACHINE=@.host" >> "$GITHUB_ENV"
fi
printf 'PROC_SAFE_SYSTEMD_UNIT=%s\n' "$unit"
