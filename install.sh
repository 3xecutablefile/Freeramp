#!/usr/bin/env bash
set -euo pipefail

REPO="3xecutablefile/Freeramp"
NAME="VinciRamp"

echo "==> Fetching latest $NAME release from $REPO …"

JSON=$(curl -sfL "https://api.github.com/repos/$REPO/releases/latest") || {
  echo "ERROR: Could not fetch latest release. Check your internet or the repo URL."
  exit 1
}

TAG=$(echo "$JSON" | python3 -c "import sys,json; print(json.load(sys.stdin)['tag_name'])")
URL=$(echo "$JSON" | python3 -c "
import sys,json
assets = json.load(sys.stdin)['assets']
for a in assets:
    if a['name'].endswith('.zip'):
        print(a['browser_download_url'])
        sys.exit(0)
print('', end='')
")

if [ -z "$URL" ]; then
  echo "ERROR: No zip asset found in latest release ($TAG)."
  exit 1
fi

echo "==> Found $TAG"
echo "==> Downloading …"

TMP=$(mktemp -d)
trap "rm -rf '$TMP'" EXIT

curl -sfL "$URL" -o "$TMP/$NAME.zip"

echo "==> Installing to /Applications …"
echo "==> Administrator access needed to install to /Applications …"
sudo -v

ditto -x -k "$TMP/$NAME.zip" "$TMP/extracted"
rm -f "$TMP/$NAME.zip"

APP=$(find "$TMP/extracted" -maxdepth 2 -name "*.app" -type d | head -1)
if [ -z "$APP" ]; then
  echo "ERROR: Could not find .app inside the archive."
  ls -R "$TMP/extracted"
  exit 1
fi

sudo rm -rf "/Applications/$NAME.app" 2>/dev/null || true
sudo ditto "$APP" "/Applications/$NAME.app"

echo "==> Removing quarantine attributes …"
sudo xattr -dr com.apple.quarantine "/Applications/$NAME.app"

echo ""
echo "✓ $NAME $TAG installed to /Applications/$NAME.app"
echo ""
echo "Next steps:"
echo "  1. Make sure DaVinci Resolve Studio is running"
echo "  2. Install pywebview if you haven't already:"
echo "       pip3 install pywebview"
echo "  3. Launch from Applications or via Spotlight (quarantine already removed)"
echo ""
