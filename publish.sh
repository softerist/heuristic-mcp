#!/usr/bin/env bash
set -u

usage() {
  cat <<'EOF'
Usage:
  ./publish.sh [patch|minor|major|prerelease|semver] [otp] [--no-push] [--type releaseType]
  ./publish.sh --type fix --no-push

Examples:
  ./publish.sh
  ./publish.sh minor
  ./publish.sh patch 123456
  ./publish.sh patch --no-push
  ./publish.sh --type chore

Notes:
- Requires clean git working tree.
- If bump is omitted, prompts interactively for release intent (fix/feat/chore/etc).
- Bumps version via npm version --no-git-tag-version.
- Validates npm pack includes required runtime files.
- Commits package.json and lockfile.
- Publishes to npm, then pushes git commit unless --no-push is set.
EOF
}

BUMP=""
RELEASE_TYPE=""
OTP=""
NO_PUSH=0
BUMP_PROVIDED=0

POSITIONAL=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --help|-h)
      usage
      exit 0
      ;;
    --no-push)
      NO_PUSH=1
      shift
      ;;
    --type|-t)
      [[ $# -ge 2 ]] || { echo "[release] ERROR: --type requires a value."; exit 1; }
      RELEASE_TYPE="$2"
      shift 2
      ;;
    --otp)
      [[ $# -ge 2 ]] || { echo "[release] ERROR: --otp requires a value."; exit 1; }
      OTP="$2"
      shift 2
      ;;
    --)
      shift
      while [[ $# -gt 0 ]]; do
        POSITIONAL+=("$1")
        shift
      done
      ;;
    -*)
      echo "[release] ERROR: Unknown option: $1"
      usage
      exit 1
      ;;
    *)
      POSITIONAL+=("$1")
      shift
      ;;
  esac
done

if [[ ${#POSITIONAL[@]} -ge 1 ]]; then
  BUMP="${POSITIONAL[0]}"
  BUMP_PROVIDED=1
fi

if [[ ${#POSITIONAL[@]} -ge 2 && -z "$OTP" ]]; then
  OTP="${POSITIONAL[1]}"
fi

if [[ ${#POSITIONAL[@]} -gt 2 ]]; then
  echo "[release] ERROR: Too many positional arguments."
  usage
  exit 1
fi

if [[ -z "$BUMP" ]]; then
  BUMP="patch"
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR" || exit 1

NEW_VERSION=""
PACK_JSON=""
NPM_USER=""
TEMP_NPMRC=""
ORIGINAL_NPM_CONFIG_USERCONFIG="${NPM_CONFIG_USERCONFIG-}"

rollback_version() {
  if [[ -z "$NEW_VERSION" ]]; then
    return
  fi
  echo "[release] Rolling back local version files..."
  git checkout -- package.json >/dev/null 2>&1 || true
  [[ -f package-lock.json ]] && git checkout -- package-lock.json >/dev/null 2>&1 || true
  [[ -f npm-shrinkwrap.json ]] && git checkout -- npm-shrinkwrap.json >/dev/null 2>&1 || true
}

restore_npm_auth_environment() {
  if [[ -n "$TEMP_NPMRC" && -f "$TEMP_NPMRC" ]]; then
    rm -f "$TEMP_NPMRC"
  fi
  TEMP_NPMRC=""

  if [[ -n "$ORIGINAL_NPM_CONFIG_USERCONFIG" ]]; then
    export NPM_CONFIG_USERCONFIG="$ORIGINAL_NPM_CONFIG_USERCONFIG"
  else
    unset NPM_CONFIG_USERCONFIG || true
  fi
}

cleanup() {
  if [[ -n "$PACK_JSON" && -f "$PACK_JSON" ]]; then
    rm -f "$PACK_JSON"
  fi
  restore_npm_auth_environment
}
trap cleanup EXIT

get_default_release_type_from_bump() {
  local bump_value="${1:-patch}"
  case "${bump_value,,}" in
    minor|major) echo "feat" ;;
    patch) echo "fix" ;;
    *) echo "chore" ;;
  esac
}

select_release_plan_interactive() {
  local choice custom_bump custom_type
  while true; do
    echo ""
    echo "[release] Choose release intent:"
    echo "  1) fix   -> patch (bug fix)"
    echo "  2) feat  -> minor (new feature)"
    echo "  3) chore -> patch (maintenance)"
    echo "  4) major -> major (breaking change)"
    echo "  5) prerelease -> prerelease"
    echo "  6) Custom bump + custom type"
    echo "  7) Cancel release"
    read -r -p "[release] Select 1-7: " choice

    case "$choice" in
      1)
        BUMP="patch"
        RELEASE_TYPE="fix"
        return 0
        ;;
      2)
        BUMP="minor"
        RELEASE_TYPE="feat"
        return 0
        ;;
      3)
        BUMP="patch"
        RELEASE_TYPE="chore"
        return 0
        ;;
      4)
        BUMP="major"
        RELEASE_TYPE="feat"
        return 0
        ;;
      5)
        BUMP="prerelease"
        return 0
        ;;
      6)
        read -r -p "[release] Enter bump (patch|minor|major|prerelease|semver): " custom_bump
        if [[ -z "$custom_bump" ]]; then
          echo "[release] Bump cannot be empty."
          continue
        fi

        read -r -p "[release] Enter release type (current: ${RELEASE_TYPE:-chore}): " custom_type
        custom_type="${custom_type:-${RELEASE_TYPE:-chore}}"
        custom_type="$(printf '%s' "$custom_type" | tr '[:upper:]' '[:lower:]')"
        if ! [[ "$custom_type" =~ ^[a-z][a-z0-9-]*$ ]]; then
          echo "[release] Invalid type. Use lowercase letters/numbers/hyphen (example: fix, feat, chore)."
          continue
        fi

        BUMP="$custom_bump"
        RELEASE_TYPE="$custom_type"
        return 0
        ;;
      7)
        return 1
        ;;
      *)
        echo "[release] Invalid selection. Enter 1-7."
        ;;
    esac
  done
}

