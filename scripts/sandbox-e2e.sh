#!/usr/bin/env bash
# scripts/sandbox-e2e.sh: Pre-flight local E2E sandbox verification script.
# Spins up the local registry, initializes a client chain, appends dependencies,
# pushes attestations, and verifies anchoring.

set -euo pipefail

# Resolve directories
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLIENT_DIR="$(dirname "$SCRIPT_DIR")"
WORKSPACE_DIR="$(dirname "$CLIENT_DIR")"
REGISTRY_DIR="$WORKSPACE_DIR/packablock-registry"

PORT=4545
SERVER_URL="http://localhost:$PORT"
TEMP_DB="packablock_sandbox_e2e.sqlite"
TEMP_CHAIN="sandbox_packablock.yaml"

echo "🚀 Starting E2E Sandbox Integration Verification..."

# Cleanup traps
REGISTRY_PID=""
cleanup() {
  echo "🧹 Cleaning up temporary files and background processes..."
  if [ -n "$REGISTRY_PID" ]; then
    kill "$REGISTRY_PID" 2>/dev/null || true
  fi
  # Clean up temp DB in registry dir
  rm -f "$REGISTRY_DIR/$TEMP_DB" 2>/dev/null || true
  # Clean up temp chain in client dir
  rm -f "$CLIENT_DIR/$TEMP_CHAIN" 2>/dev/null || true
}
trap cleanup EXIT

# 1. Start Registry Server on PORT 4545
echo "⏱️  Spinning up local Registry Server on port $PORT..."
DATABASE_FILE="$TEMP_DB" PORT=$PORT bun --cwd "$REGISTRY_DIR" index.ts > /dev/null 2>&1 &
REGISTRY_PID=$!

# Wait for server to start
echo "🔍 Waiting for Registry health check to respond..."
for i in {1..20}; do
  if curl -s "$SERVER_URL/health" | grep -q "ok"; then
    echo "🟢 Registry Server is ready!"
    break
  fi
  if [ "$i" -eq 20 ]; then
    echo "❌ Registry Server failed to start."
    exit 1
  fi
  sleep 0.1
done

# 2. Register mock repository
echo "🔑 Registering repository 'sandbox/e2e-repo'..."
REGISTER_OUTPUT=$(bun --cwd "$CLIENT_DIR" ./index.ts register -s "$SERVER_URL" sandbox/e2e-repo)
echo "$REGISTER_OUTPUT"

# Extract registration token
TOKEN=$(echo "$REGISTER_OUTPUT" | grep -o 'pb_reg_[0-9a-fA-F]*')
if [ -z "$TOKEN" ]; then
  echo "❌ Failed to extract registration token from output."
  exit 1
fi
echo "🟢 Extracted Token: $TOKEN"

# 3. Initialize client chain log
echo "📦 Initializing client chain log..."
bun --cwd "$CLIENT_DIR" ./index.ts init -d "packages: {}" "$TEMP_CHAIN"

# 4. Append dependency state
echo "✍️  Appending new dependency block..."
bun --cwd "$CLIENT_DIR" ./index.ts append -d "packages: { lodash: '4.17.21' }" "$TEMP_CHAIN"

# 5. Push block attestations to registry
echo "📤 Pushing attestations to registry..."
bun --cwd "$CLIENT_DIR" ./index.ts push -s "$SERVER_URL" -t "$TOKEN" "$TEMP_CHAIN"

# 6. Verify remote anchoring and history
echo "🔍 Running check with remote anchorage cross-referencing..."
CHECK_OUTPUT=$(bun --cwd "$CLIENT_DIR" ./index.ts check -s "$SERVER_URL" -t "$TOKEN" -r "sandbox/e2e-repo" "$TEMP_CHAIN")
echo "$CHECK_OUTPUT"

if echo "$CHECK_OUTPUT" | grep -q "VERIFICATION PASSED"; then
  echo "🏆 E2E Sandbox Verification SUCCESS!"
else
  echo "❌ E2E Sandbox Verification FAILED!"
  exit 1
fi
