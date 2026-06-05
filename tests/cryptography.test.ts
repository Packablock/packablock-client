import { describe, expect, it, afterEach, beforeEach } from "bun:test";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { initChain } from "../src/chain.js";
import { packWorkspace, signManifest, verifyPack } from "../src/pack.js";

describe("Client Cryptographic Unit & Integration Test Suite", () => {
	const tempDir = path.resolve(__dirname, "temp-crypto-workspace");
	const tempLog = path.join(tempDir, "packablock.yaml");
	const tempTarball = path.join(tempDir, "release.tar.gz");
	const originalFetch = globalThis.fetch;
	let mockHistoryResponse: any = null;
	let mockFetchStatus = 200;

	beforeEach(async () => {
		// Set up mock directory
		await fs.mkdir(tempDir, { recursive: true });
		await fs.mkdir(path.join(tempDir, "src"), { recursive: true });

		// Add mock source files
		await fs.writeFile(
			path.join(tempDir, "src", "index.js"),
			"console.log('hello crypto');",
			"utf8",
		);

		// Mock global fetch
		mockHistoryResponse = null;
		mockFetchStatus = 200;
		globalThis.fetch = (async (url: string | URL | Request) => {
			const urlStr = url.toString();
			if (urlStr.includes("/api/v1/repo/")) {
				if (mockFetchStatus !== 200) {
					return {
						ok: false,
						status: mockFetchStatus,
						json: async () => ({
							success: false,
							error: "Internal Server Error",
						}),
					} as Response;
				}
				if (mockHistoryResponse) {
					return {
						ok: true,
						status: 200,
						json: async () => mockHistoryResponse,
					} as Response;
				}
				return {
					ok: false,
					status: 404,
					json: async () => ({ success: false }),
				} as Response;
			}
			return {
				ok: false,
				status: 500,
			} as Response;
		}) as any;
	});

	afterEach(async () => {
		// Clean up files
		try {
			await fs.rm(tempDir, { recursive: true, force: true });
		} catch (e) {}
		globalThis.fetch = originalFetch;
	});

	it("should sign a manifest report with HMAC-SHA256 and verify it", () => {
		const manifestWithoutSig = {
			manifestVersion: "1.0.0",
			timestamp: new Date().toISOString(),
			chainStatus: {
				isHealthy: true,
				blockCount: 1,
				lastBlockHash: "abc-123",
				lastBlockTimestamp: "2026-06-01T10:00:00Z",
			},
			registryStatus: {
				isAnchored: false,
				registryUrl: null,
				syncStatus: "unanchored" as const,
				remoteBlockHash: null,
			},
			signerIdentities: [],
		};
		const secret = "shared-secret-key-12345";
		const { signature, authType } = signManifest(manifestWithoutSig, {
			secret,
		});

		expect(authType).toBe("hmac-sha256");
		expect(signature).toBeDefined();

		// Calculate signature manually to verify it matches
		const data = JSON.stringify(manifestWithoutSig);
		const expectedHmac = crypto
			.createHmac("sha256", secret)
			.update(data)
			.digest("hex");
		expect(signature).toBe(expectedHmac);
	});

	it("should sign a manifest report with RSA-SHA256 using a private key file", async () => {
		const manifestWithoutSig = {
			manifestVersion: "1.0.0",
			timestamp: new Date().toISOString(),
			chainStatus: {
				isHealthy: true,
				blockCount: 1,
				lastBlockHash: "abc-123",
				lastBlockTimestamp: "2026-06-01T10:00:00Z",
			},
			registryStatus: {
				isAnchored: false,
				registryUrl: null,
				syncStatus: "unanchored" as const,
				remoteBlockHash: null,
			},
			signerIdentities: [],
		};

		// Generate an RSA key pair dynamically
		const { privateKey } = crypto.generateKeyPairSync("rsa", {
			modulusLength: 2048,
			publicKeyEncoding: { type: "spki", format: "pem" },
			privateKeyEncoding: { type: "pkcs8", format: "pem" },
		});

		const keyPath = path.join(tempDir, "private_key.pem");
		await fs.writeFile(keyPath, privateKey, "utf8");

		// Sign manifest using private key path
		const { signature, authType } = signManifest(manifestWithoutSig, {
			keyPath,
		});
		expect(authType).toBe("rsa-sha256");
		expect(signature).toBeDefined();

		// Verify signature matches manual signing
		const data = JSON.stringify(manifestWithoutSig);
		const sign = crypto.createSign("SHA256");
		sign.update(data);
		sign.end();
		const expectedSig = sign.sign(privateKey, "hex");
		expect(signature).toBe(expectedSig);
	});

	describe("Registry Anchorage Integration Verification (Mocked API)", () => {
		it("should verify successfully when package is anchored in the registry", async () => {
			// Initialize local chain log
			const initialChainData = "packages:\n  lodash: 4.17.21";
			const chainMeta = await initChain(tempLog, initialChainData);

			// Mock registry response to have a matching anchored block hash
			mockHistoryResponse = {
				success: true,
				history: [
					{
						blockIndex: 0,
						metaHash: chainMeta.meta_hash,
					},
				],
			};

			const secret = "verification-secret";
			const { tarballPath } = await packWorkspace(
				tempDir,
				tempTarball,
				tempLog,
				{
					secret,
					serverUrl: "http://mock-registry.local",
					targetRepo: "mockowner/mockrepo",
				},
			);

			// Verify the tarball (succeeds registry cross-referencing check)
			const verifyReport = await verifyPack(tarballPath, {
				secret,
				serverUrl: "http://mock-registry.local",
				targetRepo: "mockowner/mockrepo",
			});

			expect(verifyReport.valid).toBe(true);
			expect(verifyReport.manifest).toBeDefined();
			expect(verifyReport.manifest?.registryStatus.isAnchored).toBe(true);
			expect(verifyReport.manifest?.registryStatus.syncStatus).toBe("synced");
		});

		it("should fail validation when there is a registry ledger divergence", async () => {
			// Initialize local chain log
			const initialChainData = "packages:\n  lodash: 4.17.21";
			const chainMeta = await initChain(tempLog, initialChainData);

			// Mock registry response to match for packing
			mockHistoryResponse = {
				success: true,
				history: [
					{
						blockIndex: 0,
						metaHash: chainMeta.meta_hash,
					},
				],
			};

			const secret = "verification-secret";
			const { tarballPath } = await packWorkspace(
				tempDir,
				tempTarball,
				tempLog,
				{
					secret,
					serverUrl: "http://mock-registry.local",
					targetRepo: "mockowner/mockrepo",
				},
			);

			// Change mock registry to return a mismatching/divergent hash for verification
			mockHistoryResponse = {
				success: true,
				history: [
					{
						blockIndex: 0,
						metaHash: "divergent-anchored-hash-67890",
					},
				],
			};

			// Verify the tarball
			const verifyReport = await verifyPack(tarballPath, {
				secret,
				serverUrl: "http://mock-registry.local",
				targetRepo: "mockowner/mockrepo",
			});

			expect(verifyReport.valid).toBe(false);
			expect(verifyReport.reason).toContain("Registry ledger divergence!");
		});

		it("should fail validation when registry response connection fails", async () => {
			// Initialize local chain log
			const initialChainData = "packages:\n  lodash: 4.17.21";
			const chainMeta = await initChain(tempLog, initialChainData);

			// Mock registry response to match for packing
			mockHistoryResponse = {
				success: true,
				history: [
					{
						blockIndex: 0,
						metaHash: chainMeta.meta_hash,
					},
				],
			};

			const secret = "verification-secret";
			const { tarballPath } = await packWorkspace(
				tempDir,
				tempTarball,
				tempLog,
				{
					secret,
					serverUrl: "http://mock-registry.local",
					targetRepo: "mockowner/mockrepo",
				},
			);

			// Change mock fetch status to 500 Internal Server Error for verification
			mockFetchStatus = 500;

			// Verify the tarball
			const verifyReport = await verifyPack(tarballPath, {
				secret,
				serverUrl: "http://mock-registry.local",
				targetRepo: "mockowner/mockrepo",
			});

			expect(verifyReport.valid).toBe(false);
			expect(verifyReport.reason).toContain(
				"Failed to connect to registry server",
			);
		});
	});
});