get_npm_authenticated_user() {
  local user
  if ! user="$(npm whoami 2>/dev/null)"; then
    return 1
  fi
  user="${user//$'\r'/}"
  if [[ -z "$user" ]]; then
    return 1
  fi
  printf '%s' "$user"
}

invoke_npm_oauth_login() {
  restore_npm_auth_environment
  echo ""
  echo "[release] OAuth/web login flow:"
  echo "  1) npm may open your browser for sign-in."
  echo "  2) Complete authorization in the browser."
  echo "  3) Return here when npm reports success."
  npm login --auth-type=web && return 0
  echo "[release] Web login failed. Trying standard npm login..."
  npm login
}

use_temporary_npm_token_auth() {
  local token
  echo ""
  echo "[release] Token auth flow (temporary):"
  echo "  1) Create/copy an npm publish-capable access token."
  echo "  2) Paste the token below."
  echo "  3) Token is written to a temporary npmrc for this run only."
  read -r -s -p "[release] Paste npm token: " token
  echo ""
  if [[ -z "$token" ]]; then
    echo "[release] Empty token. Returning to auth menu."
    return 1
  fi

  restore_npm_auth_environment
  TEMP_NPMRC="${TMPDIR:-/tmp}/heuristic-mcp-npm-auth-$$-$RANDOM.npmrc"
  {
    echo "registry=https://registry.npmjs.org/"
    echo "always-auth=true"
    printf '//registry.npmjs.org/:_authToken=%s\n' "$token"
  } > "$TEMP_NPMRC"
  chmod 600 "$TEMP_NPMRC" >/dev/null 2>&1 || true
  export NPM_CONFIG_USERCONFIG="$TEMP_NPMRC"
  unset token
  return 0
}

ensure_npm_auth_interactive() {
  local authenticated_user choice
  if authenticated_user="$(get_npm_authenticated_user)"; then
    NPM_USER="$authenticated_user"
    return 0
  fi

  echo "[release] npm auth missing. Choose an auth method:"
  while true; do
    echo ""
    echo "  1) OAuth/web login (npm login)"
    echo "  2) Access token (temporary for this run)"
    echo "  3) Cancel release"
    read -r -p "[release] Select 1, 2, or 3: " choice
    case "$choice" in
      1)
        if ! invoke_npm_oauth_login; then
          echo "[release] npm login did not complete successfully."
          continue
        fi
        ;;
      2)
        if ! use_temporary_npm_token_auth; then
          continue
        fi
        ;;
      3)
        return 1
        ;;
      *)
        echo "[release] Invalid selection. Enter 1, 2, or 3."
        continue
        ;;
    esac

    if authenticated_user="$(get_npm_authenticated_user)"; then
      NPM_USER="$authenticated_user"
      return 0
    fi
    echo "[release] Authentication still not valid. Try another method."
  done
}

if [[ -z "$RELEASE_TYPE" ]]; then
  RELEASE_TYPE="$(get_default_release_type_from_bump "$BUMP")"
else
  RELEASE_TYPE="$(printf '%s' "$RELEASE_TYPE" | tr '[:upper:]' '[:lower:]')"
fi

if [[ "$BUMP_PROVIDED" -eq 0 ]]; then
  if ! select_release_plan_interactive; then
    echo "[release] ERROR: Release selection canceled."
    exit 1
  fi
fi

if ! [[ "$RELEASE_TYPE" =~ ^[a-z][a-z0-9-]*$ ]]; then
  echo "[release] ERROR: Invalid --type '$RELEASE_TYPE'. Use lowercase letters/numbers/hyphen."
  exit 1
fi

echo "[release] Repository: $SCRIPT_DIR"
echo "[release] Version bump: $BUMP"
echo "[release] Release type: $RELEASE_TYPE"

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

if ! ensure_npm_auth_interactive; then
  echo "[release] ERROR: npm auth missing. Login canceled or failed."
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

if ! git commit -m "$RELEASE_TYPE(release): v$NEW_VERSION"; then
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
  echo "[release] SUCCESS: v$NEW_VERSION committed and published."
else
  echo "[release] Pushing commit to git remote..."
  if ! git push; then
    echo "[release] ERROR: git push failed. Package was published; push manually."
    exit 1
  fi
  echo "[release] SUCCESS: v$NEW_VERSION committed, published, and pushed."
fi
