#!/usr/bin/env bash
set -u

usage() {
  cat <<'EOF'
Usage:
  ./publish.sh [patch|minor|major|prerelease|semver] [otp] [--no-push]

Examples:
  ./publish.sh
  ./publish.sh minor
  ./publish.sh patch 123456
  ./publish.sh patch --no-push

Notes:
- Requires clean git working tree.
- Bumps version via npm version --no-git-tag-version.
- Validates npm pack includes required runtime files.
- Commits package.json and lockfile.
- Publishes to npm, then pushes git commit unless --no-push is set.
EOF
}

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  usage
  exit 0
fi

BUMP="${1:-patch}"
OTP=""
NO_PUSH=0

if [[ $# -ge 2 ]]; then
  if [[ "$2" == "--no-push" ]]; then
    NO_PUSH=1
  else
    OTP="$2"
  fi
fi
if [[ $# -ge 3 && "$3" == "--no-push" ]]; then
  NO_PUSH=1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR" || exit 1

NEW_VERSION=""
PACK_JSON=""

rollback_version() {
  if [[ -z "$NEW_VERSION" ]]; then
    return
  fi
  echo "[release] Rolling back local version files..."
  git checkout -- package.json >/dev/null 2>&1 || true
  [[ -f package-lock.json ]] && git checkout -- package-lock.json >/dev/null 2>&1 || true
  [[ -f npm-shrinkwrap.json ]] && git checkout -- npm-shrinkwrap.json >/dev/null 2>&1 || true
}

cleanup() {
  if [[ -n "$PACK_JSON" && -f "$PACK_JSON" ]]; then
    rm -f "$PACK_JSON"
  fi
}
trap cleanup EXIT

echo "[release] Repository: $SCRIPT_DIR"
echo "[release] Version bump: $BUMP"

command -v git >/dev/null 2>&1 || { echo "[release] ERROR: git is not available in PATH."; exit 1; }
command -v npm >/dev/null 2>&1 || { echo "[release] ERROR: npm is not available in PATH."; exit 1; }
command -v node >/dev/null 2>&1 || { echo "[release] ERROR: node is not available in PATH."; exit 1; }

git rev-parse --is-inside-work-tree >/dev/null 2>&1 || {
  echo "[release] ERROR: Current directory is not a git repository."
  exit 1
}

if [[ -n "$(git status --porcelain)" ]]; then
  echo "[release] ERROR: Working tree is not clean. Commit or stash changes first."
  git status --short
  exit 1
fi

OLD_VERSION="$(node -p "require('./package.json').version")"
echo "[release] Current version: $OLD_VERSION"

if ! NPM_USER="$(npm whoami 2>/dev/null)"; then
  echo "[release] ERROR: npm auth missing. Run: npm login"
  exit 1
fi
echo "[release] npm user: $NPM_USER"

if ! npm version "$BUMP" --no-git-tag-version; then
  echo "[release] ERROR: npm version failed."
  exit 1
fi

NEW_VERSION="$(node -p "require('./package.json').version")"
echo "[release] New version: $NEW_VERSION"

echo "[release] Running package preflight check..."
PACK_JSON="${TMPDIR:-/tmp}/heuristic-mcp-pack-$$.json"
if ! npm pack --dry-run --json > "$PACK_JSON"; then
  echo "[release] ERROR: npm pack preflight failed."
  rollback_version
  exit 1
fi

if ! node -e "const fs=require('fs'); const p=process.argv[1]; const data=JSON.parse(fs.readFileSync(p,'utf8')); const files=(data[0]?.files||[]).map(f=>f.path); const required=['features/set-workspace.js','features/register.js','scripts/postinstall.js']; const missing=required.filter(r=>!files.includes(r)); if(missing.length){console.error('[release] ERROR: Missing required package files: '+missing.join(', ')); process.exit(1);} " "$PACK_JSON"; then
  rollback_version
  exit 1
fi

git add package.json
[[ -f package-lock.json ]] && git add package-lock.json
[[ -f npm-shrinkwrap.json ]] && git add npm-shrinkwrap.json

if ! git commit -m "chore(release): v$NEW_VERSION"; then
  echo "[release] ERROR: git commit failed."
  rollback_version
  exit 1
fi

echo "[release] Publishing to npm..."
if [[ -n "$OTP" ]]; then
  if ! npm publish --access public --otp "$OTP"; then
    echo "[release] ERROR: npm publish failed. Commit exists locally; push skipped."
    exit 1
  fi
else
  if ! npm publish --access public; then
    echo "[release] ERROR: npm publish failed. Commit exists locally; push skipped."
    exit 1
  fi
fi

if [[ "$NO_PUSH" -eq 1 ]]; then
  echo "[release] Skipping git push due to --no-push."
else
  echo "[release] Pushing commit to git remote..."
  if ! git push; then
    echo "[release] ERROR: git push failed. Package was published; push manually."
    exit 1
  fi
fi

echo "[release] SUCCESS: v$NEW_VERSION committed, published, and pushed."