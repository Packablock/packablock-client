import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CONFIG_DIR = path.join(os.homedir(), ".config", "packablock");
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");

// Default client ID for a standard GitHub OAuth / Device Flow application
// (This can be overridden in the environment if they set PACKABLOCK_GITHUB_CLIENT_ID)
const DEFAULT_CLIENT_ID =
	process.env.PACKABLOCK_GITHUB_CLIENT_ID || "Iv1.packablock_placeholder_id";

export interface AuthConfig {
	github_token?: string;
	api_server?: string;
}

export function loadConfig(): AuthConfig {
	try {
		if (existsSync(CONFIG_FILE)) {
			const data = readFileSync(CONFIG_FILE, "utf8");
			return JSON.parse(data);
		}
	} catch (_err) {
		// Fail silently
	}
	return {};
}

export function saveConfig(config: AuthConfig): void {
	try {
		if (!existsSync(CONFIG_DIR)) {
			mkdirSync(CONFIG_DIR, { recursive: true });
		}
		writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), "utf8");
	} catch (err: any) {
		throw new Error(`Failed to save config file: ${err.message}`);
	}
}

/**
 * Executes the GitHub Device Flow Authentication.
 */
export async function executeDeviceLogin(
	clientId = DEFAULT_CLIENT_ID,
): Promise<string> {
	console.log("Initiating GitHub authentication flow...");

	// Step 1: Request device and user codes
	const response = await fetch("https://github.com/login/device/code", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Accept: "application/json",
		},
		body: JSON.stringify({
			client_id: clientId,
			scope: "repo read:org", // Scopes needed to read repository write permission and organization membership
		}),
	});

	if (!response.ok) {
		const errorText = await response.text();
		throw new Error(
			`Failed to contact GitHub authentication service: ${errorText}`,
		);
	}

	const data: any = await response.json();
	const { device_code, user_code, verification_uri, expires_in, interval } =
		data;

	console.log("\n------------------------------------------------------------");
	console.log(
		`1. Open this link in your browser: \x1b[1m\x1b[36m${verification_uri}\x1b[0m`,
	);
	console.log(
		`2. Enter this code:                \x1b[1m\x1b[32m${user_code}\x1b[0m`,
	);
	console.log("------------------------------------------------------------\n");
	console.log("Waiting for authorization (press Ctrl+C to cancel)...");

	// Step 2: Poll for the access token
	const pollInterval = (interval || 5) * 1000;
	const expiryTime = Date.now() + (expires_in || 900) * 1000;

	while (Date.now() < expiryTime) {
		await new Promise((resolve) => setTimeout(resolve, pollInterval));

		const pollResponse = await fetch(
			"https://github.com/login/oauth/access_token",
			{
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Accept: "application/json",
				},
				body: JSON.stringify({
					client_id: clientId,
					device_code: device_code,
					grant_type: "urn:ietf:params:oauth:grant-type:device_code",
				}),
			},
		);

		if (!pollResponse.ok) {
			continue;
		}

		const pollData: any = await pollResponse.json();

		if (pollData.error) {
			if (pollData.error === "authorization_pending") {
				// Continue polling
				continue;
			}
			if (pollData.error === "slow_down") {
				// Wait longer
				await new Promise((resolve) => setTimeout(resolve, pollInterval));
				continue;
			}
			throw new Error(
				`Authentication error from GitHub: ${pollData.error_description || pollData.error}`,
			);
		}

		if (pollData.access_token) {
			// Success!
			const token = pollData.access_token;

			// Save token in config
			const config = loadConfig();
			config.github_token = token;
			saveConfig(config);

			return token;
		}
	}

	throw new Error("Device authorization flow timed out.");
}

export interface PushOptions {
	apiServer: string;
	repoToken?: string;
	githubOidcToken?: string;
}

export function getGitRemoteRepo(): string | null {
	try {
		const url = execSync("git remote get-url origin", {
			encoding: "utf8",
		}).trim();
		// Parse HTTPS: https://github.com/owner/repo.git or SSH: git@github.com:owner/repo.git
		const match = url.match(/github\.com[/:]([^/]+)\/([^.]+)/);
		if (match?.[1] && match[2]) {
			return `${match[1]}/${match[2]}`;
		}
	} catch (_e) {
		// Failed
	}
	return null;
}

/**
 * Pushes the cryptographically verified chain to the metadata-free API server.
 */
