import fs from "node:fs/promises";
import path from "node:path";
import { Command } from "commander";
import YAML from "yaml";
import {
	executeDeviceLogin,
	getGitRemoteRepo,
	loadConfig,
	pullChain,
	pushChain,
	registerRepo,
	setupWindmillWorkspace,
} from "./api.js";
import {
	appendBlock,
	generateReleaseNotes,
	getChainStatus,
	getPackageHistory,
	initChain,
	splitRawDocuments,
	verifyChain,
} from "./chain.js";
import { computeDiff, formatDiffConsole } from "./diff.js";
import { parseLockfiles } from "./lockfile.js";
import { parseSemVerConstraint, renderCandle } from "./semver.js";

const colors = {
	reset: "\x1b[0m",
	bold: "\x1b[1m",
	red: "\x1b[31m",
	green: "\x1b[32m",
	yellow: "\x1b[33m",
	blue: "\x1b[34m",
	magenta: "\x1b[35m",
	cyan: "\x1b[36m",
	gray: "\x1b[90m",
};

const logo = `
${colors.bold}${colors.cyan}  _____             _         ${colors.magenta}____  _            _      
${colors.bold}${colors.cyan} |  __ \\           | |       ${colors.magenta}|  _ \\| |          | |     
${colors.bold}${colors.cyan} | |__) |___  ___  | | __    ${colors.magenta}| |_) | | ___   ___| | __  
${colors.bold}${colors.cyan} |  ___// _ \\/ __| | |/ /    ${colors.magenta}|  _ <| |/ _ \\ / __| |/ /  
${colors.bold}${colors.cyan} | |   | (_| (__  |   <     ${colors.magenta}| |_) | | (_) | (__|   <   
${colors.bold}${colors.cyan} |_|    \\___|\\___| |_|\\_\\    ${colors.magenta}|____/|_|\\___/ \\___|_|\\_\\  
${colors.reset}`;

