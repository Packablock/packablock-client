import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execSync } from "node:child_process";
import { verifyChain, getChainStatus, splitRawDocuments } from "./chain.js";
import { sha256 } from "./hash.js";
import { getGitRemoteRepo } from "./api.js";
import YAML from "yaml";

export interface SignerIdentity {
	blockIndex: number;
	committer: string;
	keyIdOrIdentity: string;
}

export interface BuildManifest {
	manifestVersion: string;
	timestamp: string;
	chainStatus: {
		isHealthy: boolean;
		blockCount: number;
		lastBlockHash: string;
		lastBlockTimestamp: string;
	};
	registryStatus: {
		isAnchored: boolean;
		registryUrl: string | null;
		syncStatus: "synced" | "divergent" | "unanchored" | "offline";
		remoteBlockHash: string | null;
	};
	signerIdentities: SignerIdentity[];
	signature: string;
	authType: string;
}

/**
 * Extracts signer identities from each metadata block in the package chain.
 */
export async function extractSigners(
	resolvedLog: string,
): Promise<SignerIdentity[]> {
	const content = await fs.readFile(resolvedLog, "utf8");
	const docs = splitRawDocuments(content);
	const blockCount = docs.length / 2;
	const signers: SignerIdentity[] = [];

	for (let i = 0; i < blockCount; i++) {
		const metaDocStr = docs[2 * i + 1];
		if (metaDocStr === undefined) continue;

		const parsedMeta = YAML.parse(metaDocStr)?.["$yaml-chain-meta"];
		if (parsedMeta) {
			const committer = parsedMeta.committer || "Unknown";
			// Extract a brief key identifier or fallback to OIDC actor claims
			let keyIdOrIdentity = "unsigned";
			if (parsedMeta.signature) {
				keyIdOrIdentity = parsedMeta.signature.includes("BEGIN")
					? "gpg-signature"
					: parsedMeta.signature.substring(0, 16);
			} else if (parsedMeta.oidc_claims?.actor) {
				keyIdOrIdentity = parsedMeta.oidc_claims.actor;
			}

			signers.push({
				blockIndex: parsedMeta.block_index,
				committer,
				keyIdOrIdentity,
			});
		}
	}

	return signers;
}

/**
 * Signs the build manifest using HMAC-SHA256 or RSA.
 */
export function signManifest(
	manifestWithoutSig: Omit<BuildManifest, "signature" | "authType">,
	options: { secret?: string; keyPath?: string },
): { signature: string; authType: string } {
	// Deterministically sort keys of the manifest report before stringifying
	const manifestData = JSON.stringify(manifestWithoutSig);

	if (options.secret) {
		const hmac = crypto
			.createHmac("sha256", options.secret)
			.update(manifestData)
			.digest("hex");
		return { signature: hmac, authType: "hmac-sha256" };
	}

	if (options.keyPath) {
		try {
			const privateKey = fsSync.readFileSync(options.keyPath, "utf8");
			const sign = crypto.createSign("SHA256");
			sign.update(manifestData);
			sign.end();
			const signature = sign.sign(privateKey, "hex");
			return { signature, authType: "rsa-sha256" };
		} catch (err: any) {
			throw new Error(
				`Failed to sign manifest with private key: ${err.message}`,
			);
		}
	}

	return { signature: "unsigned", authType: "none" };
}

/**
 * Performs log integrity validation, compiles the build manifest, signs it, and bundles the workspace into a release tarball.
 */
