import { describe, expect, it, afterEach, beforeEach } from "bun:test";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { initChain } from "../src/chain.js";
import { packWorkspace, gatherFiles, signManifest } from "../src/pack.js";

describe("Release Packaging Subcommand Tests", () => {
	const tempDir = path.resolve(__dirname, "temp-pack-workspace");
	const tempLog = path.join(tempDir, "packablock.yaml");
	const tempTarball = path.join(tempDir, "release.tar.gz");

	beforeEach(async () => {
		// Set up mock directory
		await fs.mkdir(tempDir, { recursive: true });
		await fs.mkdir(path.join(tempDir, "src"), { recursive: true });
		await fs.mkdir(path.join(tempDir, "node_modules"), { recursive: true });
		await fs.mkdir(path.join(tempDir, ".git"), { recursive: true });

		// Add mock files
		await fs.writeFile(
			path.join(tempDir, "src", "index.js"),
			"console.log('hello');",
			"utf8",
		);
		await fs.writeFile(
			path.join(tempDir, "src", "utils.js"),
			"export const add = (a, b) => a + b;",
			"utf8",
		);
		await fs.writeFile(
			path.join(tempDir, "node_modules", "lodash.js"),
			"module.exports = {};",
			"utf8",
		);
		await fs.writeFile(path.join(tempDir, ".git", "config"), "[core]", "utf8");
		await fs.writeFile(path.join(tempDir, ".env"), "SECRET_TOKEN=1234", "utf8");
	});

	afterEach(async () => {
		// Clean up files
		try {
			await fs.rm(tempDir, { recursive: true, force: true });
		} catch (e) {}
	});

	it("should gather workspace files deterministic excluding common developmental directories and clutter", async () => {
		const files = await gatherFiles(tempDir, tempDir, "release.tar.gz");

		// Should find src/index.js and src/utils.js
		const paths = files.map((f) => f.path);
		expect(paths).toContain("src/index.js");
		expect(paths).toContain("src/utils.js");

		// Should NOT contain .git, node_modules, or .env files
		expect(paths).not.toContain(".git/config");
		expect(paths).not.toContain("node_modules/lodash.js");
		expect(paths).not.toContain(".env");

		// The list should be alphabetically sorted
		expect(paths).toEqual(["src/index.js", "src/utils.js"]);
	});

	it("should sign a manifest correctly with HMAC-SHA256 when a secret is provided", () => {
		const files = [
			{ path: "src/index.js", integrity: "sha256-hash1" },
			{ path: "src/utils.js", integrity: "sha256-hash2" },
		];
		const metadata = { lastBlockHash: "mockHash", blockIndex: 2 };
		const secret = "shared-secret";

		const { signature, authType } = signManifest(files, metadata, { secret });
		expect(authType).toBe("hmac-sha256");
		expect(signature).toBeDefined();

		// Manually calculate signature to assert match
		const expectedData = JSON.stringify({
			lastBlockHash: metadata.lastBlockHash,
			blockIndex: metadata.blockIndex,
			files,
		});
		const expectedSig = crypto
			.createHmac("sha256", secret)
			.update(expectedData)
			.digest("hex");
		expect(signature).toBe(expectedSig);
	});

	it("should perform integrity checks, build and sign the manifest, and assemble the release tarball", async () => {
		// Seed a valid local chain
		const initialChainData = "packages:\n  lodash: 4.17.21";
		const chainMeta = await initChain(tempLog, initialChainData);

		const secret = "my-test-secret";
		const { manifest, tarballPath } = await packWorkspace(
			tempDir,
			tempTarball,
			tempLog,
			{ secret },
		);

		expect(tarballPath).toBe(tempTarball);
		expect(manifest.manifestVersion).toBe("1.0.0");
		expect(manifest.lastBlockHash).toBe(chainMeta.meta_hash!);
		expect(manifest.blockIndex).toBe(0);
		expect(manifest.authType).toBe("hmac-sha256");
		expect(manifest.files).toHaveLength(3); // src/index.js, src/utils.js, and packablock.yaml (chain file itself is packaged)

		// Assert pblk-manifest.json exists inside target workspace
		const manifestJsonPath = path.join(tempDir, "pblk-manifest.json");
		expect(fsSync.existsSync(manifestJsonPath)).toBe(true);

		// Assert release.tar.gz was successfully compiled on disk
		expect(fsSync.existsSync(tempTarball)).toBe(true);
	});

	it("should immediately abort and throw an error when packing a tampered chain log", async () => {
		// Seed a valid local chain
		await initChain(tempLog, "packages:\n  lodash: 4.17.21");

		// Tamper the chain file
		let content = await fs.readFile(tempLog, "utf8");
		content = content.replace("lodash: 4.17.21", "lodash: 4.17.99");
		await fs.writeFile(tempLog, content, "utf8");

		// Attempt to pack, which should throw
		expect(
			packWorkspace(tempDir, tempTarball, tempLog, { secret: "test" }),
		).rejects.toThrow("Chain integrity validation failed");

		// Assert no release.tar.gz was compiled
		expect(fsSync.existsSync(tempTarball)).toBe(false);
	});
});
