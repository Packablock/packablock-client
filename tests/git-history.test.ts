import {
	afterAll,
	beforeAll,
	describe,
	expect,
	it,
	beforeEach,
	afterEach,
} from "bun:test";
import { execSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import {
	verifyChain,
	initChain,
	findLockfileForgetBlock,
	appendBlock,
} from "../src/chain.js";

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

		// Run pkablk init with --git-history option
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
		expect(block0Data.lockfiles["bun.lock"].packages).toEqual([
			{ lodash: "4.17.21" },
		]);
		expect(block0Meta.block_index).toBe(0);
		expect(new Date(block0Meta.timestamp).toISOString()).toBe(
			"2026-01-01T12:00:00.000Z",
		);

		// Assert Block 1 (Commit 2)
		expect(block1Data.lockfiles["bun.lock"].packages).toBeDefined();
		expect(block1Data.lockfiles["bun.lock"].packages[0].zod).toBeDefined();
		expect(block1Data.lockfiles["bun.lock"].packages[0].zod[0].new).toBe(
			"3.22.4",
		);
		expect(block1Data.lockfiles["bun.lock"].packages[0].zod[1].loc).toMatch(
			/^1,\d+$/,
		);
		expect(block1Meta.block_index).toBe(1);
		expect(new Date(block1Meta.timestamp).toISOString()).toBe(
			"2026-01-02T12:00:00.000Z",
		);
	});

	describe("Ingestion and Error Handling on Existing Chains", () => {
		const tempDir = path.resolve(__dirname, "../temp-git-test-replay");
		const chainPath = path.join(tempDir, "packablock.yaml");
		const cliPath = path.resolve(__dirname, "../index.ts");
		const fixturePath = path.resolve(
			__dirname,
			"../../packablock-demo/tests/fixtures/bun.lock.log",
		);

		interface CommitPatch {
			sha: string;
			authorName: string;
			authorEmail: string;
			date: string;
			message: string;
			patch: string;
		}

		function parseGitLogPatch(content: string): CommitPatch[] {
			const commits: CommitPatch[] = [];
			const rawCommits = content.split(/\n(?=commit [0-9a-f]{40})/);

			for (const raw of rawCommits) {
				const lines = raw.split("\n");
				const firstLine = lines[0];
				if (!firstLine || !firstLine.startsWith("commit ")) continue;

				const sha = firstLine.slice(7).trim();
				let authorName = "Test Bot";
				let authorEmail = "bot@test.com";
				let date = "";
				const messageLines: string[] = [];
				const patchLines: string[] = [];
				let inPatch = false;

				for (let i = 1; i < lines.length; i++) {
					const line = lines[i];
					if (line === undefined) continue;

					if (inPatch) {
						patchLines.push(line);
					} else if (line.startsWith("Author: ")) {
						const match = line.slice(8).match(/^(.*?) <(.*?)>$/);
						if (match && match[1] && match[2]) {
							authorName = match[1];
							authorEmail = match[2];
						}
					} else if (line.startsWith("Date: ")) {
						date = line.slice(5).trim();
					} else if (line.startsWith("diff --git ")) {
						inPatch = true;
						patchLines.push(line);
					} else {
						if (line.startsWith("    ")) {
							messageLines.push(line.slice(4));
						}
					}
				}

				commits.push({
					sha,
					authorName,
					authorEmail,
					date,
					message: messageLines.join("\n").trim(),
					patch: patchLines.join("\n"),
				});
			}

			return commits;
		}

		async function applyCommits(
			repoPath: string,
			commits: CommitPatch[],
			start: number,
			end: number,
		) {
			for (let i = start; i < end; i++) {
				const commit = commits[i];
				if (!commit) continue;

				const patchPath = path.join(repoPath, "temp.patch");
				await fs.writeFile(patchPath, commit.patch, "utf8");

				try {
					execSync("git apply temp.patch", { cwd: repoPath, stdio: "ignore" });
				} catch (err) {
					throw new Error(
						`Failed to apply patch for commit ${commit.sha}: ${err}`,
					);
				}

				await fs.unlink(patchPath);

				execSync("git add .", { cwd: repoPath });
				const cleanMsg = commit.message
					.replace(/"/g, '\\"')
					.replace(/`/g, "\\`")
					.replace(/\$/g, "\\$");
				execSync(`git commit -m "${cleanMsg}"`, {
					cwd: repoPath,
					env: {
						...process.env,
						GIT_AUTHOR_NAME: commit.authorName,
						GIT_AUTHOR_EMAIL: commit.authorEmail,
						GIT_AUTHOR_DATE: commit.date,
						GIT_COMMITTER_NAME: commit.authorName,
						GIT_COMMITTER_EMAIL: commit.authorEmail,
						GIT_COMMITTER_DATE: commit.date,
					},
				});
			}
		}

		beforeEach(async () => {
			rmSync(tempDir, { recursive: true, force: true });
			await fs.mkdir(tempDir, { recursive: true });

			execSync("git init", { cwd: tempDir });
			execSync("git config user.name 'Test Bot'", { cwd: tempDir });
			execSync("git config user.email 'bot@test.com'", { cwd: tempDir });
		});

		afterEach(() => {
			rmSync(tempDir, { recursive: true, force: true });
		});

		it("should replay git history onto an existing chain, appending new updates only", async () => {
			const logContent = await fs.readFile(fixturePath, "utf8");
			const commits = parseGitLogPatch(logContent);

			// 1. Rebuild history up to commit 5 and initialize the chain
			await applyCommits(tempDir, commits, 0, 5);
			execSync(
				`bun run ${cliPath} init packablock.yaml --git-history bun.lock`,
				{
					cwd: tempDir,
				},
			);

			const initialChainContent = await fs.readFile(chainPath, "utf8");
			const initialVerification = await verifyChain(chainPath);
			expect(initialVerification.valid).toBe(true);

			const initialDocs = initialChainContent
				.split("---")
				.map((d) => d.trim())
				.filter((d) => d.length > 0);

			// 2. Rebuild the rest of the commits in the repo
			await applyCommits(tempDir, commits, 5, commits.length);

			// 3. Run append with --git-history to replay the rest
			execSync(
				`bun run ${cliPath} append packablock.yaml --git-history bun.lock`,
				{
					cwd: tempDir,
				},
			);

			const finalChainContent = await fs.readFile(chainPath, "utf8");
			const finalVerification = await verifyChain(chainPath);
			expect(finalVerification.valid).toBe(true);

			const finalDocs = finalChainContent
				.split("---")
				.map((d) => d.trim())
				.filter((d) => d.length > 0);

			// The final chain should contain more blocks than the initial chain
			expect(finalDocs.length).toBeGreaterThan(initialDocs.length);
		});

		it("should error if the chain file does not exist", async () => {
			const nonExistentChain = path.join(tempDir, "non_existent.yaml");
			try {
				execSync(
					`bun run ${cliPath} append ${nonExistentChain} --git-history bun.lock`,
					{ cwd: tempDir, stdio: "pipe" },
				);
				expect(true).toBe(false);
			} catch (err: any) {
				expect(err.message).toContain("File not found");
			}
		});

		it("should error if the lockfile has not been initialized in the chain yet", async () => {
			// Initialize chain with a different lockfile name
			const genesisData = YAML.stringify({
				"package-lock.json": {
					packages: [{ lodash: "4.17.21" }],
				},
			});
			await initChain(chainPath, genesisData);

			// Rebuild some history for bun.lock in repo
			const logContent = await fs.readFile(fixturePath, "utf8");
			const commits = parseGitLogPatch(logContent);
			await applyCommits(tempDir, commits, 0, 2);

			// Try to append --git-history for bun.lock (which is not tracked)
			try {
				execSync(
					`bun run ${cliPath} append packablock.yaml --git-history bun.lock`,
					{ cwd: tempDir, stdio: "pipe" },
				);
				expect(true).toBe(false);
			} catch (err: any) {
				expect(err.message).toContain("is not tracked in this chain");
			}
		});

		it("should error if the lockfile has been forgotten and --never-forget is enabled", async () => {
			// Initialize chain with bun.lock
			const genesisData = YAML.stringify({
				"bun.lock": {
					packages: [{ lodash: "4.17.21" }],
				},
			});
			await initChain(chainPath, genesisData);

			// Rebuild some history for bun.lock in repo
			const logContent = await fs.readFile(fixturePath, "utf8");
			const commits = parseGitLogPatch(logContent);
			await applyCommits(tempDir, commits, 0, 2);

			// Forget bun.lock in the chain
			execSync(`bun run ${cliPath} forget packablock.yaml -l bun.lock`, {
				cwd: tempDir,
			});

			// Trying to replay/append bun.lock with --never-forget should error
			try {
				execSync(
					`bun run ${cliPath} append packablock.yaml --git-history bun.lock --never-forget`,
					{ cwd: tempDir, stdio: "pipe" },
				);
				expect(true).toBe(false);
			} catch (err: any) {
				expect(err.message).toContain("Strict policy violation");
				expect(err.message).toContain("contains forget events");
			}
		});

		it("should automatically forget a lockfile if it is deleted in the git history", async () => {
			const logContent = await fs.readFile(fixturePath, "utf8");
			const commits = parseGitLogPatch(logContent);

			// Rebuild all commits
			await applyCommits(tempDir, commits, 0, commits.length);

			// Add a commit that deletes bun.lock
			execSync("git rm bun.lock", { cwd: tempDir });
			execSync("git commit -m 'meta: delete bun.lock'", {
				cwd: tempDir,
				env: {
					...process.env,
					GIT_AUTHOR_NAME: "Test Bot",
					GIT_AUTHOR_EMAIL: "bot@test.com",
					GIT_AUTHOR_DATE: "2026-06-06T12:00:00Z",
					GIT_COMMITTER_NAME: "Test Bot",
					GIT_COMMITTER_EMAIL: "bot@test.com",
					GIT_COMMITTER_DATE: "2026-06-06T12:00:00Z",
				},
			});

			// Run init with --git-history option for bun.lock
			execSync(
				`bun run ${cliPath} init packablock.yaml --git-history bun.lock`,
				{
					cwd: tempDir,
				},
			);

			// Verify chain exists
			expect(existsSync(chainPath)).toBe(true);

			// Read and verify the chain
			const verification = await verifyChain(chainPath);
			expect(verification.valid).toBe(true);

			// Find the forget block
			const forgetBlockIndex = await findLockfileForgetBlock(
				chainPath,
				"bun.lock",
			);
			expect(forgetBlockIndex).not.toBeNull();
			expect(forgetBlockIndex).toBeGreaterThan(0);
		});

		it("should error if a lockfile is deleted in the git history and --never-forget is enabled", async () => {
			const logContent = await fs.readFile(fixturePath, "utf8");
			const commits = parseGitLogPatch(logContent);

			// Rebuild all commits
			await applyCommits(tempDir, commits, 0, commits.length);

			// Add a commit that deletes bun.lock
			execSync("git rm bun.lock", { cwd: tempDir });
			execSync("git commit -m 'meta: delete bun.lock'", {
				cwd: tempDir,
				env: {
					...process.env,
					GIT_AUTHOR_NAME: "Test Bot",
					GIT_AUTHOR_EMAIL: "bot@test.com",
					GIT_AUTHOR_DATE: "2026-06-06T12:00:00Z",
					GIT_COMMITTER_NAME: "Test Bot",
					GIT_COMMITTER_EMAIL: "bot@test.com",
					GIT_COMMITTER_DATE: "2026-06-06T12:00:00Z",
				},
			});

			// Trying to init with --git-history and --never-forget should throw an error
			try {
				execSync(
					`bun run ${cliPath} init packablock.yaml --git-history bun.lock --never-forget`,
					{ cwd: tempDir, stdio: "pipe" },
				);
				expect(true).toBe(false);
			} catch (err: any) {
				expect(err.message).toContain(
					"cannot be forgotten under never-forget rules",
				);
			}
		});

		it("should successfully compare git history with a chain, matching blocks and warning on discrepancies", async () => {
			const logContent = await fs.readFile(fixturePath, "utf8");
			const commits = parseGitLogPatch(logContent);

			// 1. Rebuild history up to commit 5 and initialize the chain
			await applyCommits(tempDir, commits, 0, 5);
			execSync(
				`bun run ${cliPath} init packablock.yaml --git-history bun.lock`,
				{
					cwd: tempDir,
				},
			);

			// 2. Rebuild the rest of the commits and append them
			await applyCommits(tempDir, commits, 5, commits.length);
			execSync(
				`bun run ${cliPath} append packablock.yaml --git-history bun.lock`,
				{
					cwd: tempDir,
				},
			);

			// 3. Compare the complete chain with the git history
			const compareOutput = execSync(
				`bun run ${cliPath} compare packablock.yaml --git-history bun.lock`,
				{ cwd: tempDir, encoding: "utf8" },
			);

			// We expect blocks to match commits
			expect(compareOutput).toContain("Block 0 matches commit");
			expect(compareOutput).not.toContain("Warning");

			// 4. Create an unmatched commit in the Git history (changes bun.lock but not appended to chain)
			const mockLockfilePath = path.join(tempDir, "bun.lock");
			await fs.writeFile(
				mockLockfilePath,
				JSON.stringify({
					lockfileVersion: 1,
					packages: {
						"unmatched-pkg": ["unmatched-pkg@1.0.0", "", {}, "sha-unmatched"],
					},
				}),
				"utf8",
			);
			execSync("git add bun.lock", { cwd: tempDir });
			execSync("git commit -m 'chore: add unmatched package'", {
				cwd: tempDir,
				env: {
					...process.env,
					GIT_AUTHOR_NAME: "Test Bot",
					GIT_AUTHOR_EMAIL: "bot@test.com",
					GIT_AUTHOR_DATE: "2026-06-06T13:00:00Z",
					GIT_COMMITTER_NAME: "Test Bot",
					GIT_COMMITTER_EMAIL: "bot@test.com",
					GIT_COMMITTER_DATE: "2026-06-06T13:00:00Z",
				},
			});

			// Compare again - should warn about the unmatched commit
			const compareOutput2 = execSync(
				`bun run ${cliPath} compare packablock.yaml --git-history bun.lock`,
				{ cwd: tempDir, encoding: "utf8" },
			);
			expect(compareOutput2).toContain("has no matching block in the chain");

			// 5. Create an unmatched block in the chain (tampered/appended dummy block)
			const dummyAppendData = YAML.stringify({
				lockfiles: {
					"bun.lock": {
						packages: [
							{
								"non-existent-pkg": [{ new: "2.0.0" }, { loc: "1,1" }],
							},
						],
					},
				},
			});
			await appendBlock(chainPath, dummyAppendData);

			// Compare again - should warn about both unmatched commit and unmatched block
			const compareOutput3 = execSync(
				`bun run ${cliPath} compare packablock.yaml --git-history bun.lock`,
				{ cwd: tempDir, encoding: "utf8" },
			);
			expect(compareOutput3).toContain("has no matching commit in git history");
			expect(compareOutput3).toContain("has no matching block in the chain");
		});

		it("should print a warning if run outside of a Git repository", async () => {
			const { spawnSync } = require("node:child_process");
			const nonGitDir = path.resolve("/tmp/temp-non-git-dir");
			rmSync(nonGitDir, { recursive: true, force: true });
			await fs.mkdir(nonGitDir, { recursive: true });

			const testChain = path.join(nonGitDir, "chain.yaml");
			const genesisData = YAML.stringify({
				"bun.lock": {
					packages: [{ lodash: "4.17.21" }],
				},
			});
			await initChain(testChain, genesisData);

			const result = spawnSync(
				"bun",
				["run", cliPath, "status", "chain.yaml"],
				{ cwd: nonGitDir },
			);

			const stderr = result.stderr.toString("utf8");
			expect(stderr).toContain("pkablk is running outside of a Git repository");

			rmSync(nonGitDir, { recursive: true, force: true });
		});
	});
});
