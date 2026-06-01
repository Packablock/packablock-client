# packablock-client

A Bun + TypeScript CLI for managing cryptographically secured parallel package history chains.

<img width="128" height="128" alt="packablock-cli-avatar-512" src="https://github.com/user-attachments/assets/7ad8650a-d216-4cac-b211-759aa60d1a40" />

## Installation

```bash
bun install
```

## CLI Usage

```bash
# Initialize a new package log from a lockfile
bun start init packablock.yaml -l bun.lockb

# Verify the integrity of the log chain
bun start verify packablock.yaml

# Push the verified chain to the API server
bun start push packablock.yaml --server http://localhost:3030

# Automatically set up and deploy the Packablock verification DAG flows to Windmill
bun start wmill-setup --workspace <your-windmill-workspace> --token <your-api-token>
```

