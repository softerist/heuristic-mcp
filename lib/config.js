import fs from "fs/promises";
import path from "path";
import { ProjectDetector } from "./project-detector.js";

const DEFAULT_CONFIG = {
  searchDirectory: ".",
  fileExtensions: [
    // JavaScript/TypeScript
    "js", "ts", "jsx", "tsx", "mjs", "cjs",
    // Styles
    "css", "scss", "sass", "less", "styl",
    // Markup
    "html", "htm", "xml", "svg",
    // Python
    "py", "pyw", "pyx",
    // Java/Kotlin/Scala
    "java", "kt", "kts", "scala",
    // C/C++
    "c", "cpp", "cc", "cxx", "h", "hpp", "hxx",
    // C#
    "cs", "csx",
    // Go
    "go",
    // Rust
    "rs",
    // Ruby
    "rb", "rake",
    // PHP
    "php", "phtml",
    // Swift
    "swift",
    // Shell scripts
    "sh", "bash", "zsh", "fish",
    // Config & Data
    "json", "yaml", "yml", "toml", "ini", "env",
    // Documentation
    "md", "mdx", "txt", "rst",
    // Database
    "sql",
    // Other
    "r", "R", "lua", "vim", "pl", "pm"
  ],
  excludePatterns: [
    "**/node_modules/**",
    "**/dist/**",
    "**/build/**",
    "**/.git/**",
    "**/coverage/**",
    "**/.next/**",
    "**/target/**",
    "**/vendor/**"
  ],
  chunkSize: 15,
  chunkOverlap: 3,
  maxResults: 5,
  enableCache: true,
  cacheDirectory: "./.smart-coding-cache",
  watchFiles: true,
  verbose: false,
  embeddingModel: "Xenova/all-MiniLM-L6-v2",
  semanticWeight: 0.7,
  exactMatchBoost: 1.5,
  smartIndexing: true
};

let config = { ...DEFAULT_CONFIG };

export async function loadConfig() {
  try {
    // Resolve paths relative to this file's directory (lib/)
    const scriptDir = path.dirname(new URL(import.meta.url).pathname);
    const projectRoot = path.resolve(scriptDir, '..');
    const configPath = path.join(projectRoot, "config.json");
    
    const configData = await fs.readFile(configPath, "utf-8");
    const userConfig = JSON.parse(configData);
    
    config = { ...DEFAULT_CONFIG, ...userConfig };
    
    // Resolve paths relative to project root
    config.searchDirectory = path.resolve(projectRoot, config.searchDirectory);
    config.cacheDirectory = path.resolve(projectRoot, config.cacheDirectory);
    
    // Smart project detection
    if (config.smartIndexing !== false) {
      const detector = new ProjectDetector(config.searchDirectory);
      const detectedTypes = await detector.detectProjectTypes();
      
      if (detectedTypes.length > 0) {
        const smartPatterns = detector.getSmartIgnorePatterns();
        
        // Merge smart patterns with user patterns (user patterns take precedence)
        const userPatterns = userConfig.excludePatterns || [];
        config.excludePatterns = [
          ...smartPatterns,
          ...userPatterns
        ];
        
        console.error(`[Config] Smart indexing: ${detectedTypes.join(', ')}`);
        console.error(`[Config] Applied ${smartPatterns.length} smart ignore patterns`);
      } else {
        console.error("[Config] No project markers detected, using default patterns");
      }
    }
    
    console.error("[Config] Loaded configuration from config.json");
  } catch (error) {
    console.error("[Config] Using default configuration (config.json not found or invalid)");
    console.error(`[Config] Error: ${error.message}`);
  }
  
  return config;
}

export function getConfig() {
  return config;
}

export { DEFAULT_CONFIG };
