#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
build_dir="${IMESSAGE_HELPER_BUILD_DIR:-$repo_dir/.build/helper}"
app_dir="$build_dir/iMessage CLI Backup Helper.app"
exe="$app_dir/Contents/MacOS/imessage-backup-helper"

rm -rf "$app_dir"
mkdir -p "$app_dir/Contents/MacOS" "$app_dir/Contents/Resources"

swiftc "$repo_dir/helper/ImessageBackupHelper/main.swift" -o "$exe"
chmod 755 "$exe"

cat > "$app_dir/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleIdentifier</key>
    <string>dev.local.imessage-cli.backup-helper</string>
    <key>CFBundleName</key>
    <string>iMessage CLI Backup Helper</string>
    <key>CFBundleDisplayName</key>
    <string>iMessage CLI Backup Helper</string>
    <key>CFBundleExecutable</key>
    <string>imessage-backup-helper</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>CFBundleShortVersionString</key>
    <string>0.1.0</string>
    <key>CFBundleVersion</key>
    <string>1</string>
    <key>LSMinimumSystemVersion</key>
    <string>13.0</string>
    <key>LSUIElement</key>
    <true/>
    <key>NSSystemAdministrationUsageDescription</key>
    <string>This helper copies local Messages and Contacts databases for the iMessage CLI approved-message store.</string>
    <key>NSContactsUsageDescription</key>
    <string>This helper copies the local Contacts database so the iMessage CLI can display contact names.</string>
</dict>
</plist>
PLIST

codesign --force --deep --sign - "$app_dir" >/dev/null
echo "$app_dir"
