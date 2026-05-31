import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import readline from 'node:readline';
import path from 'node:path';
import YAML from 'yaml';
import { sha256, deterministicMetaHash } from './hash.js';

export const GENESIS_PREV_HASH = '0000000000000000000000000000000000000000000000000000000000000000';

export interface ChainMeta {
  version: string;
  block_index: number;
  timestamp: string;
  hashing_strategy: 'raw';
  data_hash: string;
  prev_meta_hash: string;
  meta_hash?: string;
  [key: string]: any; // Allow custom properties like signature
}

export interface VerificationReport {
  valid: boolean;
  reason?: string;
  blockIndex?: number;
  tamperedComponent?: 'data' | 'meta' | 'chain' | 'index' | 'structure';
  expected?: any;
  actual?: any;
  dataText?: string;
  metaHash?: string;
}

export interface ChainStatus {
  blockCount: number;
  isHealthy: boolean;
  lastBlock: ChainMeta | null;
}

/**
 * Splits file content into raw document strings by parsing --- separators.
 * Preserves all formatting and comments inside documents.
 * @param fileContent Raw chain file content
 * @returns Array of document contents
 */
export function splitRawDocuments(fileContent: string): string[] {
  if (!fileContent || !fileContent.trim()) {
    return [];
  }
  const lines = fileContent.split(/\r?\n/);
  const docs: string[] = [];
  let currentDoc: string[] = [];
  
  for (const line of lines) {
    if (/^---\s*$/.test(line)) {
      if (currentDoc.length > 0 || docs.length > 0) {
        docs.push(currentDoc.join('\n'));
        currentDoc = [];
      }
    } else {
      currentDoc.push(line);
    }
  }
  
  docs.push(currentDoc.join('\n'));
  return docs;
}

/**
 * Initializes a new cryptographically secured YAML chain file.
 * @param filepath - Path to the file to create
 * @param initialDataText - Initial document content (arbitrary YAML)
 * @param prevMetaHash - The previous block's meta hash (default GENESIS_PREV_HASH)
 * @returns The created genesis block metadata
 */
export async function initChain(
  filepath: string, 
  initialDataText: string, 
  prevMetaHash = GENESIS_PREV_HASH
): Promise<ChainMeta> {
  // Ensure the directory exists
  await fs.mkdir(path.dirname(filepath), { recursive: true });
  
  // Format the initial data nicely: trim and ensure single trailing newline
  const cleanData = initialDataText.trim() + '\n';
  const dataHash = sha256(cleanData.trim()); // Hash the trimmed data to avoid cosmetic boundary issues
  
  const meta: ChainMeta = {
    version: '1.0.0',
    block_index: 0,
    timestamp: new Date().toISOString(),
    hashing_strategy: 'raw',
    data_hash: dataHash,
    prev_meta_hash: prevMetaHash
  };
  
  meta.meta_hash = deterministicMetaHash(meta);
  
  // Construct multi-document YAML content
  const fileContent = `${cleanData}---\n${YAML.stringify({ '$yaml-chain-meta': meta }).trim()}\n`;
  await fs.writeFile(filepath, fileContent, 'utf8');
  
  return meta;
}

/**
 * Appends a new data block to an existing YAML chain file.
 * @param filepath - Path to the file
 * @param dataText - Document content to append
 * @returns The created metadata block properties
 */
export async function appendBlock(filepath: string, dataText: string): Promise<ChainMeta> {
  let fileContent = '';
  try {
    fileContent = await fs.readFile(filepath, 'utf8');
  } catch (err: any) {
    if (err.code === 'ENOENT') {
      throw new Error(`File not found: ${filepath}. Run init first.`);
    }
    throw err;
  }
  
  const docs = splitRawDocuments(fileContent);
  if (docs.length === 0) {
    throw new Error(`File is empty: ${filepath}. Run init first.`);
  }
  
  if (docs.length % 2 !== 0) {
    throw new Error(`Chain is malformed. Expected an even number of documents, found ${docs.length}.`);
  }
  
  // Parse the last metadata document
  const lastMetaDocStr = docs[docs.length - 1];
  const parsed = YAML.parse(lastMetaDocStr);
  const lastMeta = parsed?.['$yaml-chain-meta'];
  
  if (!lastMeta || !lastMeta.meta_hash) {
    throw new Error('Failed to parse previous metadata block signature.');
  }
  
  const nextIndex = lastMeta.block_index + 1;
  const prevMetaHash = lastMeta.meta_hash;
  
  const cleanData = dataText.trim() + '\n';
  const dataHash = sha256(cleanData.trim());
  
  const meta: ChainMeta = {
    version: '1.0.0',
    block_index: nextIndex,
    timestamp: new Date().toISOString(),
    hashing_strategy: 'raw',
    data_hash: dataHash,
    prev_meta_hash: prevMetaHash
  };
  
  meta.meta_hash = deterministicMetaHash(meta);
  
  // Construct the new doc block segment
  // Ensure the existing file content ends with a newline, then append the new documents
  const separator = fileContent.endsWith('\n') ? '---\n' : '\n---\n';
  const appendContent = `${separator}${cleanData}---\n${YAML.stringify({ '$yaml-chain-meta': meta }).trim()}\n`;
  
  await fs.appendFile(filepath, appendContent, 'utf8');
  
  return meta;
}

