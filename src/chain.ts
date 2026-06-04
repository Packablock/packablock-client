import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import YAML from "yaml";
import { deterministicMetaHash, sha256 } from "./hash.js";

export const GENESIS_PREV_HASH =
	"0000000000000000000000000000000000000000000000000000000000000000";

export interface ChainMeta {
	version: string;
	block_index: number;
	timestamp: string;
	hashing_strategy: "raw";
	data_hash: string;
	prev_meta_hash: string;
	meta_hash?: string;
	[key: string]: any; // Allow custom properties like signature
}

export interface VerificationReport {
	valid: boolean;
	reason?: string;
	blockIndex?: number;
	tamperedComponent?: "data" | "meta" | "chain" | "index" | "structure";
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
	if (!fileContent?.trim()) {
		return [];
	}
	const lines = fileContent.split(/\r?\n/);
	const docs: string[] = [];
	let currentDoc: string[] = [];

	for (const line of lines) {
		if (/^---\s*$/.test(line)) {
			if (currentDoc.length > 0 || docs.length > 0) {
				docs.push(currentDoc.join("\n"));
				currentDoc = [];
			}
		} else {
			currentDoc.push(line);
		}
	}

	docs.push(currentDoc.join("\n"));
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
	prevMetaHash = GENESIS_PREV_HASH,
	customMeta: Partial<ChainMeta> = {},
): Promise<ChainMeta> {
	// Ensure the directory exists
	await fs.mkdir(path.dirname(filepath), { recursive: true });

	// Format the initial data nicely: trim and ensure single trailing newline
	const cleanData = `${initialDataText.trim()}\n`;
	const dataHash = sha256(cleanData.trim()); // Hash the trimmed data to avoid cosmetic boundary issues

	const meta: ChainMeta = {
		version: "1.0.0",
		block_index: 0,
		timestamp: customMeta.timestamp || new Date().toISOString(),
		hashing_strategy: "raw",
		data_hash: dataHash,
		prev_meta_hash: prevMetaHash,
		...customMeta,
	};

	meta.meta_hash = deterministicMetaHash(meta);

	// Construct multi-document YAML content
	const fileContent = `${cleanData}---\n${YAML.stringify({ "$yaml-chain-meta": meta }).trim()}\n`;
	await fs.writeFile(filepath, fileContent, "utf8");

	return meta;
}

/**
 * Appends a new data block to an existing YAML chain file.
 * @param filepath - Path to the file
 * @param dataText - Document content to append
 * @returns The created metadata block properties
 */
export async function appendBlock(
	filepath: string,
	dataText: string,
	customMeta: Partial<ChainMeta> = {},
): Promise<ChainMeta> {
	let fileContent = "";
	try {
		fileContent = await fs.readFile(filepath, "utf8");
	} catch (err: any) {
		if (err.code === "ENOENT") {
			throw new Error(`File not found: ${filepath}. Run init first.`);
		}
		throw err;
	}

	const docs = splitRawDocuments(fileContent);
	if (docs.length === 0) {
		throw new Error(`File is empty: ${filepath}. Run init first.`);
	}

	if (docs.length % 2 !== 0) {
		throw new Error(
			`Chain is malformed. Expected an even number of documents, found ${docs.length}.`,
		);
	}

	// Parse the last metadata document
	const lastMetaDocStr = docs[docs.length - 1];
	if (lastMetaDocStr === undefined) {
		throw new Error("Malformed chain: last metadata document is undefined.");
	}
	const parsed = YAML.parse(lastMetaDocStr);
	const lastMeta = parsed?.["$yaml-chain-meta"];

	if (!lastMeta?.meta_hash) {
		throw new Error("Failed to parse previous metadata block signature.");
	}

	const nextIndex = lastMeta.block_index + 1;
	const prevMetaHash = lastMeta.meta_hash;

	const cleanData = `${dataText.trim()}\n`;
	const dataHash = sha256(cleanData.trim());

	const meta: ChainMeta = {
		version: "1.0.0",
		block_index: nextIndex,
		timestamp: customMeta.timestamp || new Date().toISOString(),
		hashing_strategy: "raw",
		data_hash: dataHash,
		prev_meta_hash: prevMetaHash,
		...customMeta,
	};

	meta.meta_hash = deterministicMetaHash(meta);

	// Construct the new doc block segment
	// Ensure the existing file content ends with a newline, then append the new documents
	const separator = fileContent.endsWith("\n") ? "---\n" : "\n---\n";
	const appendContent = `${separator}${cleanData}---\n${YAML.stringify({ "$yaml-chain-meta": meta }).trim()}\n`;

	await fs.appendFile(filepath, appendContent, "utf8");

	return meta;
}

