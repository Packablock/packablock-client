# GEMINI.md: Multi-Agent Identity & Configuration Guidelines

This workspace orchestrates a zero-trust package attestation log. To prevent credential clashing and ensure absolute audit trail integrity across our **multi-agent team**, all AI agents and subagents working in this workspace must strictly adhere to these dynamic authorization boundaries.

---

## 🔑 Agent Identity, Commit Signing & Push Authentication

When performing Git operations, commits, remote pushes, or GitHub CLI (`gh`) API requests, agents must **never** use the human developer's global VM configurations (`user.name "Aaron Bronow"`) or default token session state.

Instead, agents must use the dedicated **Workspace Repo Wrapper Scripts** located in the workspace root directory. These wrappers dynamically load the correct environment profiles, authorize API credentials, and cryptographically sign commit trees automatically:

### 🚀 Available Wrappers
- **Agy lead agent wrapper**: `./git-agy`
- **Contributor-1 agent wrapper**: `./git-contributor-1`

### 🔧 Usage Examples

#### 1. Creating Git Commits
Instead of using `git commit`, run the commit command directly through your wrapper:
```bash
./git-agy commit -m "Your commit message"
```

#### 2. Git Remote Pushing
Instead of prefixing tokens manually, execute your pushes through the wrapper:
```bash
./git-agy push origin <branch>
```

#### 3. GitHub API & CLI Overrides
Because the wrapper automatically exports the correct token session keys inside its process environment, any Git or `gh` API command run through the wrapper is instantly authenticated:
```bash
./git-agy gh api <endpoint>
```

---

## 🛠️ Workspace Architecture Mapping
* **`packablock-client`** (`https://github.com/Packablock/packablock-client`): Bun CLI client that automatically reads the local config and pushes cryptographically verified logs to `/api/v1/log/push`.
* **`packablock-registry`** (`https://github.com/Packablock/packablock-api`): The zero-trust Packablock Supply Chain Trust Registry server. Fastify SQLite server listening locally on port `3030`.
* **Windmill Template**: Located in `packablock-demo/windmill/` containing the `verify_and_report` flow and scripts.

## 🛠️ Tooling & Infrastructure Context
* **Windmill CLI (`wmill`)**: Installed and available at `/home/aaron/.nvm/versions/node/v24.14.1/bin/wmill`. Always run from inside the `packablock-demo/windmill/` directory.
* **Lockfile Metadata & Linting**: Run `wmill generate-metadata` inside `packablock-demo/windmill/` to rebuild lockfiles/schemas, and `wmill lint` to validate flows.
* **Pushes to Windmill**: Deploy templates with `bun start wmill-setup` or `wmill sync push` inside the `windmill/` directory.
* **Active Workload (WIP)**: Run `./wip.sh` inside the workspace root directory to instantly view all "In Progress" organization tasks with minimal token consumption.


