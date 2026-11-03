#!/bin/bash
set -euo pipefail
: "${APPLE_TEAM_ID:?Set APPLE_TEAM_ID}"
: "${EXPORT_OPTIONS_PLIST:?Set EXPORT_OPTIONS_PLIST to your manually prepared Ad Hoc export options}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUTPUT="${PHONE_WALL_BUILD_DIR:-$ROOT/.data/ios-build}"
mkdir -p "$OUTPUT"
xcodebuild -project "$ROOT/ios/PhoneWall.xcodeproj" -scheme PhoneWall -configuration Release -destination 'generic/platform=iOS' -archivePath "$OUTPUT/PhoneWall.xcarchive" DEVELOPMENT_TEAM="$APPLE_TEAM_ID" archive
xcodebuild -exportArchive -archivePath "$OUTPUT/PhoneWall.xcarchive" -exportPath "$OUTPUT/export" -exportOptionsPlist "$EXPORT_OPTIONS_PLIST"
