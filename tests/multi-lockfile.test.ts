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

	it("should support the full initialize -> append -> forget -> append error -> re-initialize lifecycle", async () => {
		const { execSync } = require("node:child_process");
		const {
			hasLockfileInChain,
			getLatestPackages,
			splitRawDocuments,
		} = require("../src/chain.ts");

		// 1. Initialize with bun.lock and package-lock.json
		const genesisData = YAML.stringify({
			"bun.lock": {
				packages: [{ lodash: "4.17.21" }],
			},
			"package-lock.json": {
				packages: [{ typescript: "4.9.4" }],
			},
		});
		await initChain(tempChainPath, genesisData);

		expect(await hasLockfileInChain(tempChainPath, "bun.lock")).toBe(true);
		expect(await hasLockfileInChain(tempChainPath, "package-lock.json")).toBe(
			true,
		);

		// 2. Run forget command via CLI
		execSync(
			`bun run ${path.resolve(__dirname, "../index.ts")} forget ${tempChainPath} -l package-lock.json`,
			{ stdio: "pipe" },
		);

		// 3. Verify tracking is removed and packages are omitted from active package state
		expect(await hasLockfileInChain(tempChainPath, "bun.lock")).toBe(true);
		expect(await hasLockfileInChain(tempChainPath, "package-lock.json")).toBe(
			false,
		);

		const activePkgs = await getLatestPackages(tempChainPath);
		expect(activePkgs).toEqual({ lodash: "4.17.21" }); // typescript is omitted because package-lock.json is forgotten

		// 4. Expect error when trying to forget package-lock.json again
		try {
			execSync(
				`bun run ${path.resolve(__dirname, "../index.ts")} forget ${tempChainPath} -l package-lock.json`,
				{ stdio: "pipe" },
			);
			expect(true).toBe(false);
		} catch (err: any) {
			expect(err.message).toContain("is not tracked in this chain");
		}

		// 5. Test append on a forgotten lockfile: should warn and accept the append, and then the lockfile is tracked again
		const mockLockfilePath = path.join(__dirname, "package-lock.json");
		await fs.writeFile(
			mockLockfilePath,
			JSON.stringify({
				lockfileVersion: 3,
				packages: {
					"": { dependencies: { typescript: "^4.9.5" } },
					"node_modules/typescript": { version: "4.9.5" },
				},
			}),
			"utf8",
		);

		try {
			// Runs append and checks it succeeds (accepts append) and warns about forget event block (Block 1)
			const appendResult = execSync(
				`bun run ${path.resolve(__dirname, "../index.ts")} append ${tempChainPath} -l ${mockLockfilePath} 2>&1`,
				{ stdio: "pipe", encoding: "utf8" },
			);
			expect(appendResult).toContain("was forgotten in Block 1");
			expect(await hasLockfileInChain(tempChainPath, "package-lock.json")).toBe(
				true,
			);

			// 6. Forget package-lock.json again so we can test rollover omission and re-init warning
			execSync(
				`bun run ${path.resolve(__dirname, "../index.ts")} forget ${tempChainPath} -l package-lock.json`,
				{ stdio: "pipe" },
			);
			expect(await hasLockfileInChain(tempChainPath, "package-lock.json")).toBe(
				false,
			);

			// 7. Roll over the chain, checking that package-lock.json is omitted from the rollover genesis block
			const { backupPath } = await rolloverChain(tempChainPath);
			try {
				const rolloverContent = await fs.readFile(tempChainPath, "utf8");
				const docs = splitRawDocuments(rolloverContent);
				const firstDoc = docs[0];
				const rolloverParsed = YAML.parse(
					firstDoc.replace(/^(\s*)(@[^:]+):/gm, '$1"$2":'),
				);
				expect(rolloverParsed["bun.lock"]).toBeDefined();
				expect(rolloverParsed["package-lock.json"]).toBeUndefined();
			} finally {
				try {
					await fs.unlink(backupPath);
				} catch {}
			}

			// We need a forget event in the active chain to test the init warning on a forgotten file.
			// Let's forget bun.lock in the new chain! (Block 0 is rollover genesis).
			// Block 1 will be forget bun.lock.
			execSync(
				`bun run ${path.resolve(__dirname, "../index.ts")} forget ${tempChainPath} -l bun.lock`,
				{ stdio: "pipe" },
			);
			expect(await hasLockfileInChain(tempChainPath, "bun.lock")).toBe(false);

			// 8. Test init again with bun.lock (which has been forgotten in Block 1 of the new chain)
			// It should accept the init, warn that it was forgotten in Block 1, and resume tracking it.
			const mockBunPath = path.join(__dirname, "bun.lock");
			await fs.writeFile(
				mockBunPath,
				JSON.stringify({
					lockfileVersion: 3,
					packages: {
						"": { dependencies: { lodash: "^4.17.21" } },
						"node_modules/lodash": { version: "4.17.21" },
					},
				}),
				"utf8",
			);
			try {
				const initResult = execSync(
					`bun run ${path.resolve(__dirname, "../index.ts")} init ${tempChainPath} -l ${mockBunPath} 2>&1`,
					{ stdio: "pipe", encoding: "utf8" },
				);
				expect(initResult).toContain("was forgotten in Block 1");
				expect(await hasLockfileInChain(tempChainPath, "bun.lock")).toBe(true);
			} finally {
				try {
					await fs.unlink(mockBunPath);
				} catch {}
			}
		} finally {
			try {
				await fs.unlink(mockLockfilePath);
			} catch {}
		}
	});

	it("should enforce strict mode and throw error on append or init to a forgotten file", async () => {
		const { execSync } = require("node:child_process");

		// Initialize with bun.lock
		const genesisData = YAML.stringify({
			"bun.lock": {
				packages: [{ lodash: "4.17.21" }],
			},
		});
		await initChain(tempChainPath, genesisData);

		// Forget bun.lock
		execSync(
			`bun run ${path.resolve(__dirname, "../index.ts")} forget ${tempChainPath} -l bun.lock`,
			{ stdio: "pipe" },
		);

		// 1. Try to append with --strict CLI flag
		const mockLockfilePath = path.join(__dirname, "bun.lock");
		await fs.writeFile(
			mockLockfilePath,
			JSON.stringify({
				lockfileVersion: 3,
				packages: {
					"": { dependencies: { lodash: "^4.17.22" } },
					"node_modules/lodash": { version: "4.17.22" },
				},
			}),
			"utf8",
		);

		try {
			try {
				execSync(
					`bun run ${path.resolve(__dirname, "../index.ts")} append ${tempChainPath} -l ${mockLockfilePath} --strict`,
					{ stdio: "pipe" },
				);
				expect(true).toBe(false);
			} catch (err: any) {
				expect(err.message).toContain(
					"cannot be appended to under strict mode",
				);
			}

			// 2. Try to append with PACKABLOCK_STRICT env var
			try {
				execSync(
					`bun run ${path.resolve(__dirname, "../index.ts")} append ${tempChainPath} -l ${mockLockfilePath}`,
					{ stdio: "pipe", env: { ...process.env, PACKABLOCK_STRICT: "true" } },
				);
				expect(true).toBe(false);
			} catch (err: any) {
				expect(err.message).toContain(
					"cannot be appended to under strict mode",
				);
			}

			// 3. Try to init with --strict CLI flag
			try {
				execSync(
					`bun run ${path.resolve(__dirname, "../index.ts")} init ${tempChainPath} -l ${mockLockfilePath} --strict`,
					{ stdio: "pipe" },
				);
				expect(true).toBe(false);
			} catch (err: any) {
				expect(err.message).toContain(
					"cannot be re-initialized under strict mode",
				);
			}
		} finally {
			try {
				await fs.unlink(mockLockfilePath);
			} catch {}
		}
	});

	it("should enforce never-forget mode and disallow forget command or actions on chains with forget events", async () => {
		const { execSync } = require("node:child_process");

		// Initialize with bun.lock
		const genesisData = YAML.stringify({
			"bun.lock": {
				packages: [{ lodash: "4.17.21" }],
			},
		});
		await initChain(tempChainPath, genesisData);

		// 1. Trying to run forget command with --never-forget CLI flag should fail
		try {
			execSync(
				`bun run ${path.resolve(__dirname, "../index.ts")} forget ${tempChainPath} -l bun.lock --never-forget`,
				{ stdio: "pipe" },
			);
			expect(true).toBe(false);
		} catch (err: any) {
			expect(err.message).toContain(
				"Forget command is disallowed under --never-forget",
			);
		}

		// 2. Trying to run forget command with PACKABLOCK_NEVER_FORGET env var should fail
		try {
			execSync(
				`bun run ${path.resolve(__dirname, "../index.ts")} forget ${tempChainPath} -l bun.lock`,
				{
					stdio: "pipe",
					env: { ...process.env, PACKABLOCK_NEVER_FORGET: "true" },
				},
			);
			expect(true).toBe(false);
		} catch (err: any) {
			expect(err.message).toContain(
				"Forget command is disallowed under --never-forget",
			);
		}

		// 3. Create a forget event in the chain (by running standard forget without never-forget flags)
		execSync(
			`bun run ${path.resolve(__dirname, "../index.ts")} forget ${tempChainPath} -l bun.lock`,
			{ stdio: "pipe" },
		);

		// 4. Any subsequent command (e.g. status) on this chain under --never-forget should fail
		try {
			execSync(
				`bun run ${path.resolve(__dirname, "../index.ts")} status ${tempChainPath} --never-forget`,
				{ stdio: "pipe" },
			);
			expect(true).toBe(false);
		} catch (err: any) {
			expect(err.message).toContain("Strict policy violation");
			expect(err.message).toContain("contains forget events");
		}

		// 5. Any subsequent command (e.g. status) on this chain under PACKABLOCK_NEVER_FORGET env var should fail
		try {
			execSync(
				`bun run ${path.resolve(__dirname, "../index.ts")} status ${tempChainPath}`,
				{
					stdio: "pipe",
					env: { ...process.env, PACKABLOCK_NEVER_FORGET: "true" },
				},
			);
			expect(true).toBe(false);
		} catch (err: any) {
			expect(err.message).toContain("Strict policy violation");
			expect(err.message).toContain("contains forget events");
		}
	});
});
