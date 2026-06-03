import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { execSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { verifyChain } from "../src/chain.js";

describe("Git History Replay Ingestion Tests", () => {
	const tempDir = path.resolve(__dirname, "../temp-git-test");

	beforeAll(async () => {
		// Clean up and create temp directory
		rmSync(tempDir, { recursive: true, force: true });
		await fs.mkdir(tempDir, { recursive: true });

		// Initialize Git repository
		execSync("git init", { cwd: tempDir });
		execSync("git config user.name 'Test Bot'", { cwd: tempDir });
		execSync("git config user.email 'bot@test.com'", { cwd: tempDir });

		// Commit 1: Initial bun.lock
		const lockContent1 = JSON.stringify({
			lockfileVersion: 1,
			packages: {
				lodash: ["lodash@4.17.21", "", {}, "sha-123"],
			},
		});
		await fs.writeFile(path.join(tempDir, "bun.lock"), lockContent1, "utf8");
		execSync("git add bun.lock", { cwd: tempDir });
		execSync("git commit -m 'Commit 1: Add lodash'", {
			cwd: tempDir,
			env: {
				...process.env,
				GIT_AUTHOR_DATE: "2026-01-01T12:00:00Z",
				GIT_COMMITTER_DATE: "2026-01-01T12:00:00Z",
			},
		});

		// Commit 2: Update bun.lock (add zod)
		const lockContent2 = JSON.stringify({
			lockfileVersion: 1,
			packages: {
				lodash: ["lodash@4.17.21", "", {}, "sha-123"],
				zod: ["zod@3.22.4", "", {}, "sha-456"],
			},
		});
		await fs.writeFile(path.join(tempDir, "bun.lock"), lockContent2, "utf8");
		execSync("git add bun.lock", { cwd: tempDir });
		execSync("git commit -m 'Commit 2: Add zod'", {
			cwd: tempDir,
			env: {
				...process.env,
				GIT_AUTHOR_DATE: "2026-01-02T12:00:00Z",
				GIT_COMMITTER_DATE: "2026-01-02T12:00:00Z",
			},
		});

		// Commit 3: formatting change in bun.lock (no package change)
		const lockContent3 = JSON.stringify(
			{
				lockfileVersion: 1,
				packages: {
					lodash: ["lodash@4.17.21", "", {}, "sha-123"],
					zod: ["zod@3.22.4", "", {}, "sha-456"],
				},
			},
			null,
			2,
		); // formatted differently
		await fs.writeFile(path.join(tempDir, "bun.lock"), lockContent3, "utf8");
		execSync("git add bun.lock", { cwd: tempDir });
		execSync("git commit -m 'Commit 3: formatting update'", {
			cwd: tempDir,
			env: {
				...process.env,
				GIT_AUTHOR_DATE: "2026-01-03T12:00:00Z",
				GIT_COMMITTER_DATE: "2026-01-03T12:00:00Z",
			},
		});
	});

	afterAll(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("should initialize a chain by replaying git history, skipping commits with no package changes", async () => {
		const chainPath = path.join(tempDir, "packablock.yaml");
		const cliPath = path.resolve(__dirname, "../index.ts");

		// Run pblk init with --git-history option
		execSync(`bun run ${cliPath} init packablock.yaml --git-history bun.lock`, {
			cwd: tempDir,
		});

		// Verify chain exists
		const chainExists = existsSync(chainPath);
		expect(chainExists).toBe(true);

		// Verify chain contents
		const chainContent = await fs.readFile(chainPath, "utf8");
		const verification = await verifyChain(chainPath);

		// Assertions on integrity
		expect(verification.valid).toBe(true);

		// Verify number of blocks:
		// We expect 2 blocks: Commit 1 (Genesis) and Commit 2 (Append).
		// Commit 3 should be skipped because there were no package changes.
		const docs = chainContent
			.split("---")
			.map((d) => d.trim())
			.filter((d) => d.length > 0);
		// Each block consists of 1 data doc and 1 meta doc. 2 blocks = 4 documents.
		expect(docs.length).toBe(4);

		// Parse blocks to assert metadata and data payload
		const block0Data = YAML.parse(docs[0] ?? "");
		const block0Meta = YAML.parse(docs[1] ?? "")["$yaml-chain-meta"];
		const block1Data = YAML.parse(docs[2] ?? "");
		const block1Meta = YAML.parse(docs[3] ?? "")["$yaml-chain-meta"];

		// Assert Block 0 (Commit 1)
		expect(block0Data["bun.lock"].packages).toEqual([{ lodash: "4.17.21" }]);
		expect(block0Meta.block_index).toBe(0);
		expect(block0Meta.timestamp).toBe("2026-01-01T12:00:00+00:00");

		// Assert Block 1 (Commit 2)
		expect(block1Data["bun.lock"].packages).toBeDefined();
		expect(block1Data["bun.lock"].packages[0].zod).toBeDefined();
		expect(block1Data["bun.lock"].packages[0].zod[0].new).toBe("3.22.4");
		expect(block1Data["bun.lock"].packages[0].zod[1].loc).toMatch(/^1,\d+$/);
		expect(block1Meta.block_index).toBe(1);
		expect(block1Meta.timestamp).toBe("2026-01-02T12:00:00+00:00");
	});
});
