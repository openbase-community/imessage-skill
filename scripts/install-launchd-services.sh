#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
generated_dir="$repo_dir/.generated/launchd"

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Run with sudo: sudo $0" >&2
  exit 1
fi

run_user="${SUDO_USER:-}"
if [[ -z "$run_user" || "$run_user" == "root" ]]; then
  run_user="$(/usr/bin/stat -f '%Su' "$repo_dir")"
fi
user_home="$(/usr/bin/dscl . -read "/Users/$run_user" NFSHomeDirectory 2>/dev/null | /usr/bin/awk '{print $2; exit}')"
if [[ -z "$user_home" ]]; then user_home="/Users/$run_user"; fi

runtime_dir="${IMESSAGE_RUNTIME_HOME:-$user_home/.imessage-cli}"
data_dir="$runtime_dir/data"
logs_dir="$runtime_dir/logs"
inbox_dir="$runtime_dir/inbox"

label_prefix="${IMESSAGE_LAUNCHD_LABEL_PREFIX:-com.$run_user.imessage}"
import_label="$label_prefix-import"
backup_label="$label_prefix-backup-helper"
node_bin="${IMESSAGE_NODE_BIN:-/opt/homebrew/bin/node}"
helper_app="/Applications/iMessage CLI Backup Helper.app"

if [[ ! -x "$node_bin" ]]; then
  echo "Missing executable node at $node_bin" >&2
  exit 1
fi

ensure_user_group() {
  local id
  id="$(next_service_id)"
  if ! /usr/bin/dscl . -read /Groups/imessage-data >/dev/null 2>&1; then
    /usr/sbin/dseditgroup -o create -i "$id" -r "iMessage data readers" imessage-data
  fi
  if ! /usr/bin/dscl . -read /Users/_imessage >/dev/null 2>&1; then
    /usr/bin/dscl . -create /Users/_imessage
    /usr/bin/dscl . -create /Users/_imessage UniqueID "$id"
    /usr/bin/dscl . -create /Users/_imessage PrimaryGroupID "$id"
    /usr/bin/dscl . -create /Users/_imessage UserShell /usr/bin/false
    /usr/bin/dscl . -create /Users/_imessage NFSHomeDirectory /var/empty
    /usr/bin/dscl . -create /Users/_imessage RealName "iMessage CLI Importer"
    /usr/bin/dscl . -create /Users/_imessage Password '*'
    /usr/bin/dscl . -create /Users/_imessage IsHidden 1
  fi
  /usr/sbin/dseditgroup -o edit -a _imessage -t user imessage-data
  /usr/sbin/dseditgroup -o edit -a _imessage -t user staff
  /usr/sbin/dseditgroup -o edit -a "$run_user" -t user imessage-data
}

next_service_id() {
  {
    /usr/bin/dscl . list /Users UniqueID | /usr/bin/awk '$2 >= 450 && $2 < 500 {print $2}'
    /usr/bin/dscl . list /Groups PrimaryGroupID | /usr/bin/awk '$2 >= 450 && $2 < 500 {print $2}'
  } | /usr/bin/sort -n | /usr/bin/awk '
    BEGIN { candidate=450; printed=0 }
    $1 == candidate { candidate++ }
    $1 > candidate { print candidate; printed=1; exit }
    END { if (!printed && candidate < 500) print candidate }
  ' | /usr/bin/head -1
}

escape_sed_replacement() {
  printf '%s' "$1" | /usr/bin/sed -e 's/[\/&]/\\&/g'
}

render_plist() {
  local template="$1"
  local output="$2"
  /bin/mkdir -p "$(dirname "$output")"
  /usr/bin/sed \
    -e "s/{{REPO_DIR}}/$(escape_sed_replacement "$repo_dir")/g" \
    -e "s/{{RUNTIME_DIR}}/$(escape_sed_replacement "$runtime_dir")/g" \
    -e "s/{{LOG_DIR}}/$(escape_sed_replacement "$logs_dir")/g" \
    -e "s/{{USER_HOME}}/$(escape_sed_replacement "$user_home")/g" \
    -e "s/{{NODE_BIN}}/$(escape_sed_replacement "$node_bin")/g" \
    -e "s/{{IMPORT_LABEL}}/$(escape_sed_replacement "$import_label")/g" \
    -e "s/{{BACKUP_LABEL}}/$(escape_sed_replacement "$backup_label")/g" \
    -e "s/{{HELPER_APP}}/$(escape_sed_replacement "$helper_app")/g" \
    "$template" > "$output"
  /usr/bin/plutil -lint "$output" >/dev/null
}

