param(
  [string]$Bump = 'patch',
  [string]$ReleaseType = '',
  [string]$Otp = '',
  [switch]$Help,
  [switch]$NoPush
)

if ($Help) {
  Write-Host ''
  Write-Host 'Usage:'
  Write-Host '  ./publish.ps1 [-Bump patch|minor|major|prerelease|semver] [-ReleaseType fix|feat|chore] [-Otp 123456] [-NoPush]'
  Write-Host ''
  Write-Host 'Notes:'
  Write-Host '- Requires clean git working tree.'
  Write-Host '- If -Bump is omitted, prompts interactively for release intent (fix/feat/chore/etc).'
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
$script:tempNpmUserConfigPath = $null
$script:originalNpmUserConfig = $env:NPM_CONFIG_USERCONFIG

function Restore-NpmAuthEnvironment {
  if ($script:tempNpmUserConfigPath -and (Test-Path $script:tempNpmUserConfigPath)) {
    Remove-Item $script:tempNpmUserConfigPath -Force -ErrorAction SilentlyContinue
  }
  $script:tempNpmUserConfigPath = $null

  if ([string]::IsNullOrWhiteSpace($script:originalNpmUserConfig)) {
    Remove-Item Env:NPM_CONFIG_USERCONFIG -ErrorAction SilentlyContinue
  } else {
    $env:NPM_CONFIG_USERCONFIG = $script:originalNpmUserConfig
  }
}

function Get-NpmAuthenticatedUser {
  $npmUser = (& npm whoami 2>$null)
  if ($LASTEXITCODE -ne 0) { return $null }
  $npmUser = $npmUser.Trim()
  if ([string]::IsNullOrWhiteSpace($npmUser)) { return $null }
  return $npmUser
}

function Invoke-NpmOAuthLogin {
  Restore-NpmAuthEnvironment
  Write-Host ''
  Write-Host '[release] OAuth/web login flow:'
  Write-Host '  1) npm may open your browser for sign-in.'
  Write-Host '  2) Complete authorization in the browser.'
  Write-Host '  3) Return here when npm reports success.'
  & npm login --auth-type=web
  if ($LASTEXITCODE -eq 0) { return $true }

  Write-Host '[release] Web login failed. Trying standard npm login...'
  & npm login
  return ($LASTEXITCODE -eq 0)
}

function Use-TemporaryNpmTokenAuth {
  Write-Host ''
  Write-Host '[release] Token auth flow (temporary):'
  Write-Host '  1) Create/copy an npm publish-capable access token.'
  Write-Host '  2) Paste the token below.'
  Write-Host '  3) Token is written to a temporary npmrc for this run only.'

  $secureToken = Read-Host '[release] Paste npm token' -AsSecureString
  $tokenPtr = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureToken)
  try {
    $token = [System.Runtime.InteropServices.Marshal]::PtrToStringBSTR($tokenPtr)
  } finally {
    [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($tokenPtr)
  }

  if ([string]::IsNullOrWhiteSpace($token)) {
    Write-Host '[release] Empty token. Returning to auth menu.'
    return $false
  }

  if ($script:tempNpmUserConfigPath -and (Test-Path $script:tempNpmUserConfigPath)) {
    Remove-Item $script:tempNpmUserConfigPath -Force -ErrorAction SilentlyContinue
  }

  $script:tempNpmUserConfigPath = Join-Path $env:TEMP ("heuristic-mcp-npm-auth-{0}.npmrc" -f ([Guid]::NewGuid().ToString('N')))
  @(
    'registry=https://registry.npmjs.org/'
    'always-auth=true'
    "//registry.npmjs.org/:_authToken=$token"
  ) | Set-Content -Path $script:tempNpmUserConfigPath -Encoding utf8

  $env:NPM_CONFIG_USERCONFIG = $script:tempNpmUserConfigPath
  return $true
}

function Ensure-NpmAuthInteractive {
  $authenticatedUser = Get-NpmAuthenticatedUser
  if ($authenticatedUser) { return $authenticatedUser }

  Write-Host '[release] npm auth missing. Choose an auth method:'
  while ($true) {
    Write-Host ''
    Write-Host '  1) OAuth/web login (npm login)'
    Write-Host '  2) Access token (temporary for this run)'
    Write-Host '  3) Cancel release'
    $choice = (Read-Host '[release] Select 1, 2, or 3').Trim()

    switch ($choice) {
      '1' {
        if (-not (Invoke-NpmOAuthLogin)) {
          Write-Host '[release] npm login did not complete successfully.'
          continue
        }
      }
      '2' {
        if (-not (Use-TemporaryNpmTokenAuth)) { continue }
      }
      '3' { return $null }
      default {
        Write-Host '[release] Invalid selection. Enter 1, 2, or 3.'
        continue
      }
    }

    $authenticatedUser = Get-NpmAuthenticatedUser
    if ($authenticatedUser) { return $authenticatedUser }
    Write-Host '[release] Authentication still not valid. Try another method.'
  }
}

function Get-DefaultReleaseTypeFromBump {
  param([string]$BumpValue)
  switch ($BumpValue.ToLowerInvariant()) {
    'minor' { return 'feat' }
    'major' { return 'feat' }
    'patch' { return 'fix' }
    default { return 'chore' }
  }
}

function Select-ReleasePlanInteractive {
  param(
    [string]$CurrentBump,
    [string]$CurrentReleaseType
  )

  while ($true) {
    Write-Host ''
    Write-Host '[release] Choose release intent:'
    Write-Host '  1) fix   -> patch (bug fix)'
    Write-Host '  2) feat  -> minor (new feature)'
    Write-Host '  3) chore -> patch (maintenance)'
    Write-Host '  4) major -> major (breaking change)'
    Write-Host '  5) prerelease -> prerelease'
    Write-Host '  6) Custom bump + custom type'
    Write-Host '  7) Cancel release'
    $choice = (Read-Host '[release] Select 1-7').Trim()

    switch ($choice) {
      '1' { return @{ Bump = 'patch'; ReleaseType = 'fix' } }
      '2' { return @{ Bump = 'minor'; ReleaseType = 'feat' } }
      '3' { return @{ Bump = 'patch'; ReleaseType = 'chore' } }
      '4' { return @{ Bump = 'major'; ReleaseType = 'feat' } }
      '5' { return @{ Bump = 'prerelease'; ReleaseType = $CurrentReleaseType } }
      '6' {
        $customBump = (Read-Host '[release] Enter bump (patch|minor|major|prerelease|semver)').Trim()
        if ([string]::IsNullOrWhiteSpace($customBump)) {
          Write-Host '[release] Bump cannot be empty.'
          continue
        }

        $customType = (Read-Host "[release] Enter release type (current: $CurrentReleaseType)").Trim().ToLowerInvariant()
        if ([string]::IsNullOrWhiteSpace($customType)) { $customType = $CurrentReleaseType }
        if ([string]::IsNullOrWhiteSpace($customType)) { $customType = 'chore' }
        if ($customType -notmatch '^[a-z][a-z0-9-]*$') {
          Write-Host '[release] Invalid type. Use lowercase letters/numbers/hyphen (example: fix, feat, chore).'
          continue
        }

        return @{ Bump = $customBump; ReleaseType = $customType }
      }
      '7' { return $null }
      default {
        Write-Host '[release] Invalid selection. Enter 1-7.'
      }
    }
  }
}

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
  Restore-NpmAuthEnvironment
  Write-Error "[release] ERROR: $Message"
  Pop-Location
  exit 1
}