/**
 * Private helper to cryptographically verify a single document block pair.
 */
function verifySingleBlock(
  i: number, 
  dataDocStr: string, 
  metaDocStr: string, 
  expectedPrevHash: string
): VerificationReport {
  let parsed;
  try {
    parsed = YAML.parse(metaDocStr);
  } catch (e: any) {
    return {
      valid: false,
      reason: `Failed to parse metadata document at block ${i} as valid YAML.`,
      blockIndex: i,
      tamperedComponent: 'meta'
    };
  }
  
  const meta = parsed?.['$yaml-chain-meta'];
  if (!meta) {
    return {
      valid: false,
      reason: `Metadata document at block ${i} is missing the '$yaml-chain-meta' root key.`,
      blockIndex: i,
      tamperedComponent: 'meta'
    };
  }
  
  // 1. Verify index
  if (meta.block_index !== i) {
    return {
      valid: false,
      reason: `Block index mismatch at block ${i}: metadata says index is ${meta.block_index}.`,
      blockIndex: i,
      tamperedComponent: 'index',
      expected: i,
      actual: meta.block_index
    };
  }
  
  // 2. Verify previous meta hash
  if (meta.prev_meta_hash !== expectedPrevHash) {
    let isRollover = false;
    if (i === 0) {
      try {
        const parsedData = YAML.parse(dataDocStr);
        if (parsedData?.genesis_rollover) {
          isRollover = true;
        }
      } catch (e) {
        // Ignored
      }
    }
    
    if (isRollover) {
      if (!/^[0-9a-fA-F]{64}$/.test(meta.prev_meta_hash)) {
        return {
          valid: false,
          reason: `Invalid rollover prev_meta_hash format at block ${i}: expected 64-character SHA-256 hash, but found '${meta.prev_meta_hash}'.`,
          blockIndex: i,
          tamperedComponent: 'chain'
        };
      }
    } else {
      return {
        valid: false,
        reason: `Chain link broken at block ${i}: expected prev_meta_hash to be '${expectedPrevHash}', but found '${meta.prev_meta_hash}'.`,
        blockIndex: i,
        tamperedComponent: 'chain',
        expected: expectedPrevHash,
        actual: meta.prev_meta_hash
      };
    }
  }
  
  // 3. Verify data hash
  const computedDataHash = sha256(dataDocStr.trim());
  if (meta.data_hash !== computedDataHash) {
    return {
      valid: false,
      reason: `Cryptographic mismatch in data payload at block ${i}: calculated hash is '${computedDataHash}', but metadata signature has '${meta.data_hash}'.`,
      blockIndex: i,
      tamperedComponent: 'data',
      expected: meta.data_hash,
      actual: computedDataHash,
      dataText: dataDocStr
    };
  }
  
  // 4. Verify meta signature itself
  const computedMetaHash = deterministicMetaHash(meta);
  if (meta.meta_hash !== computedMetaHash) {
    return {
      valid: false,
      reason: `Cryptographic mismatch in metadata signature itself at block ${i}: calculated signature is '${computedMetaHash}', but block contains '${meta.meta_hash}'.`,
      blockIndex: i,
      tamperedComponent: 'meta',
      expected: computedMetaHash,
      actual: meta.meta_hash
    };
  }

  return { valid: true, metaHash: meta.meta_hash };
}

/**
 * Cryptographically verifies the integrity of the YAML chain.
 * Uses a file stream to verify with constant memory O(1).
 * @param filepath - Path to the file to verify
 * @returns Verification result
 */
