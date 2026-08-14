#!/bin/bash
# Publish the current app code to the PUBLIC release repository.
# Dev tooling — run from the chinese-drills folder of the private dev repo,
# in an environment with push access to the release repo. Not for end users.
#
#   ./scripts/publish-release.sh [git-remote-url]
#
# The release repo mirrors the layout the in-app updater expects:
# a chinese-drills/ folder at the repo root. Bump version.json before running.
set -euo pipefail

REMOTE="${1:-https://github.com/jasecutlerMT/chinese-drills.git}"
APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
VERSION=$(node -e "console.log(require('$APP_DIR/version.json').version)")
STAGE=$(mktemp -d)

# Installed copies only offer an update when the published number is HIGHER than
# theirs. Republishing at the same number therefore reaches nobody who already
# updated — the fix looks shipped and silently is not. Bump first, or pass
# --allow-same when you know the release channel is only serving new installs.
if [ "${2:-}" != "--allow-same" ]; then
  PUBLISHED=$(curl -sfL --max-time 30 \
    "https://raw.githubusercontent.com/jasecutlerMT/chinese-drills/main/chinese-drills/version.json" \
    2>/dev/null | node -e "
      let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{
        try { console.log(JSON.parse(s).version) } catch { console.log('') }
      })" || true)
  if [ -n "$PUBLISHED" ] && [ "$VERSION" -le "$PUBLISHED" ]; then
    echo "ABORTING — version.json says $VERSION but the channel already serves $PUBLISHED." >&2
    echo "Anyone already on v$PUBLISHED would never be offered this. Bump version.json." >&2
    rm -rf "$STAGE"
    exit 1
  fi
fi

mkdir -p "$STAGE/chinese-drills"
# Copy the app, excluding local state (matches .gitignore).
(cd "$APP_DIR" && find . \
    -path ./node_modules -prune -o \
    -path ./.next -prune -o \
    -path ./data/audio -prune -o \
    -name 'drills.db*' -prune -o \
    -name '.restart' -prune -o \
    -name 'update-log.txt' -prune -o \
    -name 'launch-log.txt' -prune -o \
    -name 'lessons.incoming.json' -prune -o \
    -type f -print) | while read -r f; do
  mkdir -p "$STAGE/chinese-drills/$(dirname "$f")"
  cp "$APP_DIR/$f" "$STAGE/chinese-drills/$f"
done

# Append this release's lesson-data checksum to the running list. The updater
# reads the list out of the release to tell "still exactly as shipped" from
# "the user has corrected it", so it can refresh the textbook data without
# overwriting anyone's work. The list is tracked in the dev repo, so it grows
# across releases rather than being rebuilt from nothing each time.
KNOWN="$APP_DIR/data/lessons-known-hashes.txt"
node -e "
  const fs = require('fs'), crypto = require('crypto');
  const known = '$KNOWN';
  const hash = crypto
    .createHash('sha256')
    .update(fs.readFileSync('$APP_DIR/data/lessons.json'))
    .digest('hex');
  const body = fs.existsSync(known) ? fs.readFileSync(known, 'utf8') : '';
  if (!body.split('\n').map((l) => l.trim()).includes(hash)) {
    fs.writeFileSync(known, body.replace(/\n*\$/, '\n') + hash + '\n');
    console.log('recorded lesson-data hash ' + hash.slice(0, 12) + '…');
  }
  fs.copyFileSync(known, '$STAGE/chinese-drills/data/lessons-known-hashes.txt');
"

cat > "$STAGE/README.md" <<EOF
# Chinese Drills — public release channel

This repository carries releases of the Chinese Drills app (currently v$VERSION).
The app's in-app updater downloads from here. The app lives in \`chinese-drills/\`;
see its README for setup. Development happens in a private repository.
EOF

cd "$STAGE"
git init -q -b main
git add -A

# The app's own .gitignore is copied into the staging tree, so `git add -A`
# obeys it here too — which once silently dropped a file the updater depends on
# from an entire release. Nothing is published unless everything needed to run
# and to update is actually in the commit.
REQUIRED=(
  chinese-drills/package.json
  chinese-drills/version.json
  chinese-drills/next.config.ts
  chinese-drills/data/lessons.json
  chinese-drills/data/lessons-known-hashes.txt
  chinese-drills/scripts/update-worker.mjs
  chinese-drills/scripts/check-lessons.mjs
  chinese-drills/src/lib/srs.ts
  "chinese-drills/Chinese Drills.app/Contents/Info.plist"
  "chinese-drills/Chinese Drills.app/Contents/MacOS/launcher"
  "chinese-drills/Chinese Drills.app/Contents/Resources/AppIcon.icns"
)
MISSING=()
for f in "${REQUIRED[@]}"; do
  git ls-files --error-unmatch "$f" >/dev/null 2>&1 || MISSING+=("$f")
done
if [ ${#MISSING[@]} -gt 0 ]; then
  echo "ABORTING — these would not have shipped (check .gitignore):" >&2
  printf '  %s\n' "${MISSING[@]}" >&2
  rm -rf "$STAGE"
  exit 1
fi

# Nothing local or private may ride along.
FORBIDDEN=$(git ls-files | grep -E 'drills\.db|data/audio/|\.next/|node_modules/|update-log\.txt|launch-log\.txt|lessons\.incoming\.json|\.env' || true)
if [ -n "$FORBIDDEN" ]; then
  echo "ABORTING — local state would have been published:" >&2
  echo "$FORBIDDEN" >&2
  rm -rf "$STAGE"
  exit 1
fi

git commit -q -m "Release v$VERSION"
git push --force "$REMOTE" main
echo "Published v$VERSION to $REMOTE"
rm -rf "$STAGE"