/**
 * Private helper to cryptographically verify a single document block pair.
 */
function verifySingleBlock(
	i: number,
	dataDocStr: string,
	metaDocStr: string,
	expectedPrevHash: string,
): VerificationReport {
	let parsed: any;
	try {
		parsed = YAML.parse(metaDocStr);
	} catch (_e: any) {
		return {
			valid: false,
			reason: `Failed to parse metadata document at block ${i} as valid YAML.`,
			blockIndex: i,
			tamperedComponent: "meta",
		};
	}

	const meta = parsed?.["$yaml-chain-meta"];
	if (!meta) {
		return {
			valid: false,
			reason: `Metadata document at block ${i} is missing the '$yaml-chain-meta' root key.`,
			blockIndex: i,
			tamperedComponent: "meta",
		};
	}

	// 1. Verify index
	if (meta.block_index !== i) {
		return {
			valid: false,
			reason: `Block index mismatch at block ${i}: metadata says index is ${meta.block_index}.`,
			blockIndex: i,
			tamperedComponent: "index",
			expected: i,
			actual: meta.block_index,
		};
	}

	// 2. Verify previous meta hash
	if (meta.prev_meta_hash !== expectedPrevHash) {
		let isRollover = false;
		if (i === 0) {
			try {
				const parsedData = YAML.parse(dataDocStr);
				let innerData: any = parsedData;
				if (
					parsedData &&
					typeof parsedData === "object" &&
					!("genesis_rollover" in parsedData)
				) {
					for (const val of Object.values<any>(parsedData)) {
						if (val && typeof val === "object" && "genesis_rollover" in val) {
							innerData = val;
							break;
						}
					}
				}
				if (innerData?.genesis_rollover) {
					isRollover = true;
				}
			} catch (_e) {
				// Ignored
			}
		}

		if (isRollover) {
			if (!/^[0-9a-fA-F]{64}$/.test(meta.prev_meta_hash)) {
				return {
					valid: false,
					reason: `Invalid rollover prev_meta_hash format at block ${i}: expected 64-character SHA-256 hash, but found '${meta.prev_meta_hash}'.`,
					blockIndex: i,
					tamperedComponent: "chain",
				};
			}
		} else {
			return {
				valid: false,
				reason: `Chain link broken at block ${i}: expected prev_meta_hash to be '${expectedPrevHash}', but found '${meta.prev_meta_hash}'.`,
				blockIndex: i,
				tamperedComponent: "chain",
				expected: expectedPrevHash,
				actual: meta.prev_meta_hash,
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
			tamperedComponent: "data",
			expected: meta.data_hash,
			actual: computedDataHash,
			dataText: dataDocStr,
		};
	}

	// 4. Verify meta signature itself
	const computedMetaHash = deterministicMetaHash(meta);
	if (meta.meta_hash !== computedMetaHash) {
		return {
			valid: false,
			reason: `Cryptographic mismatch in metadata signature itself at block ${i}: calculated signature is '${computedMetaHash}', but block contains '${meta.meta_hash}'.`,
			blockIndex: i,
			tamperedComponent: "meta",
			expected: computedMetaHash,
			actual: meta.meta_hash,
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
export async function verifyChain(
	filepath: string,
): Promise<VerificationReport> {
	try {
		await fs.stat(filepath);
	} catch (err: any) {
		if (err.code === "ENOENT") {
			return {
				valid: false,
				reason: `File not found: ${filepath}`,
				tamperedComponent: "structure",
			};
		}
		throw err;
	}

	const fileStream = fsSync.createReadStream(filepath);
	const rl = readline.createInterface({
		input: fileStream,
		crlfDelay: Infinity,
	});

	let blockIndex = 0;
	let isDataDoc = true;
	let currentLines: string[] = [];
	let expectedPrevHash = GENESIS_PREV_HASH;
	let docsCount = 0;
	let currentBlockData = "";

	try {
		for await (const line of rl) {
			if (/^---\s*$/.test(line)) {
				docsCount++;
				const currentDocStr = currentLines.join("\n");
				currentLines = [];

				if (isDataDoc) {
					currentBlockData = currentDocStr;
					isDataDoc = false;
				} else {
					// Verify meta document and link back
					const blockReport = verifySingleBlock(
						blockIndex,
						currentBlockData,
						currentDocStr,
						expectedPrevHash,
					);
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
			const currentDocStr = currentLines.join("\n");
			if (isDataDoc) {
				return {
					valid: false,
					reason: `Chain structure is malformed. Expected pairs of [data, meta] documents, but found odd count.`,
					tamperedComponent: "structure",
				};
			} else {
				const blockReport = verifySingleBlock(
					blockIndex,
					currentBlockData,
					currentDocStr,
					expectedPrevHash,
				);
				if (!blockReport.valid) {
					return blockReport;
				}
				blockIndex++;
			}
		}

		if (docsCount === 0) {
			return {
				valid: false,
				reason: "File is completely empty.",
				tamperedComponent: "structure",
			};
		}

		if (docsCount % 2 !== 0) {
			return {
				valid: false,
				reason: `Chain structure is malformed. Expected pairs of [data, meta] documents, but found ${docsCount} total documents.`,
				tamperedComponent: "structure",
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
	const fileContent = await fs.readFile(filepath, "utf8");
	const docs = splitRawDocuments(fileContent);
	if (docs.length === 0) {
		return { blockCount: 0, isHealthy: false, lastBlock: null };
	}

	const blockCount = docs.length / 2;
	const isHealthy = docs.length % 2 === 0;

	let lastBlock = null;
	if (isHealthy && blockCount > 0) {
		const lastMetaDocStr = docs[docs.length - 1];
		if (lastMetaDocStr !== undefined) {
			const parsed = YAML.parse(lastMetaDocStr);
			lastBlock = parsed?.["$yaml-chain-meta"] || null;
		}
	}

	return {
		blockCount,
		isHealthy,
		lastBlock,
	};
}

/**
 * Generates structured release notes / changelog from the YAML chain.
 * @param filepath Path to chain file
 * @param owner Repository owner
 */
export async function generateReleaseNotes(
	filepath: string,
	_owner = "packablock",
): Promise<string> {
	const fileContent = await fs.readFile(filepath, "utf8");
	const docs = splitRawDocuments(fileContent);
	if (docs.length === 0) {
		throw new Error("Chain is empty.");
	}

	if (docs.length % 2 !== 0) {
		throw new Error("Chain structure is malformed (odd number of documents).");
	}

	const blockCount = docs.length / 2;
	let markdown = "# SBOM & Software Release Changelog\n\n";
	markdown += `Generated on: ${new Date().toISOString()}\n\n`;
	markdown += `Total Blocks: ${blockCount}\n\n`;
	markdown += `---\n\n`;

	// List blocks in reverse chronological order (latest first)
	for (let i = blockCount - 1; i >= 0; i--) {
		const dataDocStr = docs[2 * i];
		const metaDocStr = docs[2 * i + 1];

		if (dataDocStr === undefined || metaDocStr === undefined) {
			continue;
		}

		const _parsedData = YAML.parse(dataDocStr);
		const parsedMeta = YAML.parse(metaDocStr)?.["$yaml-chain-meta"];

		if (!parsedMeta) {
			continue;
		}

		markdown += `### 📦 Block ${i} - [${parsedMeta.timestamp}]\n`;
		markdown += `* **Block Hash**: \`${parsedMeta.meta_hash}\`\n`;
		markdown += `* **Data Hash**: \`${parsedMeta.data_hash}\`\n\n`;

		markdown += `#### 📄 Payload Data\n`;
		markdown += "```yaml\n";
		markdown += `${dataDocStr.trim()}\n`;
		markdown += "```\n\n";
		markdown += `---\n\n`;
	}

	return markdown;
}

/**
 * Reconstructs the complete packages state at the latest block of the chain file.
 * Returns a dictionary mapping package names to versions.
 */
export async function getLatestPackagesForFile(
	filepath: string,
	filename: string,
): Promise<Record<string, string>> {
	try {
		const fileContent = await fs.readFile(filepath, "utf8");
		const docs = splitRawDocuments(fileContent);
		let currentPackages: Record<string, string> = {};

		for (let i = 0; i < docs.length; i += 2) {
			const dataDocStr = docs[i];
			if (!dataDocStr) continue;

			try {
				const preprocessed = dataDocStr.replace(/^(\s*)(@[^:]+):/gm, '$1"$2":');
				const parsed = YAML.parse(preprocessed);

				let inner: any = null;
				if (parsed && typeof parsed === "object") {
					if (parsed.lockfiles && typeof parsed.lockfiles === "object") {
						if (filename in parsed.lockfiles) {
							inner = parsed.lockfiles[filename];
						}
					} else if (filename in parsed) {
						inner = parsed[filename];
					} else {
						// Check if there are other known lockfile keys in this block
						let hasOtherLockfiles = false;
						for (const [key, val] of Object.entries(parsed)) {
							if (
								key !== filename &&
								val &&
								typeof val === "object" &&
								(val as any).packages
							) {
								hasOtherLockfiles = true;
								break;
							}
						}
						// Only fallback if there are no other lockfile keys at all (e.g. old format or test format)
						if (!hasOtherLockfiles) {
							for (const [key, val] of Object.entries(parsed)) {
								if (val && typeof val === "object" && (val as any).packages) {
									inner = val;
									break;
								}
							}
						}
					}
				}

				if (inner) {
					if (inner.chain_event === "forget") {
						currentPackages = {};
					} else if (Array.isArray(inner.packages)) {
						const firstItem = inner.packages[0];
						let isDiff = false;
						if (firstItem && typeof firstItem === "object") {
							const values = Object.values(firstItem);
							if (values.length > 0 && Array.isArray(values[0])) {
								isDiff = true;
							}
						}

						if (!isDiff) {
							// Genesis Block (List of packages)
							currentPackages = {};
							for (const item of inner.packages) {
								if (item && typeof item === "object") {
									for (const [name, ver] of Object.entries(item)) {
										currentPackages[name] = String(ver);
									}
								}
							}
						} else {
							// Diff Block
							for (const item of inner.packages) {
								if (item && typeof item === "object") {
									for (const [name, ops] of Object.entries(item)) {
										if (Array.isArray(ops)) {
											let isRemoved = false;
											let newVer = "";
											for (const op of ops) {
												if (op && typeof op === "object") {
													if (op.msg === "removed") {
														isRemoved = true;
													}
													if (op.new !== undefined) {
														newVer = String(op.new);
													}
												}
											}
											if (isRemoved) {
												delete currentPackages[name];
											} else if (newVer) {
												currentPackages[name] = newVer;
											}
										}
									}
								}
							}
						}
					}
				} else if (parsed?.packages && !Array.isArray(parsed.packages)) {
					// Backward compatibility with old format
					currentPackages = { ...parsed.packages };
				}
			} catch (e) {
				// Ignore parse errors on corrupted/incomplete blocks
			}
		}

		return currentPackages;
	} catch (err: any) {
		if (err.code === "ENOENT") {
			return {};
		}
		throw err;
	}
}

export async function findLockfileInitBlock(
	filepath: string,
	filename: string,
): Promise<number | null> {
	try {
		const fileContent = await fs.readFile(filepath, "utf8");
		const docs = splitRawDocuments(fileContent);
		let initBlockIndex: number | null = null;
		let isTracked = false;

		for (let i = 0; i < docs.length; i += 2) {
			const dataDocStr = docs[i];
			if (!dataDocStr) continue;

			try {
				const preprocessed = dataDocStr.replace(/^(\s*)(@[^:]+):/gm, '$1"$2":');
				const parsed = YAML.parse(preprocessed);
				if (parsed && typeof parsed === "object") {
					let inner: any = null;
					if (parsed.lockfiles && typeof parsed.lockfiles === "object") {
						if (filename in parsed.lockfiles) {
							inner = parsed.lockfiles[filename];
						}
					} else if (filename in parsed) {
						inner = parsed[filename];
					}
					if (inner) {
						if (i === 0) {
							initBlockIndex = 0;
							isTracked = true;
						} else if (inner && typeof inner === "object") {
							if (inner.chain_event === "init") {
								initBlockIndex = i / 2;
								isTracked = true;
							} else if (inner.chain_event === "forget") {
								isTracked = false;
							} else if (inner.packages) {
								if (!isTracked) {
									initBlockIndex = i / 2;
								}
								isTracked = true;
							}
						}
					}
				}
			} catch (e) {
				// Ignore
			}
		}
		return isTracked ? initBlockIndex : null;
	} catch {
		return null;
	}
}

export async function findLockfileForgetBlock(
	filepath: string,
	filename: string,
): Promise<number | null> {
	try {
		const fileContent = await fs.readFile(filepath, "utf8");
		const docs = splitRawDocuments(fileContent);
		let forgetBlockIndex: number | null = null;
		let isTracked = false;

		for (let i = 0; i < docs.length; i += 2) {
			const dataDocStr = docs[i];
			if (!dataDocStr) continue;

			try {
				const preprocessed = dataDocStr.replace(/^(\s*)(@[^:]+):/gm, '$1"$2":');
				const parsed = YAML.parse(preprocessed);
				if (parsed && typeof parsed === "object") {
					let inner: any = null;
					if (parsed.lockfiles && typeof parsed.lockfiles === "object") {
						if (filename in parsed.lockfiles) {
							inner = parsed.lockfiles[filename];
						}
					} else if (filename in parsed) {
						inner = parsed[filename];
					}
					if (inner) {
						if (i === 0) {
							isTracked = true;
						} else if (inner && typeof inner === "object") {
							if (inner.chain_event === "init") {
								isTracked = true;
							} else if (inner.chain_event === "forget") {
								forgetBlockIndex = i / 2;
								isTracked = false;
							} else if (inner.packages) {
								isTracked = true;
							}
						}
					}
				}
			} catch (e) {
				// Ignore
			}
		}
		return !isTracked ? forgetBlockIndex : null;
	} catch {
		return null;
	}
}

export async function hasForgetEvents(filepath: string): Promise<boolean> {
	try {
		const fileContent = await fs.readFile(filepath, "utf8");
		const docs = splitRawDocuments(fileContent);
		for (let i = 0; i < docs.length; i += 2) {
			const dataDocStr = docs[i];
			if (!dataDocStr) continue;
			try {
				const preprocessed = dataDocStr.replace(/^(\s*)(@[^:]+):/gm, '$1"$2":');
				const parsed = YAML.parse(preprocessed);
				if (parsed && typeof parsed === "object") {
					const targets =
						parsed.lockfiles && typeof parsed.lockfiles === "object"
							? parsed.lockfiles
							: parsed;
					for (const val of Object.values(targets)) {
						if (
							val &&
							typeof val === "object" &&
							(val as any).chain_event === "forget"
						) {
							return true;
						}
					}
				}
			} catch {}
		}
		return false;
	} catch {
		return false;
	}
}

export async function hasLockfileInChain(
	filepath: string,
	filename: string,
): Promise<boolean> {
	const block = await findLockfileInitBlock(filepath, filename);
	return block !== null;
}

export async function getLatestPackages(
	filepath: string,
): Promise<Record<string, string>> {
	try {
		const fileContent = await fs.readFile(filepath, "utf8");
		const docs = splitRawDocuments(fileContent);

		// 1. Scan all unique lockfile name keys in the chain
		const allKeys = new Set<string>();
		for (let i = 0; i < docs.length; i += 2) {
			const dataDocStr = docs[i];
			if (!dataDocStr) continue;
			try {
				const preprocessed = dataDocStr.replace(/^(\s*)(@[^:]+):/gm, '$1"$2":');
				const parsed = YAML.parse(preprocessed);
				if (parsed && typeof parsed === "object") {
					const targets =
						parsed.lockfiles && typeof parsed.lockfiles === "object"
							? parsed.lockfiles
							: parsed;
					for (const [key, val] of Object.entries(targets)) {
						if (val && typeof val === "object" && (val as any).packages) {
							allKeys.add(key);
						}
					}
				}
			} catch {}
		}

		// 2. Aggregate packages from tracked lockfiles
		const currentPackages: Record<string, string> = {};
		for (const key of allKeys) {
			const isTracked = (await findLockfileInitBlock(filepath, key)) !== null;
			if (isTracked) {
				const pkgs = await getLatestPackagesForFile(filepath, key);
				Object.assign(currentPackages, pkgs);
			}
		}

		// 3. Fallback for backward compatibility with old format
		for (let i = 0; i < docs.length; i += 2) {
			const dataDocStr = docs[i];
			if (!dataDocStr) continue;
			try {
				const preprocessed = dataDocStr.replace(/^(\s*)(@[^:]+):/gm, '$1"$2":');
				const parsed = YAML.parse(preprocessed);
				if (parsed?.packages && !Array.isArray(parsed.packages)) {
					Object.assign(currentPackages, parsed.packages);
				}
			} catch {}
		}

		return currentPackages;
	} catch (err: any) {
		if (err.code === "ENOENT") {
			return {};
		}
		throw err;
	}
}

export async function getPackageHistory(
	filepath: string,
): Promise<Record<string, { firstSeen: string; currentPinned: string }>> {
	const fileContent = await fs.readFile(filepath, "utf8");
	const docs = splitRawDocuments(fileContent);

	const history: Record<string, { firstSeen: string; currentPinned: string }> =
		{};

	// Iterate through even indexes (data docs)
	for (let i = 0; i < docs.length; i += 2) {
		const dataDocStr = docs[i];
		if (!dataDocStr) continue;

		try {
			const preprocessed = dataDocStr.replace(/^(\s*)(@[^:]+):/gm, '$1"$2":');
			const parsed = YAML.parse(preprocessed);

			if (parsed && typeof parsed === "object") {
				for (const val of Object.values<any>(parsed)) {
					if (val && typeof val === "object" && val.packages) {
						if (Array.isArray(val.packages)) {
							const firstItem = val.packages[0];
							let isDiff = false;
							if (firstItem && typeof firstItem === "object") {
								const values = Object.values(firstItem);
								if (values.length > 0 && Array.isArray(values[0])) {
									isDiff = true;
								}
							}

							if (!isDiff) {
								// Genesis Block
								const newKeys = new Set<string>();
								for (const item of val.packages) {
									if (item && typeof item === "object") {
										for (const name of Object.keys(item)) {
											newKeys.add(name);
										}
									}
								}
								for (const name of Object.keys(history)) {
									if (!newKeys.has(name)) {
										delete history[name];
									}
								}

								for (const item of val.packages) {
									if (item && typeof item === "object") {
										for (const [name, ver] of Object.entries(item)) {
											const cleanVer = String(ver);
											if (!history[name]) {
												history[name] = {
													firstSeen: cleanVer,
													currentPinned: cleanVer,
												};
											} else {
												history[name].currentPinned = cleanVer;
											}
										}
									}
								}
							} else {
								// Diff Block
								for (const item of val.packages) {
									if (item && typeof item === "object") {
										for (const [name, ops] of Object.entries(item)) {
											if (Array.isArray(ops)) {
												let isRemoved = false;
												let newVer = "";
												for (const op of ops) {
													if (op && typeof op === "object") {
														if (op.msg === "removed") {
															isRemoved = true;
														}
														if (op.new !== undefined) {
															newVer = String(op.new);
														}
													}
												}
												if (isRemoved) {
													delete history[name];
												} else if (newVer) {
													if (!history[name]) {
														history[name] = {
															firstSeen: newVer,
															currentPinned: newVer,
														};
													} else {
														history[name].currentPinned = newVer;
													}
												}
											}
										}
									}
								}
							}
						}
					}
				}
			}
			if (parsed?.packages && !Array.isArray(parsed.packages)) {
				// Old format backward compatibility
				for (const name of Object.keys(history)) {
					if (!(name in parsed.packages)) {
						delete history[name];
					}
				}
				for (const [name, version] of Object.entries<string>(parsed.packages)) {
					const cleanVer =
						typeof version === "string" ? version : String(version);
					if (!history[name]) {
						history[name] = { firstSeen: cleanVer, currentPinned: cleanVer };
					} else {
						history[name].currentPinned = cleanVer;
					}
				}
			}
		} catch {
			// Ignore parse errors on corrupted blocks
		}
	}

	return history;
}

/**
 * Rolls over the cryptographically secured package chain file.
 * Creates a linked rollover genesis block and backs up the existing chain.
 */
export async function rolloverChain(
	filepath: string,
	options: {
		serverUrl?: string;
		token?: string;
		repo?: string;
	} = {},
): Promise<{
	backupPath: string;
	prevMetaHash: string;
	newGenesisHash: string;
}> {
	const resolvedPath = path.resolve(filepath);

	// 1. Verify log integrity first
	const report = await verifyChain(resolvedPath);
	if (!report.valid) {
		throw new Error(
			`Chain log integrity verification failed! Cannot roll over a tampered log. Reason: ${report.reason}`,
		);
	}

	// 2. Fetch last block details and current packages state before file is overwritten
	const status = await getChainStatus(resolvedPath);
	if (!status.lastBlock || !status.lastBlock.meta_hash) {
		throw new Error(
			"No blocks found in local chain log. Run init and append some package blocks first.",
		);
	}
	const prevMetaHash = status.lastBlock.meta_hash;
	const currentPackages = await getLatestPackages(resolvedPath);

	// 3. Backup the old chain file
	const backupPath = path.join(
		path.dirname(resolvedPath),
		`packablock-${prevMetaHash}.yaml`,
	);
	await fs.copyFile(resolvedPath, backupPath);

	// 4. Create new rollover block data content wrapped under the lockfile name root key
	const fileContent = await fs.readFile(resolvedPath, "utf8");
	const docs = splitRawDocuments(fileContent);
	const firstDocStr = docs[0];
	if (!firstDocStr) {
		throw new Error("Malformed chain: missing genesis block.");
	}

	const allKeys = new Set<string>();
	for (let i = 0; i < docs.length; i += 2) {
		const dataDocStr = docs[i];
		if (!dataDocStr) continue;
		try {
			const preprocessed = dataDocStr.replace(/^(\s*)(@[^:]+):/gm, '$1"$2":');
			const parsed = YAML.parse(preprocessed);
			if (parsed && typeof parsed === "object") {
				for (const [key, val] of Object.entries(parsed)) {
					if (val && typeof val === "object" && (val as any).packages) {
						allKeys.add(key);
					}
				}
			}
		} catch {}
	}

	const filenameKeys: string[] = [];
	for (const key of allKeys) {
		const isTracked = (await findLockfileInitBlock(resolvedPath, key)) !== null;
		if (isTracked) {
			filenameKeys.push(key);
		}
	}

	if (filenameKeys.length === 0) {
		const firstDocParsed = YAML.parse(firstDocStr);
		if (firstDocParsed && typeof firstDocParsed === "object") {
			for (const [key, val] of Object.entries(firstDocParsed)) {
				if (val && typeof val === "object" && (val as any).packages) {
					const isTracked =
						(await findLockfileInitBlock(resolvedPath, key)) !== null;
					if (isTracked) {
						filenameKeys.push(key);
					}
				}
			}
		}
	}

	if (filenameKeys.length === 0) {
		filenameKeys.push("package-lock.json"); // default fallback
	}

	const rolloverDataObj: Record<string, any> = {
		genesis_rollover: true,
		rotated_at: new Date().toISOString(),
		previous_chain_hash: prevMetaHash,
	};
	for (const filenameKey of filenameKeys) {
		const pkgs = await getLatestPackagesForFile(resolvedPath, filenameKey);
		rolloverDataObj[filenameKey] = {
			packages: Object.entries(pkgs).map(([name, ver]) => ({
				[name]: ver,
			})),
		};
	}
	const rolloverData = YAML.stringify(rolloverDataObj);

	try {
		// 5. Initialize the new chain with the rollover genesis block
		const newGenesisMeta = await initChain(
			resolvedPath,
			rolloverData,
			prevMetaHash,
		);
		const newGenesisHash = newGenesisMeta.meta_hash!;

		// 6. Coordinate with the registry server if configuration is provided
		const serverUrl =
			options.serverUrl ||
			process.env.PACKABLOCK_API_SERVER ||
			"http://localhost:3030";
		const { getGitRemoteRepo } = await import("./api.js");
		const repoPath = options.repo || getGitRemoteRepo();

		if (options.token && repoPath) {
			const [owner, repoName] = repoPath.split("/");
			if (owner && repoName) {
				const newGenesisBlockContent = await fs.readFile(resolvedPath, "utf8");

				const res = await fetch(
					`${serverUrl.replace(/\/$/, "")}/api/v1/repo/${owner}/${repoName}/rollover`,
					{
						method: "POST",
						headers: {
							"Content-Type": "application/json",
							"X-Repo-Token": options.token,
						},
						body: JSON.stringify({
							previous_chain_hash: prevMetaHash,
							new_genesis_block: newGenesisBlockContent,
						}),
					},
				);

				if (!res.ok) {
					const errData = (await res
						.json()
						.catch(() => ({ message: "Unknown error" }))) as any;
					throw new Error(errData.message || res.statusText);
				}
			}
		}

		return {
			backupPath,
			prevMetaHash,
			newGenesisHash,
		};
	} catch (err: any) {
		// Rollback in case of server failures
		try {
			await fs.copyFile(backupPath, resolvedPath);
			await fs.unlink(backupPath);
		} catch (e) {}
		throw new Error(`Rollover transaction failed: ${err.message}`);
	}
}