export async function verifyChain(filepath: string): Promise<VerificationReport> {
  try {
    await fs.stat(filepath);
  } catch (err: any) {
    if (err.code === 'ENOENT') {
      return { valid: false, reason: `File not found: ${filepath}`, tamperedComponent: 'structure' };
    }
    throw err;
  }

  const fileStream = fsSync.createReadStream(filepath);
  const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

  let blockIndex = 0;
  let isDataDoc = true;
  let currentLines: string[] = [];
  let expectedPrevHash = GENESIS_PREV_HASH;
  let docsCount = 0;
  let currentBlockData = '';

  try {
    for await (const line of rl) {
      if (/^---\s*$/.test(line)) {
        docsCount++;
        const currentDocStr = currentLines.join('\n');
        currentLines = [];
        
        if (isDataDoc) {
          currentBlockData = currentDocStr;
          isDataDoc = false;
        } else {
          // Verify meta document and link back
          const blockReport = verifySingleBlock(blockIndex, currentBlockData, currentDocStr, expectedPrevHash);
          if (!blockReport.valid) {
            fileStream.destroy();
            return blockReport;
          }
          
          expectedPrevHash = blockReport.metaHash!;
          blockIndex++;
          isDataDoc = true;
        }
      } else {
        currentLines.push(line);
      }
    }

    // Process remaining lines for the final block
    if (currentLines.length > 0 || docsCount > 0) {
      docsCount++;
      const currentDocStr = currentLines.join('\n');
      if (isDataDoc) {
        return {
          valid: false,
          reason: `Chain structure is malformed. Expected pairs of [data, meta] documents, but found odd count.`,
          tamperedComponent: 'structure'
        };
      } else {
        const blockReport = verifySingleBlock(blockIndex, currentBlockData, currentDocStr, expectedPrevHash);
        if (!blockReport.valid) {
          return blockReport;
        }
        blockIndex++;
      }
    }

    if (docsCount === 0) {
      return { valid: false, reason: 'File is completely empty.', tamperedComponent: 'structure' };
    }

    if (docsCount % 2 !== 0) {
      return {
        valid: false,
        reason: `Chain structure is malformed. Expected pairs of [data, meta] documents, but found ${docsCount} total documents.`,
        tamperedComponent: 'structure'
      };
    }
  } catch (err) {
    fileStream.destroy();
    throw err;
  }

  return { valid: true };
}

/**
 * Gets details of the chain.
 * @param filepath Path to chain file
 */
export async function getChainStatus(filepath: string): Promise<ChainStatus> {
  const fileContent = await fs.readFile(filepath, 'utf8');
  const docs = splitRawDocuments(fileContent);
  if (docs.length === 0) {
    return { blockCount: 0, isHealthy: false, lastBlock: null };
  }
  
  const blockCount = docs.length / 2;
  const isHealthy = (docs.length % 2 === 0);
  
  let lastBlock = null;
  if (isHealthy && blockCount > 0) {
    const lastMetaDocStr = docs[docs.length - 1];
    const parsed = YAML.parse(lastMetaDocStr);
    lastBlock = parsed?.['$yaml-chain-meta'] || null;
  }
  
  return {
    blockCount,
    isHealthy,
    lastBlock
  };
}

/**
 * Generates structured release notes / changelog from the YAML chain.
 * @param filepath Path to chain file
 * @param owner Repository owner
 */
export async function generateReleaseNotes(filepath: string, owner = 'packablock'): Promise<string> {
  const fileContent = await fs.readFile(filepath, 'utf8');
  const docs = splitRawDocuments(fileContent);
  if (docs.length === 0) {
    throw new Error('Chain is empty.');
  }
  
  if (docs.length % 2 !== 0) {
    throw new Error('Chain structure is malformed (odd number of documents).');
  }
  
  const blockCount = docs.length / 2;
  let markdown = '# SBOM & Software Release Changelog\n\n';
  markdown += `Generated on: ${new Date().toISOString()}\n\n`;
  markdown += `Total Blocks: ${blockCount}\n\n`;
  markdown += `---\n\n`;
  
  // List blocks in reverse chronological order (latest first)
  for (let i = blockCount - 1; i >= 0; i--) {
    const dataDocStr = docs[2 * i];
    const metaDocStr = docs[2 * i + 1];
    
    const parsedData = YAML.parse(dataDocStr);
    const parsedMeta = YAML.parse(metaDocStr)?.['$yaml-chain-meta'];
    
    if (!parsedMeta) {
      continue;
    }
    
    markdown += `### 📦 Block ${i} - [${parsedMeta.timestamp}]\n`;
    markdown += `* **Block Hash**: \`${parsedMeta.meta_hash}\`\n`;
    markdown += `* **Data Hash**: \`${parsedMeta.data_hash}\`\n\n`;
    
    markdown += `#### 📄 Payload Data\n`;
    markdown += '```yaml\n';
    markdown += dataDocStr.trim() + '\n';
    markdown += '```\n\n';
    markdown += `---\n\n`;
  }
  
  return markdown;
}
