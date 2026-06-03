import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import {
	initChain,
	appendBlock,
	verifyChain,
	getChainStatus,
} from "../src/chain.js";
import { rolloverChain } from "../src/chain.js";

describe("Client Log Rollover Cryptographic Validation", () => {
	const tempDir = path.resolve(__dirname, "temp-rollover-workspace");
	const tempLog = path.join(tempDir, "packablock.yaml");

	beforeEach(async () => {
		await fs.mkdir(tempDir, { recursive: true });
	});

	afterEach(async () => {
		try {
			await fs.rm(tempDir, { recursive: true, force: true });
		} catch (e) {}
	});

	it("should successfully roll over a healthy chain and link the new genesis block to the backup's latest hash", async () => {
		// 1. Initialize a healthy chain with a couple of blocks
		const genesisMeta = await initChain(tempLog, 'message: "Genesis"');
		const block1Meta = await appendBlock(
			tempLog,
			"packages:\n  lodash: 4.17.21",
		);

		const oldStatus = await getChainStatus(tempLog);
		expect(oldStatus.blockCount).toBe(2);
		expect(oldStatus.lastBlock?.meta_hash).toBe(block1Meta.meta_hash!);

		// 2. Perform the local rollover
		const { backupPath, prevMetaHash, newGenesisHash } =
			await rolloverChain(tempLog);

		expect(backupPath).toBe(`${tempLog}.${block1Meta.meta_hash!}.bak`);
		expect(prevMetaHash).toBe(block1Meta.meta_hash!);
		expect(newGenesisHash).toBeDefined();

		// 3. Assert that the legacy backup file exists and remains perfectly valid
		expect(fsSync.existsSync(backupPath)).toBe(true);
		const backupReport = await verifyChain(backupPath);
		expect(backupReport.valid).toBe(true);
		const backupStatus = await getChainStatus(backupPath);
		expect(backupStatus.blockCount).toBe(2);
		expect(backupStatus.lastBlock?.meta_hash).toBe(block1Meta.meta_hash!);

		// 4. Assert that the new active log file exists, starts at block 0, and has index 0
		expect(fsSync.existsSync(tempLog)).toBe(true);
		const newStatus = await getChainStatus(tempLog);
		expect(newStatus.blockCount).toBe(1);
		expect(newStatus.lastBlock?.block_index).toBe(0);
		expect(newStatus.lastBlock?.prev_meta_hash).toBe(block1Meta.meta_hash!);
		expect(newStatus.lastBlock?.meta_hash).toBe(newGenesisHash);

		// 5. Verify the new rollover chain itself is verified as structurally and cryptographically valid!
		const newReport = await verifyChain(tempLog);
		expect(newReport.valid).toBe(true);
		const newReportStatus = await getChainStatus(tempLog);
		expect(newReportStatus.blockCount).toBe(1);
		expect(newReportStatus.lastBlock?.meta_hash).toBe(newGenesisHash);
	});

	it("should immediately throw an error when attempting to roll over a non-existent file", async () => {
		expect(rolloverChain(path.join(tempDir, "missing.yaml"))).rejects.toThrow();
	});

	it("should immediately throw an error when attempting to roll over a tampered chain", async () => {
		// Initialize healthy chain
		await initChain(tempLog, 'message: "Genesis"');
		await appendBlock(tempLog, "packages:\n  lodash: 4.17.21");

		// Tamper the chain file
		let content = await fs.readFile(tempLog, "utf8");
		content = content.replace("lodash: 4.17.21", "lodash: 4.17.99");
		await fs.writeFile(tempLog, content, "utf8");

		// Rollover should fail
		expect(rolloverChain(tempLog)).rejects.toThrow(
			"Cannot roll over a tampered log",
		);
	});
});
