param(
  [string]$Bump = 'patch',
  [string]$Otp = '',
  [switch]$Help,
  [switch]$NoPush
)

if ($Help) {
  Write-Host ''
  Write-Host 'Usage:'
  Write-Host '  ./publish.ps1 [-Bump patch|minor|major|prerelease|semver] [-Otp 123456] [-NoPush]'
  Write-Host ''
  Write-Host 'Notes:'
  Write-Host '- Requires clean git working tree.'
  Write-Host '- Bumps version via npm version --no-git-tag-version.'
  Write-Host '- Validates npm pack includes required runtime files.'
  Write-Host '- Commits package.json and lockfile.'
  Write-Host '- Publishes to npm, then pushes git commit (unless -NoPush).'
  Write-Host ''
  exit 0
}

$repoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Push-Location $repoRoot

$newVersion = $null

function Rollback-VersionFiles {
  if (-not $newVersion) { return }
  Write-Host '[release] Rolling back local version files...'
  git checkout -- package.json *> $null
  if (Test-Path 'package-lock.json') { git checkout -- package-lock.json *> $null }
  if (Test-Path 'npm-shrinkwrap.json') { git checkout -- npm-shrinkwrap.json *> $null }
}

function Fail {
  param([string]$Message, [switch]$Rollback)
  if ($Rollback) { Rollback-VersionFiles }
  Write-Error "[release] ERROR: $Message"
  Pop-Location
  exit 1
}

Write-Host "[release] Repository: $repoRoot"
Write-Host "[release] Version bump: $Bump"

if (-not (Get-Command git -ErrorAction SilentlyContinue)) { Fail 'git is not available in PATH.' }
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) { Fail 'npm is not available in PATH.' }
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Fail 'node is not available in PATH.' }

git rev-parse --is-inside-work-tree *> $null
if ($LASTEXITCODE -ne 0) { Fail 'Current directory is not a git repository.' }

$dirty = git status --porcelain
if ($dirty) {
  Write-Host '[release] ERROR: Working tree is not clean. Commit or stash changes first.'
  git status --short
  Pop-Location
  exit 1
}

$oldVersion = (node -p "require('./package.json').version").Trim()
Write-Host "[release] Current version: $oldVersion"

$npmUser = (& npm whoami 2>$null)
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($npmUser)) {
  Fail 'npm auth missing. Run: npm login'
}
Write-Host "[release] npm user: $($npmUser.Trim())"

npm version $Bump --no-git-tag-version
if ($LASTEXITCODE -ne 0) { Fail 'npm version failed.' }

$newVersion = (node -p "require('./package.json').version").Trim()
Write-Host "[release] New version: $newVersion"

Write-Host '[release] Running package preflight check...'
$packJsonPath = Join-Path $env:TEMP ("heuristic-mcp-pack-{0}.json" -f ([Guid]::NewGuid().ToString('N')))
try {
  npm pack --dry-run --json | Set-Content -Path $packJsonPath -Encoding utf8
  if ($LASTEXITCODE -ne 0) { Fail 'npm pack preflight failed.' -Rollback }

  $packData = Get-Content -Path $packJsonPath -Raw | ConvertFrom-Json
  if (-not $packData -or -not $packData[0] -or -not $packData[0].files) {
    Fail 'Unable to parse npm pack output.' -Rollback
  }

  $paths = @($packData[0].files | ForEach-Object { $_.path })
  $required = @('features/set-workspace.js', 'features/register.js', 'scripts/postinstall.js')
  $missing = @($required | Where-Object { $_ -notin $paths })
  if ($missing.Count -gt 0) {
    Fail ("Missing required package files: " + ($missing -join ', ')) -Rollback
  }
} finally {
  if (Test-Path $packJsonPath) { Remove-Item $packJsonPath -Force -ErrorAction SilentlyContinue }
}

git add package.json
if (Test-Path 'package-lock.json') { git add package-lock.json }
if (Test-Path 'npm-shrinkwrap.json') { git add npm-shrinkwrap.json }

git commit -m "chore(release): v$newVersion"
if ($LASTEXITCODE -ne 0) { Fail 'git commit failed.' -Rollback }

Write-Host '[release] Publishing to npm...'
if ([string]::IsNullOrWhiteSpace($Otp)) {
  npm publish --access public
} else {
  npm publish --access public --otp $Otp
}
if ($LASTEXITCODE -ne 0) {
  Write-Host '[release] ERROR: npm publish failed. Commit exists locally; push skipped.'
  Pop-Location
  exit 1
}

if (-not $NoPush) {
  Write-Host '[release] Pushing commit to git remote...'
  git push
  if ($LASTEXITCODE -ne 0) {
    Write-Host '[release] ERROR: git push failed. Package was published; push manually.'
    Pop-Location
    exit 1
  }
} else {
  Write-Host '[release] Skipping git push due to -NoPush.'
}

Write-Host "[release] SUCCESS: v$newVersion committed, published, and pushed."
Pop-Location
exit 0