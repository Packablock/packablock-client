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

	it("should support introducing a new lockfile to an existing chain as an init event", async () => {
		// 1. Initialize with bun.lock only
		const genesisData = YAML.stringify({
			"bun.lock": {
				packages: [{ lodash: "4.17.21" }],
			},
		});
		await initChain(tempChainPath, genesisData);

		// 2. Simulate appending a new lockfile package-lock.json
		const introduceData = YAML.stringify({
			"package-lock.json": {
				chain_event: "init",
				packages: [{ lodash: "4.17.22" }, { zod: "3.22.4" }],
			},
		});
		await appendBlock(tempChainPath, introduceData);

		// Verify that package-lock.json is correctly initialized in the chain
		const latestNpm = await getLatestPackagesForFile(
			tempChainPath,
			"package-lock.json",
		);
		expect(latestNpm).toEqual({
			lodash: "4.17.22",
			zod: "3.22.4",
		});

		// Verify bun.lock remains correct
		const latestBun = await getLatestPackagesForFile(tempChainPath, "bun.lock");
		expect(latestBun).toEqual({
			lodash: "4.17.21",
		});

		// 3. Append diff to the newly introduced package-lock.json
		const appendData = YAML.stringify({
			"package-lock.json": {
				packages: [
					{
						zod: [{ old: "3.22.4" }, { new: "3.23.0" }, { loc: "20,10" }],
					},
				],
			},
		});
		await appendBlock(tempChainPath, appendData);

		// Verify update has applied to package-lock.json
		const latestNpm2 = await getLatestPackagesForFile(
			tempChainPath,
			"package-lock.json",
		);
		expect(latestNpm2).toEqual({
			lodash: "4.17.22",
			zod: "3.23.0",
		});
	});
});
