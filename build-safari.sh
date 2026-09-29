#!/bin/sh
# Rebuild the Safari app from the current extension code and install it to ~/Applications.
# Regenerates the Xcode project each time so newly added files are always included.
set -e
EXT="$(cd "$(dirname "$0")" && pwd)"
OUT="$HOME/contextfill-safari"

xcrun safari-web-extension-converter "$EXT" --project-location "$OUT" --app-name ContextFill \
  --bundle-identifier com.hraghu.contextfill --macos-only --swift --no-open --no-prompt --force >/dev/null
# The converter capitalises the app's id but not the extension's; Xcode refuses the mismatch.
sed -i '' 's/PRODUCT_BUNDLE_IDENTIFIER = com.hraghu.ContextFill;/PRODUCT_BUNDLE_IDENTIFIER = com.hraghu.contextfill;/' \
  "$OUT/ContextFill/ContextFill.xcodeproj/project.pbxproj"

cd "$OUT/ContextFill"
xcodebuild -project ContextFill.xcodeproj -scheme ContextFill -configuration Debug -derivedDataPath build \
  CODE_SIGN_IDENTITY="-" CODE_SIGN_STYLE=Manual DEVELOPMENT_TEAM="" build | grep -E "error:|BUILD (SUCCEEDED|FAILED)"
rm -rf "$HOME/Applications/ContextFill.app"
mkdir -p "$HOME/Applications"
cp -R build/Build/Products/Debug/ContextFill.app "$HOME/Applications/"
echo "Installed ~/Applications/ContextFill.app. Quit Safari, open the app once, then reopen Safari."