export function createCli(): Command {
	const program = new Command();

	program
		.name("pblk")
		.description("Cryptographically secured parallel package log client CLI")
		.version("1.0.0");

	// helper to get data string from options
	async function resolveData(options: any): Promise<string | null> {
		if (options.lockfile && options.lockfile.length > 0) {
			console.log(
				`📦 ${colors.bold}Parsing lockfiles:${colors.reset} ${options.lockfile.join(", ")}`,
			);
			try {
				const parsed = parseLockfiles(options.lockfile);
				// Serialize parsed lockfile packages back as clean YAML
				const yamlData =
					`source: "${parsed.source}"\nevent: "dependencies_baseline"\npackages:\n` +
					Object.entries(parsed.packages)
						.map(([name, ver]) => `  ${name}: "${ver}"`)
						.join("\n") +
					"\n";
				return yamlData;
			} catch (err: any) {
				console.error(
					`${colors.red}${colors.bold}Error parsing lockfile: ${colors.reset}${err.message}`,
				);
				process.exit(1);
			}
		}
		if (options.file) {
			try {
				return await fs.readFile(options.file, "utf8");
			} catch (err: any) {
				console.error(
					`${colors.red}${colors.bold}Error: ${colors.reset}Could not read file '${options.file}': ${err.message}`,
				);
				process.exit(1);
			}
		}
		if (options.data) {
			return options.data;
		}
		return null;
	}

	program
		.command("init")
		.argument("<file>", "Path to the yaml-chain log file to create")
		.option("-d, --data <yaml-string>", "Initial document data payload")
		.option("-f, --file <file-path>", "Path to file containing initial data")
		.option(
			"-l, --lockfile <lockfiles...>",
			"One or more package-lock.json, bun.lockb, or yarn.lock files to parse",
		)
		.description("Initialize a new package log with a genesis block")
		.action(async (file, options) => {
			console.log(logo);
			const data =
				(await resolveData(options)) ||
				'message: "Genesis block initialized."\n';
			const resolvedPath = path.resolve(file);

			try {
				const meta = await initChain(resolvedPath, data);
				console.log(
					`\n✨ ${colors.green}${colors.bold}Success:${colors.reset} Initialized Packablock log at ${colors.bold}${file}${colors.reset}`,
				);
				console.log(
					`${colors.gray}------------------------------------------------------------${colors.reset}`,
				);
				console.log(`${colors.bold}Block Index:${colors.reset} 0 (Genesis)`);
				console.log(
					`${colors.bold}Timestamp:${colors.reset}   ${meta.timestamp}`,
				);
				console.log(
					`${colors.bold}Data Hash:${colors.reset}   ${colors.yellow}${meta.data_hash}${colors.reset}`,
				);
				console.log(
					`${colors.bold}Block Hash:${colors.reset}  ${colors.magenta}${meta.meta_hash}${colors.reset}`,
				);
				console.log(
					`${colors.gray}------------------------------------------------------------${colors.reset}`,
				);
			} catch (err: any) {
				console.error(
					`\n❌ ${colors.red}${colors.bold}Error during initialization:${colors.reset} ${err.message}`,
				);
				process.exit(1);
			}
		});

	program
		.command("append")
		.argument("<file>", "Path to the log file")
		.option("-d, --data <yaml-string>", "Document data payload to append")
		.option("-f, --file <file-path>", "Path to file containing data to append")
		.option(
			"-l, --lockfile <lockfiles...>",
			"One or more lockfiles to parse and append packages",
		)
		.description("Append a new dependency block to the package log")
		.action(async (file, options) => {
			const data = await resolveData(options);
			if (!data) {
				console.error(
					`${colors.red}${colors.bold}Error: ${colors.reset}You must provide data (-d, -f, or -l option).`,
				);
				process.exit(1);
			}

			const resolvedPath = path.resolve(file);
			try {
				const meta = await appendBlock(resolvedPath, data);
				console.log(
					`\n🔗 ${colors.green}${colors.bold}Block appended successfully!${colors.reset}`,
				);
				console.log(
					`${colors.gray}------------------------------------------------------------${colors.reset}`,
				);
				console.log(
					`${colors.bold}Block Index:${colors.reset} ${meta.block_index}`,
				);
				console.log(
					`${colors.bold}Timestamp:${colors.reset}   ${meta.timestamp}`,
				);
				console.log(
					`${colors.bold}Data Hash:${colors.reset}   ${colors.yellow}${meta.data_hash}${colors.reset}`,
				);
				console.log(
					`${colors.bold}Prev Hash:${colors.reset}   ${colors.gray}${meta.prev_meta_hash}${colors.reset}`,
				);
				console.log(
					`${colors.bold}Block Hash:${colors.reset}  ${colors.magenta}${meta.meta_hash}${colors.reset}`,
				);
				console.log(
					`${colors.gray}------------------------------------------------------------${colors.reset}`,
				);
			} catch (err: any) {
				console.error(
					`\n❌ ${colors.red}${colors.bold}Error appending block:${colors.reset} ${err.message}`,
				);
				process.exit(1);
			}
		});

	program
		.command("check")
		.argument("[file]", "Path to the log file to verify", "packablock.yaml")
		.option(
			"--diff",
			"Show a line-by-line diff of tampered data compared to previous block if possible",
		)
		.option(
			"-c, --compare-with <known-good-file>",
			"Cross-file comparison with a known-good backup",
		)
		.option(
			"-s, --server <url>",
			"Target API Server URL for anchoring check (cross-reference)",
		)
		.option(
			"-t, --token <registration-token>",
			"Optional repository registration token",
		)
		.option(
			"-r, --repo <owner/repo>",
			"Optional target repository (owner/repo)",
		)
		.description(
			"Cryptographically verify the entire package history integrity",
		)
		.action(async (file, options) => {
			const resolvedPath = path.resolve(file);

			if (file.endsWith(".tar.gz") || file.endsWith(".tgz")) {
				console.log(
					`🔍 ${colors.bold}Verifying secure release pack attestation:${colors.reset} ${file} ...`,
				);

				try {
					const { verifyPack } = await import("./pack.js");
					const report = await verifyPack(resolvedPath, {
						secret: options.token || process.env.PACKABLOCK_SIGNING_SECRET,
						serverUrl: options.server,
						targetRepo: options.repo,
					});

					if (report.valid && report.manifest) {
						const manifest = report.manifest;
						console.log(
							`\n✅ ${colors.green}${colors.bold}Release pack attestation VERIFIED!${colors.reset}`,
						);
						console.log(
							`${colors.gray}------------------------------------------------------------${colors.reset}`,
						);
						console.log(
							`${colors.bold}Release Timestamp:${colors.reset} ${manifest.timestamp}`,
						);
						console.log(
							`${colors.bold}Anchor Block:${colors.reset}      Block #${manifest.chainStatus.blockCount - 1}`,
						);
						console.log(
							`${colors.bold}Anchor Hash:${colors.reset}       ${colors.magenta}${manifest.chainStatus.lastBlockHash}${colors.reset}`,
						);
						console.log(
							`${colors.bold}Registry Sync:${colors.reset}     ${
								manifest.registryStatus.isAnchored
									? `${colors.green}Anchored on ${manifest.registryStatus.registryUrl} (${manifest.registryStatus.syncStatus})${colors.reset}`
									: `${colors.yellow}Unanchored / Offline${colors.reset}`
							}`,
						);
						console.log(
							`${colors.bold}Signing Method:${colors.reset}    ${manifest.authType?.toUpperCase()}`,
						);
						console.log(`${colors.bold}Provenance Signers:${colors.reset}`);
						for (const signer of manifest.signerIdentities) {
							console.log(
								`  • Block #${signer.blockIndex}: ${signer.committer} (${colors.cyan}${signer.keyIdOrIdentity}${colors.reset})`,
							);
						}
						console.log(
							`${colors.gray}------------------------------------------------------------${colors.reset}\n`,
						);
					} else {
						console.error(
							`\n❌ ${colors.red}Release pack verification FAILED:${colors.reset} ${report.reason}`,
						);
						process.exit(1);
					}
				} catch (err: any) {
					console.error(
						`\n❌ ${colors.red}Release pack verification failed:${colors.reset} ${err.message}`,
					);
					process.exit(1);
				}
				return;
			}

			console.log(
				`🔍 ${colors.bold}Verifying chain integrity for:${colors.reset} ${file} ...`,
			);

			try {
				const report = await verifyChain(resolvedPath);

				if (report.valid) {
					if (options.server) {
						console.log(
							`🌐 ${colors.cyan}Cross-referencing local chain with registry at ${options.server}...${colors.reset}`,
						);
						try {
							const remoteChainStr = await pullChain({
								apiServer: options.server,
								repoToken: options.token,
								targetRepo: options.repo,
							});

							const localStatus = await getChainStatus(resolvedPath);
							const remoteDocs = splitRawDocuments(remoteChainStr);
							if (remoteDocs.length === 0 || remoteDocs.length % 2 !== 0) {
								throw new Error(
									"Remote log chain on server is empty or malformed.",
								);
							}
							const lastRemoteMetaDocStr = remoteDocs[remoteDocs.length - 1];
							if (lastRemoteMetaDocStr === undefined) {
								throw new Error("Remote log chain is empty or malformed.");
							}
							const parsedRemote = YAML.parse(lastRemoteMetaDocStr);
							const remoteLastBlock = parsedRemote?.["$yaml-chain-meta"];

							if (!remoteLastBlock) {
								throw new Error("Failed to parse remote log chain metadata.");
							}

							if (localStatus.blockCount !== remoteDocs.length / 2) {
								throw new Error(
									`Chain length mismatch. Local: ${localStatus.blockCount} blocks, Remote: ${remoteDocs.length / 2} blocks.`,
								);
							}

							if (
								localStatus.lastBlock?.meta_hash !== remoteLastBlock.meta_hash
							) {
								throw new Error(
									`Cryptographic mismatch with anchored remote log! Local latest hash: ${localStatus.lastBlock?.meta_hash}, Remote latest hash: ${remoteLastBlock.meta_hash}. Potential history rewrite detected!`,
								);
							}

							console.log(
								`\n✅ ${colors.green}${colors.bold}VERIFICATION PASSED:${colors.reset} The log history is cryptographically intact and anchored securely to the registry.`,
							);
						} catch (err: any) {
							console.error(
								`\n❌ ${colors.red}${colors.bold}ANCHORING CHECK FAILED:${colors.reset} ${err.message}`,
							);
							process.exit(1);
						}
					} else {
						console.log(
							`\n✅ ${colors.green}${colors.bold}VERIFICATION PASSED:${colors.reset} The log history is cryptographically intact and untampered.`,
						);

						// Print Prominent Warning Box (LEVEL_2_STANDALONE Mode)
						console.warn(
							`\n${colors.yellow}│ ⚠️  SECURITY WARNING: DEGRADED TRUST MODE${colors.reset}`,
						);
						console.warn(
							`${colors.yellow}│ This verification was executed in pure Standalone mode without an${colors.reset}`,
						);
						console.warn(
							`${colors.yellow}│ external log anchor.${colors.reset}`,
						);
						console.warn(
							`${colors.yellow}│ While source bytes match what the committer signed, this runner cannot${colors.reset}`,
						);
						console.warn(
							`${colors.yellow}│ detect localized history rewrites or split-timeline attacks.${colors.reset}\n`,
						);
					}
					process.exit(0);
				} else {
					console.log(
						`\n❌ ${colors.red}${colors.bold}VERIFICATION FAILED! TAMPER DETECTED!${colors.reset}`,
					);
					console.log(
						`${colors.gray}------------------------------------------------------------${colors.reset}`,
					);
					console.log(
						`${colors.bold}Reason:${colors.reset}        ${colors.red}${report.reason}${colors.reset}`,
					);
					console.log(
						`${colors.bold}Failed Block:${colors.reset}  Block ${report.blockIndex !== undefined ? report.blockIndex : "N/A"}`,
					);
					console.log(
						`${colors.bold}Component:${colors.reset}     ${colors.yellow}${report.tamperedComponent || "N/A"}${colors.reset}`,
					);

					if (report.expected !== undefined || report.actual !== undefined) {
						console.log(
							`${colors.bold}Expected:${colors.reset}      ${colors.green}${report.expected}${colors.reset}`,
						);
						console.log(
							`${colors.bold}Actual:${colors.reset}        ${colors.red}${report.actual}${colors.reset}`,
						);
					}
					console.log(
						`${colors.gray}------------------------------------------------------------${colors.reset}`,
					);

					if (options.compareWith) {
						const comparePath = path.resolve(options.compareWith);
						try {
							const compareContent = await fs.readFile(comparePath, "utf8");
							const compareDocs = splitRawDocuments(compareContent);

							if (report.tamperedComponent === "data") {
								const knownGoodDoc = compareDocs[2 * report.blockIndex!];
								const tamperedDoc = report.dataText;

								if (knownGoodDoc !== undefined && tamperedDoc !== undefined) {
									console.log(
										`\n🌱 ${colors.bold}Diffing original block (from known-good file) ➡️ tampered block:${colors.reset}`,
									);
									console.log(
										`${colors.gray}------------------------------------------------------------${colors.reset}`,
									);
									const diff = computeDiff(knownGoodDoc, tamperedDoc);
									console.log(formatDiffConsole(diff));
									console.log(
										`${colors.gray}------------------------------------------------------------${colors.reset}`,
									);
								} else {
									console.log(
										`\n${colors.yellow}Warning: Could not locate Block ${report.blockIndex} in known-good file to diff against.${colors.reset}`,
									);
								}
							}
						} catch (err: any) {
							console.error(
								`\n❌ ${colors.red}Error reading known-good comparison file:${colors.reset} ${err.message}`,
							);
						}
					} else if (
						options.diff &&
						report.tamperedComponent === "data" &&
						report.blockIndex! > 0
					) {
						console.log(
							`\n${colors.bold}Diffing Block ${report.blockIndex} with previous Block ${report.blockIndex! - 1}:${colors.reset}`,
						);

						const content = await fs.readFile(resolvedPath, "utf8");
						const docs = splitRawDocuments(content);
						const prevBlockData = docs[2 * (report.blockIndex! - 1)];
						const currentBlockData = report.dataText;

						if (prevBlockData !== undefined && currentBlockData !== undefined) {
							const diff = computeDiff(prevBlockData, currentBlockData);
							console.log(formatDiffConsole(diff));
						}
					}

					process.exit(1);
				}
			} catch (err: any) {
				console.error(
					`\n❌ ${colors.red}${colors.bold}Error performing verification:${colors.reset} ${err.message}`,
				);
				process.exit(1);
			}
		});

	program
		.command("audit")
		.argument("[file]", "Path to the local log file", "packablock.yaml")
		.option(
			"--visualize",
			"Visualize package constraints and upstream drift using SemVer Candle charts",
		)
		.option(
			"-s, --server <url>",
			"Target API Server URL",
			process.env.PACKABLOCK_API_SERVER || "http://localhost:3030",
		)
		.option(
			"-t, --token <registration-token>",
			"Optional repository registration token",
		)
		.option(
			"-r, --repo <owner/repo>",
			"Optional target repository (owner/repo)",
		)
		.description(
			"Audit local package constraints and project history against upstream registry releases",
		)
		.action(async (file, options) => {
			const resolvedPath = path.resolve(file);
			try {
				// 1. Local Cryptographic Integrity Verification
				const report = await verifyChain(resolvedPath);
				if (!report.valid) {
					console.error(
						`\n❌ ${colors.red}${colors.bold}LOCAL LOG INTEGRITY AUDIT FAILED:${colors.reset}`,
					);
					console.error(`Reason: ${report.reason}`);
					process.exit(1);
				}

				// 2. Fetch history lifecycle from local chain
				const history = await getPackageHistory(resolvedPath);

				// 3. Read constraints from local package.json
				const packageJsonPath = path.resolve("package.json");
				let packageJson: any = {};
				try {
					const pjsContent = await fs.readFile(packageJsonPath, "utf8");
					packageJson = JSON.parse(pjsContent);
				} catch (err: any) {
					console.error(
						`\n❌ ${colors.red}${colors.bold}Error reading package.json:${colors.reset} ${err.message}`,
					);
					process.exit(1);
				}

				const directDeps = {
					...packageJson.dependencies,
					...packageJson.devDependencies,
					...packageJson.peerDependencies,
				};

				const targetPackages = Object.keys(directDeps).filter(
					(pkgName) => history[pkgName] !== undefined,
				);

				if (targetPackages.length === 0) {
					console.log(
						`\n🔍 ${colors.bold}Packablock Supply Chain Velocity Audit${colors.reset}`,
					);
					console.log(`Target: ${path.dirname(resolvedPath)}`);
					console.log(
						`Status: ${colors.green}${colors.bold}SECURELY ANCHORED (0 direct packages tracked in chain)${colors.reset}\n`,
					);
					return;
				}

				// 4. Query registry server for latest upstream versions if --visualize is requested
				let latestUpstreamVersions: Record<string, string> = {};
				let isPremiumUser = false;
				const isVisualizing = !!options.visualize;

				if (isVisualizing) {
					const url = `${options.server.replace(/\/$/, "")}/api/v1/packages/latest`;

					const headers: Record<string, string> = {
						"Content-Type": "application/json",
					};

					const repoToken = options.token || process.env.PACKABLOCK_REPO_TOKEN;
					if (repoToken) {
						headers["X-Repo-Token"] = repoToken;
					}

					if (!repoToken) {
						const config = loadConfig();
						if (config.github_token) {
							headers.Authorization = `Bearer ${config.github_token}`;
							const targetRepo = options.repo || getGitRemoteRepo();
							if (targetRepo) {
								headers["X-Target-Repo"] = targetRepo;
							}
						}
					}

					try {
						const response = await fetch(url, {
							method: "POST",
							headers: headers,
							body: JSON.stringify({ packages: targetPackages }),
						});

						if (response.ok) {
							const resData = (await response.json()) as any;
							if (resData?.packages) {
								latestUpstreamVersions = resData.packages;
								isPremiumUser = true;
							}
						} else if (
							response.status === 402 ||
							response.status === 403 ||
							response.status === 401
						) {
							// Gracefully handle paid paywall or unauthenticated visualizer requests
							isPremiumUser = false;
						}
					} catch (_err) {
						// Server offline or connection error
						isPremiumUser = false;
					}
				}

				// 5. Output Audit Header
				const status = await getChainStatus(resolvedPath);
				console.log(
					`\n🔍 ${colors.bold}Packablock Supply Chain Velocity Audit${colors.reset}`,
				);
				console.log(`Target: ${path.dirname(resolvedPath)}`);
				console.log(`Registry Anchor: ${options.server}`);
				console.log(
					`Status: ${colors.green}${colors.bold}SECURELY ANCHORED (${status.blockCount} Blocks Aligned)${colors.reset}\n`,
				);

				if (isVisualizing && !isPremiumUser) {
					console.log(
						`${colors.yellow}⭐ Premium Feature: Upstream drift analysis and SemVer Candle visualization are only available to paying customers of the hosted Packablock Registry.${colors.reset}`,
					);
					console.log(
						`To unlock, subscribe at ${colors.bold}https://packablock.com/pricing${colors.reset} or authenticate using '${colors.bold}pblk login${colors.reset}'.\n`,
					);

					// Print simplified non-premium summary (names and current/first seen versions)
					console.log(
						`${colors.bold}Tracked Dependencies Summary:${colors.reset}`,
					);
					console.log(
						`----------------------------------------------------------------------------`,
					);
					console.log(
						`Package Name      Constraint  First Seen  Current Pinned`,
					);
					console.log(
						`----------------------------------------------------------------------------`,
					);
					for (const pkg of targetPackages) {
						const constraint = directDeps[pkg];
						if (constraint === undefined) continue;
						const pkgHist = history[pkg];
						if (!pkgHist) continue;
						const first = pkgHist.firstSeen;
						const pinned = pkgHist.currentPinned;
						console.log(
							`${pkg.padEnd(18)} ${constraint.padEnd(11)} ${first.padEnd(11)} ${pinned}`,
						);
					}
					console.log(
						`----------------------------------------------------------------------------\n`,
					);
					return;
				}

				if (isVisualizing && isPremiumUser) {
					console.log(`## SemVer Candle Analysis (Lockfile Lifecycle)`);
					console.log(`Legend:`);
					console.log(
						`  | : Min/Max Constraint Boundary   ░ : Historical Drift (First seen -> Pinned)`,
					);
					console.log(
						`  ● : Current Pinned Version        ═ : Unused Allowed Range (Upstream Available)`,
					);
					console.log(`  ► : Extension to Infinity (>=)\n`);

					console.log(
						`----------------------------------------------------------------------------------------------------------------`,
					);
					console.log(
						`Package Name      Constraint  Version Timeline (Low -> Installed -> Upstream -> Max)`,
					);
					console.log(
						`----------------------------------------------------------------------------------------------------------------`,
					);

					for (const pkg of targetPackages) {
						const constraint = directDeps[pkg];
						if (constraint === undefined) continue;
						const pkgHist = history[pkg];
						if (!pkgHist) continue;
						const first = pkgHist.firstSeen;
						const pinned = pkgHist.currentPinned;
						const latest = latestUpstreamVersions[pkg] || pinned; // fallback to pinned if not found

						const range = parseSemVerConstraint(constraint, pinned);
						const candle = renderCandle(
							range.min,
							first,
							pinned,
							latest,
							range.max,
							40,
						);

						// Highlight specific risks/warnings based on candle metrics
						let label = "";
						if (range.max === "infinity") {
							label = ` ${colors.red}(Open Fuse: >= Risk)${colors.reset}`;
						} else if (
							pinned === range.max ||
							pinned.startsWith(range.max.replace(/\.x|\.99/g, ""))
						) {
							label = ` ${colors.yellow}(Technical Debt Wall)${colors.reset}`;
						} else if (pinned === latest) {
							label = ` ${colors.green}(Fully Up-To-Date)${colors.reset}`;
						}

						console.log(
							`${pkg.padEnd(17)} ${constraint.padEnd(11)} ${candle}${label}`,
						);
					}
					console.log(
						`----------------------------------------------------------------------------------------------------------------\n`,
					);
				} else {
					// Standard check run without --visualize
					console.log(`${colors.bold}Tracked Dependencies:${colors.reset}`);
					for (const pkg of targetPackages) {
						const constraint = directDeps[pkg];
						if (constraint === undefined) continue;
						const pkgHist = history[pkg];
						if (!pkgHist) continue;
						const pinned = pkgHist.currentPinned;
						console.log(
							`  * ${colors.green}${pkg}${colors.reset} (pinned to ${pinned}, constraint is ${constraint})`,
						);
					}
					console.log();
				}
			} catch (err: any) {
				console.error(
					`\n❌ ${colors.red}${colors.bold}Audit failed:${colors.reset} ${err.message}`,
				);
				process.exit(1);
			}
		});

	program
		.command("status")
		.argument("<file>", "Path to the log file")
		.description("Get the current status and statistics of the log")
		.action(async (file) => {
			const resolvedPath = path.resolve(file);
			try {
				const status = await getChainStatus(resolvedPath);
				console.log(
					`\n📊 ${colors.bold}Log Health Status:${colors.reset} ${file}`,
				);
				console.log(
					`${colors.gray}------------------------------------------------------------${colors.reset}`,
				);
				console.log(
					`${colors.bold}Log Health:${colors.reset}     ${status.isHealthy ? `${colors.green}Healthy${colors.reset}` : `${colors.red}Malformed${colors.reset}`}`,
				);
				console.log(
					`${colors.bold}Block Count:${colors.reset}    ${status.blockCount}`,
				);

				if (status.lastBlock) {
					console.log(
						`${colors.bold}Last Index:${colors.reset}     ${status.lastBlock.block_index}`,
					);
					console.log(
						`${colors.bold}Last Hash:${colors.reset}      ${colors.magenta}${status.lastBlock.meta_hash}${colors.reset}`,
					);
					console.log(
						`${colors.bold}Last Timestamp:${colors.reset} ${status.lastBlock.timestamp}`,
					);
				}
				console.log(
					`${colors.gray}------------------------------------------------------------${colors.reset}`,
				);
			} catch (err: any) {
				console.error(
					`\n❌ ${colors.red}Error fetching status:${colors.reset} ${err.message}`,
				);
				process.exit(1);
			}
		});

	program
		.command("show")
		.argument("<file>", "Path to the log file")
		.argument("<index>", "Block index to view")
		.description("View the payload and metadata of a specific block")
		.action(async (file, indexStr) => {
			const index = parseInt(indexStr, 10);
			const resolvedPath = path.resolve(file);
			try {
				const content = await fs.readFile(resolvedPath, "utf8");
				const docs = splitRawDocuments(content);

				const dataDoc = docs[2 * index];
				const metaDoc = docs[2 * index + 1];

				if (dataDoc === undefined || metaDoc === undefined) {
					console.error(
						`${colors.red}Error: Block index ${index} out of bounds.${colors.reset}`,
					);
					process.exit(1);
				}

				console.log(
					`\n📦 ${colors.bold}Block ${index} details:${colors.reset}`,
				);
				console.log(
					`${colors.gray}============================================================${colors.reset}`,
				);
				console.log(`${colors.bold}METADATA BLOCK:${colors.reset}`);
				console.log(metaDoc.trim());
				console.log(
					`${colors.gray}------------------------------------------------------------${colors.reset}`,
				);
				console.log(`${colors.bold}DATA PAYLOAD:${colors.reset}`);
				console.log(dataDoc.trim());
				console.log(
					`${colors.gray}============================================================${colors.reset}`,
				);
			} catch (err: any) {
				console.error(
					`${colors.red}Error displaying block details:${colors.reset} ${err.message}`,
				);
				process.exit(1);
			}
		});

	program
		.command("notes")
		.argument("<file>", "Path to the log file")
		.option("-o, --owner <org-name>", "Organization/owner name", "packablock")
		.description(
			"Generate structured release notes and package log in Markdown",
		)
		.action(async (file, options) => {
			const resolvedPath = path.resolve(file);
			try {
				const markdown = await generateReleaseNotes(
					resolvedPath,
					options.owner,
				);
				console.log(markdown);
			} catch (err: any) {
				console.error(
					`${colors.red}Error generating release notes:${colors.reset} ${err.message}`,
				);
				process.exit(1);
			}
		});

	program
		.command("login")
		.description(
			"Authenticate dynamically with GitHub using Device Flow (OAuth)",
		)
		.action(async () => {
			console.log(logo);
			try {
				const _token = await executeDeviceLogin();
				console.log(
					`\n🎉 ${colors.green}${colors.bold}SUCCESS:${colors.reset} Authenticated successfully to GitHub!`,
				);
				console.log(`Personal access token secured in configuration.`);
			} catch (err: any) {
				console.error(
					`\n❌ ${colors.red}${colors.bold}Authentication failed:${colors.reset} ${err.message}`,
				);
				process.exit(1);
			}
		});

	program
		.command("push")
		.argument("[file]", "Path to the log file to push", "packablock.yaml")
		.option(
			"-s, --server <url>",
			"Target API Server URL",
			process.env.PACKABLOCK_API_SERVER || "http://localhost:3030",
		)
		.option(
			"-t, --token <registration-token>",
			"Optional repository registration token",
		)
		.description(
			"Push the cryptographically verified package log to the API server",
		)
		.action(async (file, options) => {
			const resolvedPath = path.resolve(file);

			// Step 1: Verify locally first!
			console.log(`🔍 Checking chain validity before push...`);
			try {
				const report = await verifyChain(resolvedPath);
				if (!report.valid) {
					console.error(
						`\n❌ ${colors.red}${colors.bold}Validation error:${colors.reset} Cannot push a tampered chain history!`,
					);
					console.error(`${colors.red}Reason: ${report.reason}${colors.reset}`);
					process.exit(1);
				}
			} catch (err: any) {
				console.error(
					`\n❌ ${colors.red}${colors.bold}Failed to verify chain:${colors.reset} ${err.message}`,
				);
				process.exit(1);
			}

			// Step 2: Read complete content
			try {
				const content = await fs.readFile(resolvedPath, "utf8");

				// Step 3: Transmit
				const result = await pushChain(content, {
					apiServer: options.server,
					repoToken: options.token,
				});

				console.log(
					`\n🚀 ${colors.green}${colors.bold}SUCCESS:${colors.reset} Chain synced successfully!`,
				);
				console.log(
					`${colors.bold}Server Response:${colors.reset} ${result.message || "Log written"}`,
				);
				if (result.blockCount) {
					console.log(
						`${colors.bold}Server Block Count:${colors.reset} ${result.blockCount}`,
					);
				}
			} catch (err: any) {
				console.error(
					`\n❌ ${colors.red}${colors.bold}Push failed:${colors.reset} ${err.message}`,
				);
				process.exit(1);
			}
		});

	program
		.command("pull")
		.argument(
			"[file]",
			"Path to write the pulled package log",
			"packablock.yaml",
		)
		.option(
			"-s, --server <url>",
			"Target API Server URL",
			process.env.PACKABLOCK_API_SERVER || "http://localhost:3030",
		)
		.option(
			"-t, --token <registration-token>",
			"Optional repository registration token",
		)
		.option(
			"-r, --repo <owner/repo>",
			"Optional target repository (owner/repo)",
		)
		.description(
			"Pull the cryptographically verified package log from the API server",
		)
		.action(async (file, options) => {
			const resolvedPath = path.resolve(file);
			try {
				const content = await pullChain({
					apiServer: options.server,
					repoToken: options.token,
					targetRepo: options.repo,
				});

				await fs.writeFile(resolvedPath, content, "utf8");
				console.log(
					`\n📥 ${colors.green}${colors.bold}SUCCESS:${colors.reset} Chain pulled and saved successfully to ${colors.bold}${file}${colors.reset}!`,
				);
			} catch (err: any) {
				console.error(
					`\n❌ ${colors.red}${colors.bold}Pull failed:${colors.reset} ${err.message}`,
				);
				process.exit(1);
			}
		});

	program
		.command("register")
		.argument(
			"<owner/repo>",
			"The GitHub owner/repository to register (e.g. Packablock/packablock-client)",
		)
		.option(
			"-s, --server <url>",
			"Target API Server URL",
			process.env.PACKABLOCK_API_SERVER || "http://localhost:3030",
		)
		.description(
			"Register a new repository on the API server to generate a registration token",
		)
		.action(async (ownerRepo, options) => {
			const [owner, repo] = ownerRepo.split("/");
			if (!owner || !repo) {
				console.error(
					`\n❌ ${colors.red}${colors.bold}Error:${colors.reset} Repository must be in the format 'owner/repo' (e.g. Packablock/packablock-client)`,
				);
				process.exit(1);
			}

			try {
				const result = await registerRepo(owner, repo, {
					apiServer: options.server,
				});

				console.log(
					`\n🎉 ${colors.green}${colors.bold}SUCCESS:${colors.reset} Repository registered successfully!`,
				);
				console.log(
					`${colors.gray}------------------------------------------------------------${colors.reset}`,
				);
				console.log(
					`${colors.bold}Owner:${colors.reset}              ${result.owner}`,
				);
				console.log(
					`${colors.bold}Repository:${colors.reset}         ${result.repo}`,
				);
				console.log(
					`${colors.bold}Registration Token:${colors.reset} ${colors.yellow}${result.registrationToken}${colors.reset}`,
				);
				console.log(
					`${colors.gray}------------------------------------------------------------${colors.reset}`,
				);
				console.log(
					`${colors.bold}IMPORTANT:${colors.reset} Save this registration token in your repository secrets as ${colors.bold}PACKABLOCK_REPO_TOKEN${colors.reset}!`,
				);
			} catch (err: any) {
				console.error(
					`\n❌ ${colors.red}${colors.bold}Registration failed:${colors.reset} ${err.message}`,
				);
				process.exit(1);
			}
		});

	program
		.command("wmill-setup")
		.option(
			"-w, --workspace <workspace>",
			"Optional target Windmill workspace to push the DAG flow to",
		)
		.option(
			"-t, --token <token>",
			"Optional Windmill API token for remote push",
		)
		.option("-b, --base-url <url>", "Optional Windmill base API URL")
		.description(
			"Automatically configure and push the Packablock verification DAG flow to your Windmill workspace",
		)
		.action(async (options) => {
			console.log(logo);
			console.log(
				`🌀 ${colors.bold}Setting up Windmill DAG flows...${colors.reset}\n`,
			);

			try {
				await setupWindmillWorkspace({
					workspace: options.workspace,
					token: options.token,
					baseUrl: options.baseUrl,
				});
				console.log(
					`\n✨ ${colors.green}${colors.bold}SUCCESS:${colors.reset} Packablock Windmill DAG flows are fully configured and deployed!`,
				);
			} catch (err: any) {
				console.error(
					`\n❌ ${colors.red}${colors.bold}Windmill setup failed:${colors.reset} ${err.message}`,
				);
				process.exit(1);
			}
		});

	program
		.command("pack")
		.argument("[dir]", "Path to the workspace directory to pack", ".")
		.option("-o, --output <file>", "Output tarball path", "pack.tar.gz")
		.option("-l, --log <file>", "Path to the chain log file", "packablock.yaml")
		.option(
			"-s, --secret <text>",
			"Shared secret to sign the manifest with HMAC-SHA256",
		)
		.option(
			"-k, --key <private-key-path>",
			"Path to the private key to sign the manifest with RSA-SHA256",
		)
		.description(
			"Verify local chain integrity, sign a build manifest, and compile a metadata-only pack tarball containing the chain and manifest",
		)
		.action(async (dir, options) => {
			try {
				console.log(
					`\n📦 ${colors.bold}Initiating Packablock secure metadata-only packager...${colors.reset}`,
				);

				const { packWorkspace } = await import("./pack.js");
				const { manifest, tarballPath } = await packWorkspace(
					dir,
					options.output,
					options.log,
					{
						secret: options.secret,
						keyPath: options.key,
					},
				);

				console.log(
					`✅ ${colors.green}${colors.bold}Pack tarball compiled successfully!${colors.reset}`,
				);
				console.log(
					`${colors.gray}------------------------------------------------------------${colors.reset}`,
				);
				console.log(
					`${colors.bold}Tarball Path:${colors.reset}      ${tarballPath}`,
				);
				console.log(
					`${colors.bold}Anchor Block:${colors.reset}      Block #${manifest.chainStatus.blockCount - 1}`,
				);
				console.log(
					`${colors.bold}Anchor Hash:${colors.reset}       ${colors.magenta}${manifest.chainStatus.lastBlockHash}${colors.reset}`,
				);
				console.log(
					`${colors.bold}Signers Identified:${colors.reset} ${manifest.signerIdentities.length}`,
				);
				console.log(
					`${colors.bold}Signing Method:${colors.reset}    ${manifest.authType?.toUpperCase()}`,
				);
				console.log(
					`${colors.bold}Manifest Sig:${colors.reset}      ${colors.cyan}${manifest.signature.substring(0, 16)}...${colors.reset}`,
				);
				console.log(
					`${colors.gray}------------------------------------------------------------${colors.reset}\n`,
				);
			} catch (err: any) {
				console.error(
					`\n❌ ${colors.red}Release packaging failed:${colors.reset} ${err.message}`,
				);
				process.exit(1);
			}
		});

	program
		.command("rollover")
		.argument(
			"[file]",
			"Path to the package log file to roll over",
			"packablock.yaml",
		)
		.option(
			"-s, --server <url>",
			"Target API Server URL",
			process.env.PACKABLOCK_API_SERVER || "http://localhost:3030",
		)
		.option(
			"-t, --token <registration-token>",
			"Optional repository registration token",
		)
		.option(
			"-r, --repo <owner/repo>",
			"Optional target repository (owner/repo)",
		)
		.description(
			"Generates a cryptographically linked Genesis block across rotational boundaries and syncs state with the registry",
		)
		.action(async (file, options) => {
			try {
				console.log(
					`\n🔑 ${colors.bold}Initiating Packablock cryptographic key rollover coordination...${colors.reset}`,
				);

				const { rolloverChain } = await import("./chain.js");
				const { backupPath, prevMetaHash, newGenesisHash } =
					await rolloverChain(file, {
						serverUrl: options.server,
						token: options.token || process.env.PACKABLOCK_SIGNING_SECRET,
						repo: options.repo,
					});

				console.log(
					`✅ ${colors.green}${colors.bold}Cryptographic rollover completed successfully!${colors.reset}`,
				);
				console.log(
					`${colors.gray}------------------------------------------------------------${colors.reset}`,
				);
				console.log(
					`${colors.bold}Legacy Backup Path: ${colors.reset}${backupPath}`,
				);
				console.log(
					`${colors.bold}Legacy Chain Hash:  ${colors.reset}${colors.yellow}${prevMetaHash}${colors.reset}`,
				);
				console.log(
					`${colors.bold}New Genesis Hash:   ${colors.reset}${colors.magenta}${newGenesisHash}${colors.reset}`,
				);
				console.log(
					`${colors.gray}------------------------------------------------------------${colors.reset}\n`,
				);
			} catch (err: any) {
				console.error(
					`\n❌ ${colors.red}Key rotation rollover failed:${colors.reset} ${err.message}`,
				);
				process.exit(1);
			}
		});

	return program;
}
