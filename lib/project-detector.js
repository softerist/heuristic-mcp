import fs from 'fs/promises';
import path from 'path';
import { FILE_TYPE_MAP, IGNORE_PATTERNS } from './ignore-patterns.js';

export class ProjectDetector {
  constructor(searchDirectory) {
    this.searchDirectory = searchDirectory;
    this.detectedTypes = new Set();
  }

  async detectProjectTypes(options = {}) {
    const maxDepth = typeof options.maxDepth === 'number' ? options.maxDepth : 2;
    const startDepth = typeof options.startDepth === 'number' ? options.startDepth : 0;
    const markerFiles = Object.keys(FILE_TYPE_MAP);
    const discoveredTypes = new Map(); // type -> first marker found

    const checkDir = async (dir, depth) => {
      if (depth > maxDepth) return;

      const items = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
      const itemNames = items.map((i) => i.name);
      const itemSet = new Set(itemNames);

      for (const marker of markerFiles) {
        let found = false;
        if (marker.includes('*')) {
          const regex = new RegExp('^' + marker.replace('*', '.*') + '$');
          found = itemNames.some((file) => regex.test(file));
        } else {
          found = itemSet.has(marker);
        }

        if (found) {
          const type = FILE_TYPE_MAP[marker];
          if (!discoveredTypes.has(type)) {
            discoveredTypes.set(type, path.relative(this.searchDirectory, path.join(dir, marker)));
          }
        }
      }

      // Recurse into subdirectories
      if (depth < maxDepth) {
        for (const item of items) {
          if (item.isDirectory()) {
            const name = item.name;
            if (
              name.startsWith('.') ||
              [
                'node_modules',
                'dist',
                'build',
                'target',
                'vendor', // Build outputs
                'coverage',
                'htmlcov', // Test coverage
                'typings',
                'nltk_data',
                'secrets', // Data/secrets
                'venv',
                'env', // Python envs (non-dot)
                '__pycache__',
                'eggs',
                '.eggs', // Python artifacts
              ].includes(name)
            ) {
              continue;
            }
            await checkDir(path.join(dir, name), depth + 1);
          }
        }
      }
    };

    await checkDir(this.searchDirectory, startDepth);

    for (const [type, marker] of discoveredTypes) {
      this.detectedTypes.add(type);
      console.error(`[Detector] Detected ${type} project (${marker})`);
    }

    return Array.from(this.detectedTypes);
  }

  getSmartIgnorePatterns() {
    const patterns = [...IGNORE_PATTERNS.common];

    for (const type of this.detectedTypes) {
      if (IGNORE_PATTERNS[type]) {
        patterns.push(...IGNORE_PATTERNS[type]);
      }
    }

    // Remove duplicates
    return [...new Set(patterns)];
  }

  getSummary() {
    return {
      detectedTypes: Array.from(this.detectedTypes),
      patternCount: this.getSmartIgnorePatterns().length,
    };
  }
}
