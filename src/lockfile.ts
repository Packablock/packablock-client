import { readFileSync } from 'node:fs';
import path from 'node:path';

export interface LockfileData {
  packages: Record<string, string>;
  source: string;
}

/**
 * Parses package-lock.json content.
 */
function parsePackageLock(content: string): Record<string, string> {
  const data = JSON.parse(content);
  const packages: Record<string, string> = {};

  // Try modern package-lock format (v2/v3)
  if (data.packages) {
    for (const [pkgPath, pkgInfo] of Object.entries<any>(data.packages)) {
      if (!pkgPath) continue;
      // Extract package name from node_modules path
      const name = pkgPath.replace(/^node_modules\//, '');
      if (name && pkgInfo.version) {
        packages[name] = pkgInfo.version;
      }
    }
  } 
  // Fall back to legacy package-lock format (v1)
  else if (data.dependencies) {
    for (const [name, pkgInfo] of Object.entries<any>(data.dependencies)) {
      if (pkgInfo.version) {
        packages[name] = pkgInfo.version;
      }
    }
  }

  return packages;
}

/**
 * Parses standard yarn.lock format (also output by bun bun.lockb).
 */
function parseYarnLock(text: string): Record<string, string> {
  const packages: Record<string, string> = {};
  const lines = text.split('\n');
  
  let currentPackageName: string | null = null;

  for (let line of lines) {
    line = line.trim();
    if (!line || line.startsWith('#')) continue;

    // Detect package signature line (e.g., "package-name@version, other@version:")
    // Or bun.lockb output which looks like lodash@^4.17.21:
    if (line.endsWith(':')) {
      const parts = line.slice(0, -1).split(',');
      const firstPart = parts[0].trim();
      
      // Extract package name before @ (handling scoped packages like @types/node)
      let name = '';
      if (firstPart.startsWith('"')) {
        // Strip quotes if present
        const unquoted = firstPart.replace(/^"|"$/g, '');
        name = getPackageNameFromRef(unquoted);
      } else {
        name = getPackageNameFromRef(firstPart);
      }
      
      if (name) {
        currentPackageName = name;
      }
    } 
    // Detect version line (e.g., "version: 1.0.0" or "version \"1.0.0\"")
    else if (currentPackageName && (line.startsWith('version ') || line.startsWith('version:'))) {
      const verMatch = line.match(/version\s+["']?([^"']+)["']?/);
      if (verMatch && verMatch[1]) {
        packages[currentPackageName] = verMatch[1];
        currentPackageName = null; // Reset
      }
    }
  }

  return packages;
}

function getPackageNameFromRef(ref: string): string {
  // Scoped packages like @types/node@^18.0.0 -> @types/node
  if (ref.startsWith('@')) {
    const parts = ref.slice(1).split('@');
    return '@' + parts[0];
  }
  // Normal packages like lodash@^4.17.21 -> lodash
  return ref.split('@')[0];
}

/**
 * Main entrypoint to parse one or more lockfiles and return unified packages map.
 */
export function parseLockfiles(filepaths: string[]): LockfileData {
  const combinedPackages: Record<string, string> = {};
  const sources: string[] = [];

  for (const file of filepaths) {
    const absolutePath = path.resolve(file);
    const filename = path.basename(absolutePath);
    sources.push(filename);

    try {
      if (filename === 'package-lock.json') {
        const content = readFileSync(absolutePath, 'utf8');
        const pkgs = parsePackageLock(content);
        Object.assign(combinedPackages, pkgs);
      } 
      else if (filename === 'bun.lockb') {
        // Run bun bun.lockb to output the human-readable text
        const proc = Bun.spawnSync(['bun', absolutePath]);
        if (proc.success) {
          const text = proc.stdout.toString('utf8');
          const pkgs = parseYarnLock(text);
          Object.assign(combinedPackages, pkgs);
        } else {
          throw new Error(`Failed to parse bun.lockb using bun CLI: ${proc.stderr.toString('utf8')}`);
        }
      } 
      else if (filename === 'yarn.lock' || filename === 'bun.lock' || filename.endsWith('.lock')) {
        const content = readFileSync(absolutePath, 'utf8');
        const pkgs = parseYarnLock(content);
        Object.assign(combinedPackages, pkgs);
      } 
      else {
        // Treat as plain text or try JSON first
        const content = readFileSync(absolutePath, 'utf8');
        try {
          const pkgs = parsePackageLock(content);
          Object.assign(combinedPackages, pkgs);
        } catch {
          const pkgs = parseYarnLock(content);
          Object.assign(combinedPackages, pkgs);
        }
      }
    } catch (err: any) {
      throw new Error(`Error parsing lockfile '${file}': ${err.message}`);
    }
  }

  // Sort keys alphabetically for clean deterministic display in the genesis block
  const sortedPackages: Record<string, string> = {};
  for (const key of Object.keys(combinedPackages).sort()) {
    sortedPackages[key] = combinedPackages[key];
  }

  return {
    packages: sortedPackages,
    source: sources.join(', ')
  };
}
