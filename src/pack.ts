import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execSync } from "node:child_process";
import { verifyChain, getChainStatus } from "./chain.js";
import { sha256 } from "./hash.js";

export interface FileIntegrity {
	path: string;
	integrity: string;
}

export interface BuildManifest {
	manifestVersion: string;
	timestamp: string;
	lastBlockHash: string;
	blockIndex: number;
	files: FileIntegrity[];
	signature: string;
	authType?: string;
}

/**
 * Recursively scans the directory to gather all file paths and compute their integrity hashes.
 * Excludes standard directories (.git, node_modules, build outputs, and the output tarball name).
 */
export async function gatherFiles(
	dir: string,
	baseDir: string,
	outputTarballName: string,
): Promise<FileIntegrity[]> {
	const files: FileIntegrity[] = [];

	async function recurse(currentDir: string) {
		const entries = await fs.readdir(currentDir, { withFileTypes: true });

		for (const entry of entries) {
			const fullPath = path.join(currentDir, entry.name);
			const relativePath = path.relative(baseDir, fullPath);

			// Exclude common developmental/clutter folders
			if (
				entry.isDirectory() &&
				(entry.name === ".git" ||
					entry.name === "node_modules" ||
					entry.name === "dist" ||
					entry.name === "build")
			) {
				continue;
			}

			// Exclude common files, the tarball output, and the manifest itself
			if (entry.isFile()) {
				if (
					entry.name === outputTarballName ||
					entry.name === "pblk-manifest.json" ||
					entry.name === ".env" ||
					entry.name === ".DS_Store"
				) {
					continue;
				}

				try {
					const fileBytes = await fs.readFile(fullPath);
					const fileHash = sha256(fileBytes.toString("utf8"));
					files.push({
						path: relativePath,
						integrity: `sha256-${fileHash}`,
					});
				} catch (e) {
					// Skip unreadable files gracefully
				}
			} else if (entry.isDirectory()) {
				await recurse(fullPath);
			}
		}
	}

	await recurse(dir);
	// Sort files by path for deterministic manifest hashing
	return files.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Signs the build manifest files using HMAC-SHA256 (for shared secrets) or RSA private key.
 */
export function signManifest(
	files: FileIntegrity[],
	metadata: { lastBlockHash: string; blockIndex: number },
	options: { secret?: string; keyPath?: string },
): { signature: string; authType: string } {
	const manifestData = JSON.stringify({
		lastBlockHash: metadata.lastBlockHash,
		blockIndex: metadata.blockIndex,
		files,
	});

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
	options: { secret?: string; keyPath?: string },
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
	if (!status.lastBlock) {
		throw new Error(
			"No blocks found in local chain log. Initialize and add a package to the chain first.",
		);
	}

	if (!status.lastBlock.meta_hash) {
		throw new Error("Last block metadata is missing its cryptographic hash.");
	}

	const metadata = {
		lastBlockHash: status.lastBlock.meta_hash,
		blockIndex: status.lastBlock.block_index,
	};

	// 3. Gather files and calculate integrity
	const filesList = await gatherFiles(
		resolvedDir,
		resolvedDir,
		outputTarballName,
	);

	// 4. Sign build manifest
	const { signature, authType } = signManifest(filesList, metadata, options);

	const manifest: BuildManifest = {
		manifestVersion: "1.0.0",
		timestamp: new Date().toISOString(),
		lastBlockHash: metadata.lastBlockHash,
		blockIndex: metadata.blockIndex,
		files: filesList,
		signature,
		authType,
	};

	// 5. Write pblk-manifest.json to target workspace
	const manifestPath = path.join(resolvedDir, "pblk-manifest.json");
	await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");

	// 6. Compile release tarball to a secure temporary directory
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
