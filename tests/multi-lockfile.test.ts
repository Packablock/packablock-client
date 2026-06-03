import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import {
	initChain,
	appendBlock,
	verifyChain,
	getChainStatus,
	getLatestPackagesForFile,
	rolloverChain,
} from "../src/chain.js";

describe("Multi-Lockfile Parallel Chain Tracking", () => {
	const tempChainPath = path.resolve(__dirname, "temp-multi-chain.yaml");

	afterEach(async () => {
		try {
			await fs.unlink(tempChainPath);
		} catch {
			// Ignore if file doesn't exist
		}
	});

	it("should initialize, track, and roll over multiple lockfiles in the same chain", async () => {
		// 1. Initial Genesis block with two lockfiles: bun.lock and package-lock.json
		const genesisData = YAML.stringify({
			"bun.lock": {
				packages: [{ lodash: "4.17.21" }, { typescript: "4.6.3" }],
			},
			"package-lock.json": {
				packages: [{ lodash: "4.17.21" }, { eslint: "8.0.0" }],
			},
		});

		const genesisMeta = await initChain(tempChainPath, genesisData);
		expect(genesisMeta.block_index).toBe(0);

		// Verify we can get correct latest packages for each lockfile individually
		const latestBun0 = await getLatestPackagesForFile(
			tempChainPath,
			"bun.lock",
		);
		expect(latestBun0).toEqual({
			lodash: "4.17.21",
			typescript: "4.6.3",
		});

		const latestNpm0 = await getLatestPackagesForFile(
			tempChainPath,
			"package-lock.json",
		);
		expect(latestNpm0).toEqual({
			lodash: "4.17.21",
			eslint: "8.0.0",
		});

		// 2. Append changes to package-lock.json only (e.g. typescript added to npm, eslint updated)
		const appendData = YAML.stringify({
			"package-lock.json": {
				packages: [
					{
						typescript: [{ new: "4.9.4" }, { loc: "12,10" }],
					},
					{
						eslint: [{ old: "8.0.0" }, { new: "8.50.0" }, { loc: "15,10" }],
					},
				],
			},
		});

		const appendMeta = await appendBlock(tempChainPath, appendData);
		expect(appendMeta.block_index).toBe(1);

		// Verify state for package-lock.json has updated, but bun.lock remains identical
		const latestBun1 = await getLatestPackagesForFile(
			tempChainPath,
			"bun.lock",
		);
		expect(latestBun1).toEqual({
			lodash: "4.17.21",
			typescript: "4.6.3",
		});

		const latestNpm1 = await getLatestPackagesForFile(
			tempChainPath,
			"package-lock.json",
		);
		expect(latestNpm1).toEqual({
			lodash: "4.17.21",
			eslint: "8.50.0",
			typescript: "4.9.4",
		});

		// 3. Roll over the multi-lockfile chain
		const { backupPath, prevMetaHash, newGenesisHash } =
			await rolloverChain(tempChainPath);
		expect(newGenesisHash).toBeDefined();

		// Check the active log's rollover genesis block packages state
		const latestBunRollover = await getLatestPackagesForFile(
			tempChainPath,
			"bun.lock",
		);
		expect(latestBunRollover).toEqual({
			lodash: "4.17.21",
			typescript: "4.6.3",
		});

		const latestNpmRollover = await getLatestPackagesForFile(
			tempChainPath,
			"package-lock.json",
		);
		expect(latestNpmRollover).toEqual({
			lodash: "4.17.21",
			eslint: "8.50.0",
			typescript: "4.9.4",
		});

		// Check structural validity
		const report = await verifyChain(tempChainPath);
		expect(report.valid).toBe(true);

		// Clean up the backup file as well
		try {
			await fs.unlink(backupPath);
		} catch {}
	});

	it("should throw an error when attempting to append packages for an untracked lockfile", async () => {
		// 1. Initialize with bun.lock only
		const genesisData = YAML.stringify({
			"bun.lock": {
				packages: [{ lodash: "4.17.21" }],
			},
		});
		await initChain(tempChainPath, genesisData);

		// 2. Expect an error when appending an untracked lockfile via CLI
		const { execSync } = require("node:child_process");
		try {
			execSync(
				`bun run ${path.resolve(__dirname, "../index.ts")} append ${tempChainPath} -l package-lock.json`,
				{ stdio: "pipe" },
			);
			expect(true).toBe(false); // should not reach here
		} catch (err: any) {
			expect(err.message).toContain("is not tracked in this chain");
		}
	});

	it("should introduce a new lockfile to an existing chain when using the init command", async () => {
		// 1. Initialize with bun.lock only
		const genesisData = YAML.stringify({
			"bun.lock": {
				packages: [{ lodash: "4.17.21" }],
			},
		});
		await initChain(tempChainPath, genesisData);

		// 2. Mock a lockfile file to read
		const mockLockfilePath = path.join(__dirname, "mock-package-lock.json");
		await fs.writeFile(
			mockLockfilePath,
			JSON.stringify({
				lockfileVersion: 3,
				packages: {
					"": {
						dependencies: {
							lodash: "^4.17.22",
							zod: "^3.22.4",
						},
					},
					"node_modules/lodash": { version: "4.17.22" },
					"node_modules/zod": { version: "3.22.4" },
				},
			}),
			"utf8",
		);

		try {
			// 3. Run init command with the new lockfile on the existing chain
			const { execSync } = require("node:child_process");
			execSync(
				`bun run ${path.resolve(__dirname, "../index.ts")} init ${tempChainPath} -l ${mockLockfilePath}`,
				{ stdio: "pipe" },
			);

			// 4. Verify that the new lockfile is now tracked in the chain with packages
			const latestNpm = await getLatestPackagesForFile(
				tempChainPath,
				"mock-package-lock.json",
			);
			expect(latestNpm).toEqual({
				lodash: "4.17.22",
				zod: "3.22.4",
			});

			// Verify bun.lock packages remain unaffected
			const latestBun = await getLatestPackagesForFile(
				tempChainPath,
				"bun.lock",
			);
			expect(latestBun).toEqual({
				lodash: "4.17.21",
			});

			// 5. Modify the mock lockfile and append
			await fs.writeFile(
				mockLockfilePath,
				JSON.stringify({
					lockfileVersion: 3,
					packages: {
						"": {
							dependencies: {
								lodash: "^4.17.22",
								zod: "^3.23.0",
							},
						},
						"node_modules/lodash": { version: "4.17.22" },
						"node_modules/zod": { version: "3.23.0" },
					},
				}),
				"utf8",
			);

			execSync(
				`bun run ${path.resolve(__dirname, "../index.ts")} append ${tempChainPath} -l ${mockLockfilePath}`,
				{ stdio: "pipe" },
			);

			const newStatus = await getChainStatus(tempChainPath);
			expect(newStatus.blockCount).toBe(3); // Genesis, Init mock-package-lock.json, Append zod update

			const latestNpmAfterAppend = await getLatestPackagesForFile(
				tempChainPath,
				"mock-package-lock.json",
			);
			expect(latestNpmAfterAppend.zod).toBe("3.23.0");
		} finally {
			try {
				await fs.unlink(mockLockfilePath);
			} catch {}
		}
	});

	it("should throw an error when using init on an already tracked lockfile", async () => {
		// 1. Initialize with bun.lock only
		const genesisData = YAML.stringify({
			"bun.lock": {
				packages: [{ lodash: "4.17.21" }],
			},
		});
		await initChain(tempChainPath, genesisData);

		// 2. Expect error when running init with bun.lock again on the existing chain
		const { execSync } = require("node:child_process");
		try {
			execSync(
				`bun run ${path.resolve(__dirname, "../index.ts")} init ${tempChainPath} -l bun.lock`,
				{ stdio: "pipe" },
			);
			expect(true).toBe(false); // should not reach here
		} catch (err: any) {
			expect(err.message).toContain("is already tracked in this chain");
			expect(err.message).toContain("initialized in Block 0");
		}
	});
});