echo "Creating service user and group..."
ensure_user_group

echo "Ensuring runtime directories..."
/usr/bin/install -d -o _imessage -g imessage-data -m 710 "$runtime_dir"
/usr/bin/install -d -o _imessage -g imessage-data -m 710 "$data_dir"
/usr/bin/install -d -o _imessage -g imessage-data -m 750 "$data_dir/catalog"
/usr/bin/install -d -o _imessage -g imessage-data -m 750 "$data_dir/approved"
/usr/bin/install -d -o _imessage -g imessage-data -m 770 "$data_dir/outbox"
/usr/bin/install -d -o _imessage -g imessage-data -m 700 "$data_dir/protected"
/usr/bin/install -d -o _imessage -g imessage-data -m 700 "$data_dir/protected/source"
/usr/bin/install -d -o _imessage -g imessage-data -m 700 "$data_dir/protected/source/snapshots"
/usr/bin/install -d -o _imessage -g imessage-data -m 770 "$inbox_dir"
/usr/bin/install -d -o _imessage -g imessage-data -m 770 "$logs_dir"

chown -R _imessage:imessage-data "$data_dir/catalog" "$data_dir/approved" "$data_dir/outbox" "$data_dir/protected" "$inbox_dir" "$logs_dir"
chmod 750 "$data_dir/catalog" "$data_dir/approved"
chmod 770 "$data_dir/outbox" "$inbox_dir" "$logs_dir"
chmod 700 "$data_dir/protected" "$data_dir/protected/source" "$data_dir/protected/source/snapshots"
find "$data_dir/catalog" -type f -exec chmod 640 {} + 2>/dev/null || true
find "$data_dir/approved" -type f -name 'approved.sqlite*' -exec chmod 640 {} + 2>/dev/null || true
find "$data_dir/outbox" -type f -name 'outbox.sqlite*' -exec chmod 660 {} + 2>/dev/null || true
find "$logs_dir" -type f -exec chmod 660 {} + 2>/dev/null || true

echo "Building backup helper..."
helper_build_root="$(/usr/bin/mktemp -d /tmp/imessage-helper-build.XXXXXX)"
trap 'rm -rf "$helper_build_root"' EXIT
helper_build="$(IMESSAGE_HELPER_BUILD_DIR="$helper_build_root" "$repo_dir/scripts/build-backup-helper.sh")"
rm -rf "$helper_app"
cp -R "$helper_build" "$helper_app"
chown -R "$run_user":admin "$helper_app"

echo "Rendering launchd plists..."
render_plist "$repo_dir/launchd/imessage-import.plist.template" "$generated_dir/$import_label.plist"
render_plist "$repo_dir/launchd/imessage-backup-helper.plist.template" "$generated_dir/$backup_label.plist"

import_target="/Library/LaunchDaemons/$import_label.plist"
cp "$generated_dir/$import_label.plist" "$import_target"
chown root:wheel "$import_target"
chmod 644 "$import_target"
launchctl bootout "system/$import_label" 2>/dev/null || true
launchctl bootstrap system "$import_target"
launchctl kickstart -k "system/$import_label"

agent_target="$user_home/Library/LaunchAgents/$backup_label.plist"
install -d -o "$run_user" -g staff -m 755 "$user_home/Library/LaunchAgents"
cp "$generated_dir/$backup_label.plist" "$agent_target"
chown "$run_user":staff "$agent_target"
chmod 644 "$agent_target"
launchctl bootout "gui/$(id -u "$run_user")/$backup_label" 2>/dev/null || true
launchctl asuser "$(id -u "$run_user")" launchctl bootstrap "gui/$(id -u "$run_user")" "$agent_target" 2>/dev/null || true

echo "Installed iMessage CLI importer and backup helper."
echo "Grant Full Disk Access to: $helper_app"
