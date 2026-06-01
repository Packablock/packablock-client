import { afterEach, describe, expect, it } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import {
	appendBlock,
	getChainStatus,
	initChain,
	splitRawDocuments,
	verifyChain,
} from "../src/chain.js";

describe("Cryptographic Chain Tests", () => {
	const tempChainPath = path.resolve(__dirname, "temp-chain.yaml");

	afterEach(async () => {
		try {
			await fs.unlink(tempChainPath);
		} catch {
			// Ignore if file doesn't exist
		}
	});

	it("should initialize a blockchain file correctly", async () => {
		const initialData =
			"packages:\n  lodash: 4.17.21\nsource: package-lock.json";
		const meta = await initChain(tempChainPath, initialData);

		expect(meta.block_index).toBe(0);
		expect(meta.hashing_strategy).toBe("raw");
		expect(meta.prev_meta_hash).toBe(
			"0000000000000000000000000000000000000000000000000000000000000000",
		);
		expect(meta.meta_hash).toBeDefined();

		const fileContent = await fs.readFile(tempChainPath, "utf8");
		const docs = splitRawDocuments(fileContent);
		expect(docs.length).toBe(2);
		const firstDoc = docs[0];
		expect(firstDoc).toBeDefined();
		expect(firstDoc?.trim()).toBe(initialData);

		const report = await verifyChain(tempChainPath);
		expect(report.valid).toBe(true);

		const status = await getChainStatus(tempChainPath);
		expect(status.blockCount).toBe(1);
		expect(status.isHealthy).toBe(true);
		expect(status.lastBlock?.block_index).toBe(0);
	});

	it("should append blocks correctly and maintain chain validity", async () => {
		const block0Data = "packages:\n  lodash: 4.17.21";
		await initChain(tempChainPath, block0Data);

		const block1Data = "packages:\n  lodash: 4.17.22\n  zod: 3.22.4";
		const meta1 = await appendBlock(tempChainPath, block1Data);

		expect(meta1.block_index).toBe(1);
		expect(meta1.prev_meta_hash).toBeDefined();

		const status = await getChainStatus(tempChainPath);
		expect(status.blockCount).toBe(2);
		expect(status.isHealthy).toBe(true);
		expect(status.lastBlock?.block_index).toBe(1);

		const report = await verifyChain(tempChainPath);
		expect(report.valid).toBe(true);
	});

	describe("Tampering Detection", () => {
		it("should detect data tampering", async () => {
			await initChain(tempChainPath, "packages:\n  lodash: 4.17.21");
			await appendBlock(tempChainPath, "packages:\n  lodash: 4.17.22");

			// Tamper with data of the first block in the file
			let content = await fs.readFile(tempChainPath, "utf8");
			content = content.replace("lodash: 4.17.21", "lodash: 4.17.99");
			await fs.writeFile(tempChainPath, content, "utf8");

			const report = await verifyChain(tempChainPath);
			expect(report.valid).toBe(false);
			expect(report.tamperedComponent).toBe("data");
			expect(report.blockIndex).toBe(0);
		});

		it("should detect metadata signature tampering", async () => {
			await initChain(tempChainPath, "packages:\n  lodash: 4.17.21");

			// Tamper with meta_hash in metadata
			let content = await fs.readFile(tempChainPath, "utf8");
			content = content.replace(
				/meta_hash: [0-9a-fA-F]+/,
				"meta_hash: 1111222233334444555566667777888899990000aaaabbbbccccddddeeeeffff",
			);
			await fs.writeFile(tempChainPath, content, "utf8");

			const report = await verifyChain(tempChainPath);
			expect(report.valid).toBe(false);
			expect(report.tamperedComponent).toBe("meta");
			expect(report.blockIndex).toBe(0);
		});

		it("should detect chain link broken", async () => {
			await initChain(tempChainPath, "packages:\n  lodash: 4.17.21");
			await appendBlock(tempChainPath, "packages:\n  lodash: 4.17.22");

			// Tamper with prev_meta_hash of block 1 using YAML parser to avoid regex wrapping/indentation issues
			const content = await fs.readFile(tempChainPath, "utf8");
			const docs = splitRawDocuments(content);
			const doc3 = docs[3];
			expect(doc3).toBeDefined();
			const parsed = YAML.parse(doc3 || "");
			parsed["$yaml-chain-meta"].prev_meta_hash =
				"0000000000000000000000000000000000000000000000000000000000000000";
			docs[3] = `${YAML.stringify(parsed).trim()}\n`;
			await fs.writeFile(tempChainPath, docs.join("\n---\n"), "utf8");

			const report = await verifyChain(tempChainPath);
			expect(report.valid).toBe(false);
			expect(report.tamperedComponent).toBe("chain");
			expect(report.blockIndex).toBe(1);
		});

		it("should detect index mismatch", async () => {
			await initChain(tempChainPath, "packages:\n  lodash: 4.17.21");
			await appendBlock(tempChainPath, "packages:\n  lodash: 4.17.22");

			// Tamper with block_index of block 1 using YAML parser
			const content = await fs.readFile(tempChainPath, "utf8");
			const docs = splitRawDocuments(content);
			const doc3 = docs[3];
			expect(doc3).toBeDefined();
			const parsed = YAML.parse(doc3 || "");
			parsed["$yaml-chain-meta"].block_index = 99;
			docs[3] = `${YAML.stringify(parsed).trim()}\n`;
			await fs.writeFile(tempChainPath, docs.join("\n---\n"), "utf8");

			const report = await verifyChain(tempChainPath);
			expect(report.valid).toBe(false);
			expect(report.tamperedComponent).toBe("index");
			expect(report.blockIndex).toBe(1);
		});
	});
});