if ([string]::IsNullOrWhiteSpace($ReleaseType)) {
  $ReleaseType = Get-DefaultReleaseTypeFromBump -BumpValue $Bump
}

if (-not $PSBoundParameters.ContainsKey('Bump')) {
  $selection = Select-ReleasePlanInteractive -CurrentBump $Bump -CurrentReleaseType $ReleaseType
  if (-not $selection) { Fail 'Release selection canceled.' }
  $Bump = $selection.Bump
  $ReleaseType = $selection.ReleaseType
}

if ($ReleaseType -notmatch '^[a-z][a-z0-9-]*$') {
  Fail "Invalid -ReleaseType '$ReleaseType'. Use lowercase letters/numbers/hyphen."
}

Write-Host "[release] Repository: $repoRoot"
Write-Host "[release] Version bump: $Bump"
Write-Host "[release] Release type: $ReleaseType"

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

$npmUser = Ensure-NpmAuthInteractive
if ([string]::IsNullOrWhiteSpace($npmUser)) {
  Fail 'npm auth missing. Login canceled or failed.'
}
Write-Host "[release] npm user: $npmUser"

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

git commit -m "$ReleaseType(release): v$newVersion"
if ($LASTEXITCODE -ne 0) { Fail 'git commit failed.' -Rollback }

Write-Host "[release] Creating git tag v$newVersion..."
git tag -a "v$newVersion" -m "$ReleaseType(release): v$newVersion"
if ($LASTEXITCODE -ne 0) { Fail 'git tag failed.' }

Write-Host '[release] Publishing to npm...'
if ([string]::IsNullOrWhiteSpace($Otp)) {
  npm publish --access public
} else {
  npm publish --access public --otp $Otp
}
if ($LASTEXITCODE -ne 0) {
  Write-Host '[release] ERROR: npm publish failed. Commit exists locally; push skipped.'
  Restore-NpmAuthEnvironment
  Pop-Location
  exit 1
}

if (-not $NoPush) {
  Write-Host '[release] Pushing commit and tags to git remote...'
  git push --follow-tags
  if ($LASTEXITCODE -ne 0) {
    Write-Host '[release] ERROR: git push failed. Package was published; push manually.'
    Restore-NpmAuthEnvironment
    Pop-Location
    exit 1
  }
  Write-Host "[release] SUCCESS: v$newVersion committed, tagged, published, and pushed."
} else {
  Write-Host '[release] Skipping git push due to -NoPush.'
  Write-Host "[release] SUCCESS: v$newVersion committed, tagged, and published."
}
Restore-NpmAuthEnvironment
Pop-Location
exit 0