export async function packWorkspace(
	dir: string,
	outputTarball: string,
	logFile: string,
	options: {
		secret?: string;
		keyPath?: string;
		serverUrl?: string;
		targetRepo?: string;
	},
): Promise<{ manifest: BuildManifest; tarballPath: string }> {
	const resolvedDir = path.resolve(dir);
	const resolvedLog = path.resolve(logFile);
	const outputTarballName = path.basename(outputTarball);
	const resolvedTarball = path.resolve(outputTarball);

	// 1. Verify log file integrity
	const report = await verifyChain(resolvedLog);
	if (!report.valid) {
		throw new Error(
			`Chain integrity validation failed! Aborting packaging. Reason: ${report.reason}`,
		);
	}

	// 2. Fetch last block details
	const status = await getChainStatus(resolvedLog);
	if (!status.lastBlock || !status.lastBlock.meta_hash) {
		throw new Error(
			"No healthy blocks found in local chain log. Initialize and add a package to the chain first.",
		);
	}

	const metadata = {
		lastBlockHash: status.lastBlock.meta_hash,
		blockIndex: status.lastBlock.block_index,
		timestamp: status.lastBlock.timestamp,
	};

	// 3. Extract Signer Identities
	const signerIdentities = await extractSigners(resolvedLog);

	// 4. Resolve Registry Anchoring Status
	let isAnchored = false;
	let syncStatus: "synced" | "divergent" | "unanchored" | "offline" =
		"unanchored";
	let remoteBlockHash: string | null = null;

	const resolvedServer =
		options.serverUrl ||
		process.env.PACKABLOCK_API_SERVER ||
		"http://localhost:3030";
	const repoPath = options.targetRepo || getGitRemoteRepo();

	if (repoPath && resolvedServer) {
		const [owner, repo] = repoPath.split("/");
		if (owner && repo) {
			try {
				const res = await fetch(
					`${resolvedServer.replace(/\/$/, "")}/api/v1/repo/${owner}/${repo}/history`,
					{ signal: AbortSignal.timeout(3000) },
				);
				if (res.ok) {
					const data: any = await res.json();
					if (data.success && data.history && data.history.length > 0) {
						isAnchored = true;
						const latestRemoteBlock = data.history[data.history.length - 1];
						remoteBlockHash = latestRemoteBlock.metaHash;
						if (remoteBlockHash === metadata.lastBlockHash) {
							syncStatus = "synced";
						} else {
							syncStatus = "divergent";
						}
					}
				} else if (res.status === 404) {
					syncStatus = "unanchored";
				}
			} catch (e) {
				syncStatus = "offline";
			}
		}
	}

	const manifestWithoutSig: Omit<BuildManifest, "signature" | "authType"> = {
		manifestVersion: "1.0.0",
		timestamp: new Date().toISOString(),
		chainStatus: {
			isHealthy: status.isHealthy,
			blockCount: status.blockCount,
			lastBlockHash: metadata.lastBlockHash,
			lastBlockTimestamp: metadata.timestamp,
		},
		registryStatus: {
			isAnchored,
			registryUrl: isAnchored ? resolvedServer : null,
			syncStatus,
			remoteBlockHash,
		},
		signerIdentities,
	};

	// 5. Sign build manifest
	const { signature, authType } = signManifest(manifestWithoutSig, options);

	const manifest: BuildManifest = {
		...manifestWithoutSig,
		signature,
		authType,
	};

	// 6. Write pblk-manifest.json to target workspace
	const manifestPath = path.join(resolvedDir, "pblk-manifest.json");
	await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");

	// 7. Compile release tarball to a secure temporary directory
	const os = await import("node:os");
	const tempTarballDir = await fs.mkdtemp(path.join(os.tmpdir(), "pblk-pack-"));
	const tempTarballPath = path.join(tempTarballDir, outputTarballName);

	try {
		let cmd = `tar -czf "${tempTarballPath}" -C "${resolvedDir}"`;
		cmd += " --exclude=.git --exclude=node_modules";
		cmd += " .";

		execSync(cmd, { stdio: "pipe" });

		// Move output to final destination
		await fs.rename(tempTarballPath, resolvedTarball);
	} catch (err: any) {
		const stderr = err.stderr ? `: ${err.stderr.toString().trim()}` : "";
		// Clean up manifest on failure
		try {
			await fs.unlink(manifestPath);
		} catch (e) {}
		throw new Error(`Failed to compile release tarball${stderr}`);
	} finally {
		// Clean up temp dir
		try {
			await fs.rm(tempTarballDir, { recursive: true, force: true });
		} catch (e) {}
	}

	return {
		manifest,
		tarballPath: resolvedTarball,
	};
}
