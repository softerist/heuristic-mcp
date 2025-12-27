import fs from "fs/promises";
import path from "path";
import { FILE_TYPE_MAP, IGNORE_PATTERNS } from "./ignore-patterns.js";

export class ProjectDetector {
  constructor(searchDirectory) {
    this.searchDirectory = searchDirectory;
    this.detectedTypes = new Set();
  }

  async detectProjectTypes() {
    const markerFiles = Object.keys(FILE_TYPE_MAP);
    
    for (const marker of markerFiles) {
      // Handle wildcard patterns like *.csproj
      if (marker.includes('*')) {
        await this.detectWithWildcard(marker);
      } else {
        await this.detectExactFile(marker);
      }
    }

    return Array.from(this.detectedTypes);
  }

  async detectExactFile(markerFile) {
    const markerPath = path.join(this.searchDirectory, markerFile);
    try {
      await fs.access(markerPath);
      const projectType = FILE_TYPE_MAP[markerFile];
      this.detectedTypes.add(projectType);
      console.error(`[Detector] Detected ${projectType} project (${markerFile})`);
    } catch {
      // File doesn't exist, continue
    }
  }

  async detectWithWildcard(pattern) {
    try {
      const files = await fs.readdir(this.searchDirectory);
      const regex = new RegExp('^' + pattern.replace('*', '.*') + '$');
      
      for (const file of files) {
        if (regex.test(file)) {
          const projectType = FILE_TYPE_MAP[pattern];
          this.detectedTypes.add(projectType);
          console.error(`[Detector] Detected ${projectType} project (${file})`);
          break;
        }
      }
    } catch {
      // Directory read failed, continue
    }
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
      patternCount: this.getSmartIgnorePatterns().length
    };
  }
}
