import { describe, expect, it, afterEach, beforeEach } from "bun:test";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { initChain } from "../src/chain.js";
import { packWorkspace, extractSigners, signManifest } from "../src/pack.js";

describe("Release Packaging Subcommand Tests", () => {
	const tempDir = path.resolve(__dirname, "temp-pack-workspace");
	const tempLog = path.join(tempDir, "packablock.yaml");
	const tempTarball = path.join(tempDir, "release.tar.gz");

	beforeEach(async () => {
		// Set up mock directory
		await fs.mkdir(tempDir, { recursive: true });
		await fs.mkdir(path.join(tempDir, "src"), { recursive: true });

		// Add mock source files
		await fs.writeFile(
			path.join(tempDir, "src", "index.js"),
			"console.log('hello');",
			"utf8",
		);
	});

	afterEach(async () => {
		// Clean up files
		try {
			await fs.rm(tempDir, { recursive: true, force: true });
		} catch (e) {}
	});

	it("should sign a manifest report deterministically with HMAC-SHA256", () => {
		const manifestWithoutSig = {
			manifestVersion: "1.0.0",
			timestamp: new Date().toISOString(),
			chainStatus: {
				isHealthy: true,
				blockCount: 1,
				lastBlockHash: "mockHash",
				lastBlockTimestamp: "2026-06-01T10:43:18Z",
			},
			registryStatus: {
				isAnchored: false,
				registryUrl: null,
				syncStatus: "unanchored" as const,
				remoteBlockHash: null,
			},
			signerIdentities: [
				{
					blockIndex: 0,
					committer: "Aaron Bronow",
					keyIdOrIdentity: "gpg-key-1",
				},
			],
		};
		const secret = "shared-secret";

		const { signature, authType } = signManifest(manifestWithoutSig, {
			secret,
		});
		expect(authType).toBe("hmac-sha256");
		expect(signature).toBeDefined();

		// Manually calculate signature to assert match
		const expectedData = JSON.stringify(manifestWithoutSig);
		const expectedSig = crypto
			.createHmac("sha256", secret)
			.update(expectedData)
			.digest("hex");
		expect(signature).toBe(expectedSig);
	});

	it("should parse the chain log and extract unique GPG and OIDC signer identities correctly", async () => {
		// Seed a valid local chain with standard committer info
		const initialChainData = "packages:\n  lodash: 4.17.21";
		const chainMeta = await initChain(tempLog, initialChainData);

		const signers = await extractSigners(tempLog);
		expect(signers).toHaveLength(1);
		const firstSigner = signers[0]!;
		expect(firstSigner.blockIndex).toBe(0);
		// If unsigned, committer defaults to Unknown or matches signature parsing
		expect(firstSigner.committer).toBeDefined();
		expect(firstSigner.keyIdOrIdentity).toBe("unsigned");
	});

	it("should perform integrity checks, build and sign the refined metadata manifest, and assemble the release tarball", async () => {
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
		expect(manifest.chainStatus.isHealthy).toBe(true);
		expect(manifest.chainStatus.blockCount).toBe(1);
		expect(manifest.chainStatus.lastBlockHash).toBe(chainMeta.meta_hash!);
		expect(manifest.authType).toBe("hmac-sha256");
		expect(manifest.signerIdentities).toHaveLength(1);

		// Assert pblk-manifest.json exists inside target workspace
		const manifestJsonPath = path.join(tempDir, "pblk-manifest.json");
		expect(fsSync.existsSync(manifestJsonPath)).toBe(true);

		// Read manifest file and check it does NOT list every source file
		const manifestContent = JSON.parse(
			await fs.readFile(manifestJsonPath, "utf8"),
		);
		expect(manifestContent.files).toBeUndefined();

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
