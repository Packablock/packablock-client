import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import path from "node:path";
import fs from "node:fs";
import { computeDiff } from "../src/diff.js";
import { parseLockfiles, readPackageJsonConstraints } from "../src/lockfile.js";

describe("Lockfile Parser & Diff Tests", () => {
	const fixturesDir = path.resolve(__dirname, "fixtures");

	describe("Bun (Legacy JSON format)", () => {
		it("should parse Bun legacy lockfile Iteration 1 correctly", () => {
			const result = parseLockfiles([path.join(fixturesDir, "bun-v1.json")]);
			expect(result.packages).toEqual({
				lodash: "4.17.21",
				zod: "3.22.4",
			});
			expect(result.source).toBe("bun-v1.json");
		});

		it("should parse Bun legacy lockfile Iteration 2 correctly", () => {
			const result = parseLockfiles([path.join(fixturesDir, "bun-v2.json")]);
			expect(result.packages).toEqual({
				commander: "11.1.0",
				lodash: "4.17.22",
				zod: "3.22.4",
			});
			expect(result.source).toBe("bun-v2.json");
		});

		it("should compute the correct diff between Bun Iteration 1 and 2 packages", () => {
			const v1 = parseLockfiles([path.join(fixturesDir, "bun-v1.json")]);
			const v2 = parseLockfiles([path.join(fixturesDir, "bun-v2.json")]);

			const yaml1 = JSON.stringify(v1.packages, null, 2);
			const yaml2 = JSON.stringify(v2.packages, null, 2);

			const diff = computeDiff(yaml1, yaml2);

			// Verify that LODASH version changed and COMMANDER was added
			const addedLines = diff
				.filter((line) => line.type === "added")
				.map((line) => line.text.trim());
			const removedLines = diff
				.filter((line) => line.type === "removed")
				.map((line) => line.text.trim());

			const addedStr = addedLines.join(" ");
			const removedStr = removedLines.join(" ");

			expect(addedStr).toContain('"commander": "11.1.0"');
			expect(addedStr).toContain('"lodash": "4.17.22"');
			expect(removedStr).toContain('"lodash": "4.17.21"');
		});
	});

	describe("Yarn (.lock format)", () => {
		it("should parse Yarn lockfile Iteration 1 correctly", () => {
			const result = parseLockfiles([path.join(fixturesDir, "yarn-v1.lock")]);
			expect(result.packages).toEqual({
				lodash: "4.17.21",
			});
		});

		it("should parse Yarn lockfile Iteration 2 correctly", () => {
			const result = parseLockfiles([path.join(fixturesDir, "yarn-v2.lock")]);
			expect(result.packages).toEqual({
				lodash: "4.17.22",
				zod: "3.22.4",
			});
		});
	});

	describe("NPM (package-lock.json v3 format)", () => {
		it("should parse NPM package-lock.json v3 Iteration 1 correctly", () => {
			const result = parseLockfiles([path.join(fixturesDir, "npm-v1.json")]);
			expect(result.packages).toEqual({
				accepts: "1.3.8",
				express: "4.18.2",
			});
		});

		it("should parse NPM package-lock.json v3 Iteration 2 correctly", () => {
			const result = parseLockfiles([path.join(fixturesDir, "npm-v2.json")]);
			expect(result.packages).toEqual({
				accepts: "1.3.9",
				express: "4.19.2",
			});
		});
	});

	describe("Bun (Modern JSON v1.2+ format)", () => {
		it("should parse Bun modern lockfile correctly", () => {
			const result = parseLockfiles([
				path.join(fixturesDir, "bun-modern.lock"),
			]);
			expect(result.packages["@lezer/common"]).toBe("1.3.0");
			expect(result.packages["esbuild"]).toBe("0.21.5");
			expect(result.packages["typescript"]).toBe("6.0.2");
			expect(result.source).toBe("bun-modern.lock");
		});
	});

	describe("readPackageJsonConstraints", () => {
		const tempDir = path.resolve(__dirname, "temp-test");
		const tempLockfile = path.join(tempDir, "bun.lockb");
		const tempPkgJson = path.join(tempDir, "package.json");

		beforeAll(() => {
			if (!fs.existsSync(tempDir)) {
				fs.mkdirSync(tempDir, { recursive: true });
			}
		});

		afterAll(() => {
			if (fs.existsSync(tempPkgJson)) fs.unlinkSync(tempPkgJson);
			if (fs.existsSync(tempLockfile)) fs.unlinkSync(tempLockfile);
			if (fs.existsSync(tempDir)) fs.rmdirSync(tempDir);
		});

		it("should return null if package.json does not exist", () => {
			const res = readPackageJsonConstraints(tempLockfile);
			expect(res).toBeNull();
		});

		it("should return null if package.json is empty or invalid JSON", () => {
			fs.writeFileSync(tempPkgJson, "{invalid}");
			const res = readPackageJsonConstraints(tempLockfile);
			expect(res).toBeNull();
		});

		it("should parse and return constraints from package.json", () => {
			const pkgObj = {
				dependencies: {
					lodash: "^4.17.21",
				},
				devDependencies: {
					typescript: "~5.1.0",
				},
				peerDependencies: {
					react: ">=18.0.0",
				},
			};
			fs.writeFileSync(tempPkgJson, JSON.stringify(pkgObj));
			const res = readPackageJsonConstraints(tempLockfile);
			expect(res).not.toBeNull();
			expect(res).toEqual([
				{ lodash: "^4.17.21" },
				{ typescript: "~5.1.0" },
				{ react: ">=18.0.0" },
			]);
		});
	});
});
