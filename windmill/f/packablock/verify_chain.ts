import { createHash } from "node:crypto";
import YAML from "yaml";

export async function main(
	owner: string,
	repo: string,
	api_server: string = "http://localhost:3030",
	repo_token?: string,
) {
	const url = `${api_server.replace(/\/$/, "")}/api/v1/log/pull`;
	const headers: Record<string, string> = {
		Accept: "text/yaml",
		"X-Target-Repo": `${owner}/${repo}`,
	};

	if (repo_token) {
		headers["X-Repo-Token"] = repo_token;
	}

	console.log(`Pulling chain from: ${url}`);
	const res = await fetch(url, { headers });
	if (!res.ok) {
		throw new Error(
			`Failed to pull chain from server: ${res.status} ${res.statusText}`,
		);
	}

	const chainContent = await res.text();
	console.log(
		`Successfully retrieved chain content. Length: ${chainContent.length} bytes.`,
	);

	const report = verifyInMemoryChain(chainContent);
	console.log("Verification report:", report);
	return report;
}

// Standalone verification logic for isolated execution environment
function sha256(text: string): string {
	return createHash("sha256").update(text, "utf8").digest("hex");
}

function deterministicMetaHash(meta: Record<string, any>): string {
	const { meta_hash, ...rest } = meta;
	const sortedKeys = Object.keys(rest).sort();
	const sortedObj: Record<string, any> = {};
	for (const key of sortedKeys) {
		const val = rest[key];
		if (val !== null && typeof val === "object" && !Array.isArray(val)) {
			sortedObj[key] = sortKeysObject(val);
		} else {
			sortedObj[key] = val;
		}
	}
	return sha256(JSON.stringify(sortedObj));
}

function sortKeysObject(obj: Record<string, any>): Record<string, any> {
	const sorted: Record<string, any> = {};
	for (const key of Object.keys(obj).sort()) {
		const val = obj[key];
		if (val !== null && typeof val === "object" && !Array.isArray(val)) {
			sorted[key] = sortKeysObject(val);
		} else {
			sorted[key] = val;
		}
	}
	return sorted;
}

function splitRawDocuments(fileContent: string): string[] {
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

function verifyInMemoryChain(chainContent: string) {
	const docs = splitRawDocuments(chainContent);
	if (docs.length === 0) {
		return {
			valid: false,
			reason: "Chain content is empty.",
			tamperedComponent: "structure",
		};
	}

	if (docs.length % 2 !== 0) {
		return {
			valid: false,
			reason: `Chain structure is malformed. Expected pairs of [data, meta] documents, but found ${docs.length} total documents.`,
			tamperedComponent: "structure",
		};
	}

	const blockCount = docs.length / 2;
	let expectedPrevHash =
		"0000000000000000000000000000000000000000000000000000000000000000";
	let lastBlockHash = "";

	for (let i = 0; i < blockCount; i++) {
		const dataDocStr = docs[2 * i];
		const metaDocStr = docs[2 * i + 1];

		if (dataDocStr === undefined || metaDocStr === undefined) {
			return {
				valid: false,
				reason: `Document sequence is missing block data at index ${i}.`,
				blockIndex: i,
				tamperedComponent: "chain",
			};
		}

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

		if (meta.prev_meta_hash !== expectedPrevHash) {
			return {
				valid: false,
				reason: `Chain link broken at block ${i}: expected prev_meta_hash to be '${expectedPrevHash}', but found '${meta.prev_meta_hash}'.`,
				blockIndex: i,
				tamperedComponent: "chain",
				expected: expectedPrevHash,
				actual: meta.prev_meta_hash,
			};
		}

		const computedDataHash = sha256(dataDocStr.trim());
		if (meta.data_hash !== computedDataHash) {
			return {
				valid: false,
				reason: `Cryptographic mismatch in data payload at block ${i}: calculated hash is '${computedDataHash}', but metadata signature has '${meta.data_hash}'.`,
				blockIndex: i,
				tamperedComponent: "data",
				expected: meta.data_hash,
				actual: computedDataHash,
			};
		}

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

		expectedPrevHash = meta.meta_hash;
		lastBlockHash = meta.meta_hash;
	}

	return {
		valid: true,
		lastBlockHash,
		blockCount,
	};
}