export async function pushChain(
	chainContent: string,
	options: PushOptions,
): Promise<any> {
	const url = `${options.apiServer.replace(/\/$/, "")}/api/v1/log/push`;

	const headers: Record<string, string> = {
		"Content-Type": "text/yaml",
	};

	// Sniff environment metadata for registry integrations auditing
	const clientOS = process.platform || "unknown";
	let clientEnv = "BareMetal";
	try {
		const fs = require("node:fs");
		if (fs.existsSync("/.dockerenv") || fs.existsSync("/run/.containerenv")) {
			clientEnv = "Docker";
		}
	} catch (e) {}
	const isCI = process.env.CI ? "true" : "false";
	const gitActor = process.env.GITHUB_ACTOR || process.env.USER || "unknown";

	headers["X-Client-Version"] = "1.0.0";
	headers["X-Client-OS"] = clientOS;
	headers["X-Client-Env"] = clientEnv;
	headers["X-Client-CI"] = isCI;
	headers["X-Client-Actor"] = gitActor;

	// Determine authorization mechanism:
	// 1. Repo secret registration token (either direct or environment-based)
	const repoToken = options.repoToken || process.env.PACKABLOCK_REPO_TOKEN;
	if (repoToken) {
		headers["X-Repo-Token"] = repoToken;
	}

	// 2. GitHub OIDC Token (CI environment)
	const oidcToken =
		options.githubOidcToken || process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
	if (oidcToken) {
		headers["X-GitHub-OIDC-Token"] = oidcToken;
	}

	// 3. Fallback to developer personal OAuth Token (loaded from CLI login config)
	if (!repoToken && !oidcToken) {
		const config = loadConfig();
		if (config.github_token) {
			headers.Authorization = `Bearer ${config.github_token}`;

			const targetRepo = getGitRemoteRepo();
			if (targetRepo) {
				headers["X-Target-Repo"] = targetRepo;
			}
		} else {
			throw new Error(
				"Authentication required to push to log registry.\n" +
					"Please run: packablock-client login\n" +
					"Or set PACKABLOCK_REPO_TOKEN in your environment.",
			);
		}
	}

	console.log(`Pushing package chain to API server at: ${url}...`);

	const response = await fetch(url, {
		method: "POST",
		headers: headers,
		body: chainContent,
	});

	if (!response.ok) {
		const errorText = await response.text();
		let parsedError: any;
		try {
			parsedError = JSON.parse(errorText);
		} catch {
			// Non-JSON error
		}
		throw new Error(
			`Push failed (${response.status} ${response.statusText}): ` +
				(parsedError?.message || parsedError?.error || errorText),
		);
	}

	return response.json();
}

export interface PullOptions {
	apiServer: string;
	repoToken?: string;
	targetRepo?: string;
}

export interface RegisterOptions {
	apiServer: string;
}

/**
 * Pulls the package chain from the metadata-free API server.
 */
export async function pullChain(options: PullOptions): Promise<string> {
	const url = `${options.apiServer.replace(/\/$/, "")}/api/v1/log/pull`;

	const headers: Record<string, string> = {
		Accept: "text/yaml",
	};

	// Determine authorization/lookup mechanism:
	const repoToken = options.repoToken || process.env.PACKABLOCK_REPO_TOKEN;
	if (repoToken) {
		headers["X-Repo-Token"] = repoToken;
	}

	// Fallback to developer OAuth Token + target repo header
	if (!repoToken) {
		const config = loadConfig();
		if (config.github_token) {
			headers.Authorization = `Bearer ${config.github_token}`;
		}

		const targetRepo = options.targetRepo || getGitRemoteRepo();
		if (targetRepo) {
			headers["X-Target-Repo"] = targetRepo;
		}
	}

	console.log(`Pulling package chain from API server at: ${url}...`);

	const response = await fetch(url, {
		method: "GET",
		headers: headers,
	});

	if (!response.ok) {
		const errorText = await response.text();
		let parsedError: any;
		try {
			parsedError = JSON.parse(errorText);
		} catch {
			// Non-JSON error
		}
		throw new Error(
			`Pull failed (${response.status} ${response.statusText}): ` +
				(parsedError?.message || parsedError?.error || errorText),
		);
	}

	return response.text();
}

/**
 * Registers a repository on the API server.
 */
export async function registerRepo(
	owner: string,
	repo: string,
	options: RegisterOptions,
): Promise<any> {
	const url = `${options.apiServer.replace(/\/$/, "")}/api/v1/repos/register`;

	console.log(
		`Registering repository ${owner}/${repo} on API server at: ${url}...`,
	);

	const response = await fetch(url, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Accept: "application/json",
		},
		body: JSON.stringify({ owner, repo }),
	});

	if (!response.ok) {
		const errorText = await response.text();
		let parsedError: any;
		try {
			parsedError = JSON.parse(errorText);
		} catch {
			// Non-JSON error
		}
		throw new Error(
			`Registration failed (${response.status} ${response.statusText}): ` +
				(parsedError?.message || parsedError?.error || errorText),
		);
	}

	return response.json();
}

export interface WindmillSetupOptions {
	workspace?: string;
	token?: string;
	baseUrl?: string;
}

/**
 * Automates configuring and pushing the Packablock verification DAG flow to the contributor's Windmill workspace.
 */
export async function setupWindmillWorkspace(
	options: WindmillSetupOptions,
): Promise<void> {
	// Check if wmill CLI is installed
	try {
		execSync("wmill --version", { stdio: "ignore" });
	} catch (_err) {
		throw new Error(
			'Windmill CLI ("wmill") is not installed or not found in PATH.\n' +
				"Please install it by running:\n" +
				"  npm install -g wmill\n" +
				"Or refer to Deno-based installations if preferred.",
		);
	}

	// Resolve windmill directory relative to this script file
	const currentDir = path.dirname(fileURLToPath(import.meta.url));
	const windmillDir = path.resolve(currentDir, "..", "windmill");

	if (!existsSync(windmillDir)) {
		throw new Error(
			`Windmill workspace directory not found at: ${windmillDir}`,
		);
	}

	console.log(`📂 Windmill template directory: ${windmillDir}`);

	// Build the push command
	let cmd = "wmill sync push --auto-metadata --yes";

	if (options.workspace) {
		cmd += ` --workspace ${options.workspace}`;
	}
	if (options.token) {
		cmd += ` --token ${options.token}`;
	}
	if (options.baseUrl) {
		cmd += ` --base-url ${options.baseUrl}`;
	}

	console.log(`🚀 Executing: ${cmd}`);

	try {
		execSync(cmd, { cwd: windmillDir, stdio: "inherit" });
	} catch (err: any) {
		throw new Error(`Failed to push windmill configurations: ${err.message}`);
	}
}
