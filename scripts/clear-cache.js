#!/usr/bin/env node
import fs from "fs/promises";
import path from "path";

async function clearCache() {
  try {
    const configPath = path.join(process.cwd(), "config.json");
    let cacheDir = "./.smart-coding-cache";

    // Try to load cache directory from config
    try {
      const configData = await fs.readFile(configPath, "utf-8");
      const config = JSON.parse(configData);
      if (config.cacheDirectory) {
        cacheDir = path.resolve(config.cacheDirectory);
      }
    } catch {
      console.log("Using default cache directory");
    }

    // Remove cache directory
    await fs.rm(cacheDir, { recursive: true, force: true });
    console.log(`Cache cleared successfully: ${cacheDir}`);
    console.log("Next startup will perform a full reindex.");
  } catch (error) {
    console.error(`Error clearing cache: ${error.message}`);
    process.exit(1);
  }
}

clearCache();
