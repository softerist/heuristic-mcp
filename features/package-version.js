


const REGISTRIES = {
  npm: {
    name: 'npm',
    pattern: /^(?:npm:)?(.+)$/,
    url: (pkg) => `https://registry.npmjs.org/${encodeURIComponent(pkg)}/latest`,
    parse: (data) => data.version,
    detect: (pkg) =>
      pkg.startsWith('@') || /^[a-z0-9][-a-z0-9._]*$/i.test(pkg.replace(/^npm:/, '')),
  },
  pypi: {
    name: 'PyPI',
    pattern: /^(?:pip:|pypi:)(.+)$/,
    url: (pkg) => `https://pypi.org/pypi/${encodeURIComponent(pkg)}/json`,
    parse: (data) => data.info.version,
    detect: () => false, 
  },
  crates: {
    name: 'crates.io',
    pattern: /^(?:cargo:|crates:|rust:)(.+)$/,
    url: (pkg) => `https://crates.io/api/v1/crates/${encodeURIComponent(pkg)}`,
    parse: (data) => data.crate.max_version,
    headers: { 'User-Agent': 'heuristic-mcp/1.0' },
    detect: () => false,
  },
  go: {
    name: 'Go',
    pattern: /^(?:go:)(.+)$/,
    url: (pkg) => `https://proxy.golang.org/${encodeURIComponent(pkg)}/@latest`,
    parse: (data) => data.Version,
    detect: (pkg) => pkg.includes('/') && pkg.includes('.'),
  },
  rubygems: {
    name: 'RubyGems',
    pattern: /^(?:gem:|ruby:)(.+)$/,
    url: (pkg) => `https://rubygems.org/api/v1/gems/${encodeURIComponent(pkg)}.json`,
    parse: (data) => data.version,
    detect: () => false,
  },
  nuget: {
    name: 'NuGet',
    pattern: /^(?:nuget:|dotnet:)(.+)$/,
    url: (pkg) =>
      `https://api.nuget.org/v3-flatcontainer/${encodeURIComponent(pkg.toLowerCase())}/index.json`,
    parse: (data) => data.versions[data.versions.length - 1],
    detect: () => false,
  },
  packagist: {
    name: 'Packagist',
    pattern: /^(?:composer:|php:)(.+)$/,
    url: (pkg) => `https://repo.packagist.org/p2/${encodeURIComponent(pkg)}.json`,
    parse: (data) => {
      const pkgName = Object.keys(data.packages)[0];
      const versions = data.packages[pkgName];
      
      const stable = versions.find((v) => !v.version.includes('dev'));
      return stable ? stable.version : versions[0].version;
    },
    detect: (pkg) => pkg.includes('/'),
  },
  hex: {
    name: 'Hex',
    pattern: /^(?:hex:|elixir:|mix:)(.+)$/,
    url: (pkg) => `https://hex.pm/api/packages/${encodeURIComponent(pkg)}`,
    parse: (data) => {
      const releases = data.releases;
      return releases.length > 0 ? releases[0].version : null;
    },
    detect: () => false,
  },
  pub: {
    name: 'pub.dev',
    pattern: /^(?:pub:|dart:|flutter:)(.+)$/,
    url: (pkg) => `https://pub.dev/api/packages/${encodeURIComponent(pkg)}`,
    parse: (data) => data.latest.version,
    detect: () => false,
  },
  maven: {
    name: 'Maven Central',
    pattern: /^(?:maven:|java:)(.+)$/,
    url: (pkg) => {
      
      const [group, artifact] = pkg.includes(':') ? pkg.split(':') : pkg.split('/');
      if (!artifact) return null;
      return `https://search.maven.org/solrsearch/select?q=g:${encodeURIComponent(group)}+AND+a:${encodeURIComponent(artifact)}&rows=1&wt=json`;
    },
    parse: (data) => {
      if (data.response.docs.length === 0) return null;
      return data.response.docs[0].latestVersion;
    },
    detect: (pkg) => pkg.includes(':') || (pkg.includes('.') && pkg.includes('/')),
  },
  homebrew: {
    name: 'Homebrew',
    pattern: /^(?:brew:|homebrew:)(.+)$/,
    url: (pkg) => `https://formulae.brew.sh/api/formula/${encodeURIComponent(pkg)}.json`,
    parse: (data) => data.versions.stable,
    detect: () => false,
  },
  conda: {
    name: 'Conda',
    pattern: /^(?:conda:)(.+)$/,
    url: (pkg) =>
      `https://api.anaconda.org/package/conda-forge/${encodeURIComponent(pkg)}`,
    parse: (data) => data.latest_version,
    detect: () => false,
  },
};


