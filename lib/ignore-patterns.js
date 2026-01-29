// Comprehensive ignore patterns based on industry best practices
// Researched from gitignore templates and development community standards

export const IGNORE_PATTERNS = {
  // JavaScript/Node.js
  javascript: [
    '**/node_modules/**',
    '**/.next/**',
    '**/dist/**',
    '**/build/**',
    '**/.nuxt/**',
    '**/.output/**',
    '**/.vercel/**',
    '**/.netlify/**',
    '**/out/**',
    '**/coverage/**',
    '**/.nyc_output/**',
    '**/npm-debug.log*',
    '**/yarn-debug.log*',
    '**/yarn-error.log*',
    '**/.pnpm-store/**',
    '**/.turbo/**',
    '**/package-lock.json',
    '**/pnpm-lock.yaml',
    '**/bun.lockb',
    '**/yarn.lock',
  ],

  // Python
  python: [
    '**/__pycache__/**',
    '**/*.pyc',
    '**/*.pyd',
    '**/.Python',
    '**/build/**',
    '**/develop-eggs/**',
    '**/dist/**',
    '**/downloads/**',
    '**/eggs/**',
    '**/.eggs/**',
    '**/lib/**',
    '**/lib64/**',
    '**/parts/**',
    '**/sdist/**',
    '**/var/**',
    '**/*.egg-info/**',
    '**/.installed.cfg',
    '**/*.egg',
    '**/.venv/**',
    '**/venv/**',
    '**/env/**',
    '**/ENV/**',
    '**/.pytest_cache/**',
    '**/htmlcov/**',
    '**/.tox/**',
    '**/.coverage',
    '**/.hypothesis/**',
    '**/.mypy_cache/**',
    '**/.ruff_cache/**',
  ],

  // Java/Maven
  java: [
    '**/target/**',
    '**/.gradle/**',
    '**/build/**',
    '**/.idea/**',
    '**/*.iml',
    '**/out/**',
    '**/gen/**',
    '**/classes/**',
    '**/.classpath',
    '**/.project',
    '**/.settings/**',
    '**/.m2/**',
    '**/*.class',
    '**/*.jar',
    '**/*.war',
    '**/*.ear',
  ],

  // Android
  android: [
    '**/.gradle/**',
    '**/build/**',
    '**/.idea/**',
    '**/*.iml',
    '**/local.properties',
    '**/captures/**',
    '**/.externalNativeBuild/**',
    '**/.cxx/**',
    '**/*.apk',
    '**/*.aar',
    '**/*.ap_',
    '**/*.dex',
    '**/google-services.json',
    '**/gradle-app.setting',
    '**/.navigation/**',
  ],

  // iOS/Swift
  ios: [
    '**/Pods/**',
    '**/DerivedData/**',
    '**/xcuserdata/**',
    '**/*.xcarchive',
    '**/build/**',
    '**/.build/**',
    '**/Packages/**',
    '**/.swiftpm/**',
    '**/Carthage/Build/**',
    '**/fastlane/report.xml',
    '**/fastlane/Preview.html',
    '**/fastlane/screenshots/**',
    '**/fastlane/test_output/**',
    '**/*.moved-aside',
    '**/*.xcuserstate',
    '**/*.hmap',
    '**/*.ipa',
  ],

  // Go
  go: ['**/vendor/**', '**/bin/**', '**/pkg/**', '**/*.exe', '**/*.test', '**/*.prof'],

  // PHP
  php: ['**/vendor/**', '**/composer.phar', '**/composer.lock', '**/.phpunit.result.cache'],

  // Rust
  rust: ['**/target/**', '**/Cargo.lock', '**/*.rs.bk'],

  // Ruby
  ruby: ['**/vendor/bundle/**', '**/.bundle/**', '**/Gemfile.lock', '**/.byebug_history'],

  // .NET/C#
  dotnet: [
    '**/bin/**',
    '**/obj/**',
    '**/packages/**',
    '**/*.user',
    '**/*.suo',
    '**/.vs/**',
    '**/node_modules/**',
  ],

  // Common (IDE, OS, Build tools)
  common: [
    // Version control
    '**/.git/**',
    '**/.svn/**',
    '**/.hg/**',
    '**/.bzr/**',

    // OS files
    '**/.DS_Store',
    '**/Thumbs.db',
    '**/desktop.ini',
    '**/$RECYCLE.BIN/**',

    // Backup files
    '**/*.bak',
    '**/*.backup',
    '**/*~',
    '**/*.swp',
    '**/*.swo',
    '**/*.swn',
    '**/#*#',
    '**/.#*',

    // Lock files (editor/runtime, not package managers)
    '**/*.lock',
    '**/.~lock*',

    // Logs
    '**/*.log',
    '**/logs/**',
    '**/*.log.*',

    // IDEs and Editors
    '**/.vscode/**',
    '**/.idea/**',
    '**/.sublime-project',
    '**/.sublime-workspace',
    '**/nbproject/**',
    '**/.settings/**',
    '**/.metadata/**',
    '**/.classpath',
    '**/.project',
    '**/.c9/**',
    '**/*.launch',
    '**/*.tmproj',
    '**/*.tmproject',
    '**/tmtags',

    // Vim
    '**/*~',
    '**/*.swp',
    '**/*.swo',
    '**/.*.sw?',
    '**/Session.vim',

    // Emacs
    '**/*~',
    '**/#*#',
    '**/.#*',

    // Environment files (secrets)
    '**/.env',
    '**/.env.local',
    '**/.env.*.local',
    '**/.env.production',
    '**/.env.development',
    '**/.env.test',
    '**/secrets.json',
    '**/secrets.yaml',
    '**/secrets.yml',
    '**/*.key',
    '**/*.pem',
    '**/*.crt',
    '**/*.cer',
    '**/*.p12',
    '**/*.pfx',

    // Temporary files
    '**/tmp/**',
    '**/temp/**',
    '**/*.tmp',
    '**/*.temp',
    '**/.cache/**',

    // Session & runtime
    '**/.sass-cache/**',
    '**/connect.lock',
    '**/*.pid',
    '**/*.seed',
    '**/*.pid.lock',

    // Coverage & test output
    '**/coverage/**',
    '**/.nyc_output/**',
    '**/test-results/**',
    '**/*.cover',
    '**/*.coverage',
    '**/htmlcov/**',

    // Documentation builds
    '**/docs/_build/**',
    '**/site/**',

    // Misc
    '**/*.orig',
    '**/core',
    '**/*.core',
  ],
};

