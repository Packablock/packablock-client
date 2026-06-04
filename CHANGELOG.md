# Changelog

## v1.1.0 (2026-06-04)

### Features
- feat(cli): dynamically size visualizer and wrap long package names/constraints to preserve column alignment (#24)
- feat(cli): identify and display tracked vs untracked dependencies in audit and visualization
- feat(cli): display untracked package.json dependencies in visualizer by falling back to local lockfile parsing
- feat(cli): implement candlestick visualization with NPM registry fallback for non-premium users
- feat(client): implement getLatestConstraints and copy active constraints on rollover
- feat(client): capture package.json constraints and update query helpers for nested format
- feat: add strict and never-forget policy flags/env vars to the CLI
- feat: support warning and accepting append/init for forgotten lockfiles
- feat: implement forget command for untracking lockfiles
- feat(client): throw error on already tracked lockfile init
- feat(client): support introducing lockfile mid-chain via init command
- feat(client): throw error on untracked lockfile append
- feat(client): support introducing a new lockfile to an existing chain as an init event
- feat(client): support multiple lockfile initialization and independent diff calculations
- feat(client): keep lockfile name as the root key in every chain payload
- feat: change backup file name format to packablock-<hash>.yaml
- feat: update rollover backup naming to be hash-based
- feat(client): implement Git history replay lockfile ingestion into package log chain

### Chores & Maintenance
- chore(release): integrate semantic-release and changelog automation
- style(cli): simplify candlestick chart table by grouping warnings at the bottom
- test(client): add unit tests for readPackageJsonConstraints


