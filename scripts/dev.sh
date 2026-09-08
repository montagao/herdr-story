#!/usr/bin/env bash
# Runs the bridge and the vite dev server together. Pass --mock to fake agents.
set -euo pipefail
cd "$(dirname "$0")/.."
command -v bun >/dev/null 2>&1 || { echo "Install Bun first: https://bun.sh" >&2; exit 1; }

TAILSCALE=0
BRIDGE_ARGS=()
for arg in "$@"; do
  if [[ "$arg" == "--tailscale" ]]; then TAILSCALE=1
  else BRIDGE_ARGS+=("$arg")
  fi
done

if (( TAILSCALE )); then
  command -v tailscale >/dev/null 2>&1 || { echo "tailscale is not installed: https://tailscale.com/download" >&2; exit 1; }
  tailscale status >/dev/null 2>&1 || { echo "tailscale is not connected; run: sudo tailscale up" >&2; exit 1; }
  # Remote clients get the production bundle: one optimized module instead of Vite's large graph
  # of development requests. The bridge already serves dist and handles /ws itself.
  # Permit this exact private HTTPS origin through the bridge's browser access checks.
  tailnet_name=$(tailscale status --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const n=JSON.parse(s).Self?.DNSName?.replace(/\.$/,"");if(!n)process.exit(1);process.stdout.write(n)})')
  export HERDR_STORY_ALLOWED_ORIGINS="${HERDR_STORY_ALLOWED_ORIGINS:+$HERDR_STORY_ALLOWED_ORIGINS,}https://$tailnet_name"
  npm run build
fi

bun bridge/server.ts "${BRIDGE_ARGS[@]}" & B=$!
if (( TAILSCALE )); then
  cleanup() { kill "$B" 2>/dev/null || true; wait "$B" 2>/dev/null || true; }
  trap cleanup EXIT
  ready=0
  for _ in {1..80}; do
    if curl -fsS http://127.0.0.1:7788/health >/dev/null 2>&1; then ready=1; break; fi
    kill -0 "$B" 2>/dev/null || break
    sleep 0.25
  done
  (( ready )) || { echo "Herdr Story did not start on http://127.0.0.1:7788" >&2; exit 1; }
  echo "[tailscale] sharing herdr story with your tailnet (not the public internet)"
  tailscale serve 7788
else
  trap 'kill $B 2>/dev/null' EXIT
  npx vite
fi