function detectRegistry(packageName) {
  
  for (const [key, registry] of Object.entries(REGISTRIES)) {
    if (registry.pattern.test(packageName) && key !== 'npm') {
      const match = packageName.match(registry.pattern);
      if (match) {
        return { registry, cleanName: match[1] };
      }
    }
  }

  
  for (const registry of Object.values(REGISTRIES)) {
    if (registry.detect(packageName)) {
      const match = packageName.match(registry.pattern);
      return { registry, cleanName: match ? match[1] : packageName };
    }
  }

  
  const npmMatch = packageName.match(REGISTRIES.npm.pattern);
  return { registry: REGISTRIES.npm, cleanName: npmMatch ? npmMatch[1] : packageName };
}


async function fetchPackageVersion(packageName, timeoutMs = 10000) {
  const { registry, cleanName } = detectRegistry(packageName);

  const url = registry.url(cleanName);
  if (!url) {
    return {
      success: false,
      error: `Invalid package format for ${registry.name}: ${cleanName}`,
      registry: registry.name,
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const headers = {
      Accept: 'application/json',
      ...(registry.headers || {}),
    };

    const response = await fetch(url, {
      headers,
      signal: controller.signal,
    });

    if (!response.ok) {
      if (response.status === 404) {
        return {
          success: false,
          error: `Package "${cleanName}" not found on ${registry.name}`,
          registry: registry.name,
        };
      }
      return {
        success: false,
        error: `${registry.name} returned status ${response.status}`,
        registry: registry.name,
      };
    }

    const data = await response.json();
    const version = registry.parse(data);

    if (!version) {
      return {
        success: false,
        error: `Could not parse version from ${registry.name} response`,
        registry: registry.name,
      };
    }

    return {
      success: true,
      package: cleanName,
      version,
      registry: registry.name,
    };
  } catch (error) {
    if (error.name === 'AbortError') {
      return {
        success: false,
        error: `Request to ${registry.name} timed out`,
        registry: registry.name,
      };
    }
    return {
      success: false,
      error: `Failed to fetch from ${registry.name}: ${error.message}`,
      registry: registry.name,
    };
  } finally {
    clearTimeout(timeout);
  }
}


function getSupportedRegistries() {
  return Object.entries(REGISTRIES).map(([key, reg]) => ({
    key,
    name: reg.name,
    prefix: reg.pattern.source.match(/\?:([^)]+)\)/)?.[1] || key + ':',
  }));
}


export function getToolDefinition() {
  return {
    name: 'e_check_package_version',
    description:
      'Fetches the latest version of a package from its official registry. Supports npm, PyPI, crates.io, Maven, Go, RubyGems, NuGet, Packagist, Hex, pub.dev, Homebrew, and Conda. Use prefix like "pip:requests" for non-npm packages.',
    inputSchema: {
      type: 'object',
      properties: {
        package: {
          type: 'string',
          description:
            'Package name, optionally prefixed with registry (e.g., "lodash", "pip:requests", "cargo:serde", "go:github.com/gin-gonic/gin")',
        },
      },
      required: ['package'],
    },
    annotations: {
      title: 'Check Package Version',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true, 
    },
  };
}


export async function handleToolCall(request) {
  const args = request.params?.arguments || {};
  const packageName = args.package;

  if (!packageName || typeof packageName !== 'string' || packageName.trim() === '') {
    return {
      content: [
        {
          type: 'text',
          text: 'Error: Please provide a package name.',
        },
      ],
      isError: true,
    };
  }

  const result = await fetchPackageVersion(packageName.trim());

  if (result.success) {
    return {
      content: [
        {
          type: 'text',
          text: `**${result.package}** (${result.registry})\n\nLatest version: \`${result.version}\``,
        },
      ],
    };
  } else {
    return {
      content: [
        {
          type: 'text',
          text: `Error: ${result.error}`,
        },
      ],
    };
  }
}


export { fetchPackageVersion, detectRegistry, getSupportedRegistries, REGISTRIES };