// Map marker files to project types
export const FILE_TYPE_MAP = {
  // JavaScript/Node
  'package.json': 'javascript',
  'package-lock.json': 'javascript',
  'yarn.lock': 'javascript',
  'pnpm-lock.yaml': 'javascript',

  // Python
  'requirements.txt': 'python',
  Pipfile: 'python',
  'pyproject.toml': 'python',
  'setup.py': 'python',

  // Android
  'build.gradle': 'android',
  'build.gradle.kts': 'android',
  'settings.gradle': 'android',

  // Java
  'pom.xml': 'java',

  // iOS
  Podfile: 'ios',
  'Package.swift': 'ios',

  // Go
  'go.mod': 'go',

  // PHP
  'composer.json': 'php',

  // Rust
  'Cargo.toml': 'rust',

  // Ruby
  Gemfile: 'ruby',

  // .NET
  '*.csproj': 'dotnet',
  '*.sln': 'dotnet',
};

// Directories to skip during project detection (recursion)
export const SKIP_DIRECTORIES = [
  'node_modules',
  'dist',
  'build',
  'target',
  'vendor',
  'coverage',
  'htmlcov',
  'typings',
  'nltk_data',
  'secrets',
  'venv',
  'env',
  '__pycache__',
  'eggs',
  '.eggs',
];
