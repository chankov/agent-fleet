#!/bin/bash
# sdd-cache-pre.sh — PreToolUse hook for WebFetch
#
# Before every WebFetch, checks whether the target URL has a cached entry
# in .claude/sdd-cache/. If so, issues a conditional HEAD request with
# If-None-Match / If-Modified-Since. If the server responds 304 Not Modified,
# the hook blocks the WebFetch (exit 2) and returns the cached content to the
# agent via stderr. Otherwise it exits 0 and lets the fetch proceed.
#
# Freshness is verified by the origin server on every call, so the skill's
# "don't trust memory, verify against current docs" invariant still holds.
# The hook only serves content the server has just confirmed is unchanged.
#
# A 24h hard TTL acts as a safety net in case a server misreports freshness.
# Entries without ETag/Last-Modified are never cached, so nothing is served
# without a validator.
#
# Dependencies: jq, curl, shasum (or sha256sum)

set -euo pipefail

# Graceful degradation: if any dependency is missing, let the fetch through.
command -v jq   >/dev/null 2>&1 || exit 0
command -v curl >/dev/null 2>&1 || exit 0
command -v shasum >/dev/null 2>&1 || command -v sha256sum >/dev/null 2>&1 || exit 0

if [ -t 0 ]; then INPUT="{}"; else INPUT=$(cat); fi

# Debug logging: active when SDD_CACHE_DEBUG=1 is set, or when a sentinel
# file exists at .claude/sdd-cache/.debug. Toggle with `touch` / `rm`.
dbg() {
  local dir="${CLAUDE_PROJECT_DIR:-$PWD}/.claude/sdd-cache"
  [ "${SDD_CACHE_DEBUG:-0}" = "1" ] || [ -f "$dir/.debug" ] || return 0
  mkdir -p "$dir"
  printf '%s [pre]  %s\n' "$(date -u +%FT%TZ)" "$*" >> "$dir/.debug.log"
}
dbg "fired"

URL=$(printf '%s'    "$INPUT" | jq -r '.tool_input.url    // empty' 2>/dev/null || true)
PROMPT=$(printf '%s' "$INPUT" | jq -r '.tool_input.prompt // empty' 2>/dev/null || true)
if [ -z "$URL" ]; then dbg "no url in tool_input, exit"; exit 0; fi
dbg "url=$URL prompt=$(printf '%s' "$PROMPT" | head -c 80)"

# Cache key is (url + normalized prompt): WebFetch output is prompt-dependent,
# so the same URL with a different question must miss the cache. Prompt is
# normalized (lowercase + whitespace collapse) so stylistic variants like
# "Extract the signature" vs "extract   the\nsignature" hash to the same key.
# Semantically different prompts still differ.
normalize_prompt() {
  printf '%s' "$1" \
    | tr '[:upper:]' '[:lower:]' \
    | tr -s '[:space:]' ' ' \
    | sed -e 's/^ //' -e 's/ $//'
}

hash_key() {
  local norm
  norm=$(normalize_prompt "$2")
  local key="$1"$'\x1f'"$norm"
  if command -v shasum >/dev/null 2>&1; then
    printf '%s' "$key" | shasum -a 256 | cut -c1-32
  else
    printf '%s' "$key" | sha256sum | cut -c1-32
  fi
}

CACHE_DIR="${CLAUDE_PROJECT_DIR:-$PWD}/.claude/sdd-cache"
CACHE_FILE="$CACHE_DIR/$(hash_key "$URL" "$PROMPT").json"

if [ ! -f "$CACHE_FILE" ]; then dbg "no cache file at $CACHE_FILE, exit"; exit 0; fi
dbg "cache file exists: $CACHE_FILE"

# Hard TTL: 24h. If the entry is older, bypass the cache entirely.
FETCHED_AT=$(jq -r '.fetched_at // 0' "$CACHE_FILE" 2>/dev/null || echo 0)
NOW=$(date +%s)
AGE=$((NOW - FETCHED_AT))
if [ "$AGE" -gt 86400 ]; then
  dbg "entry older than 24h (age=${AGE}s), bypass"
  exit 0
fi

ETAG=$(jq -r '.etag // empty' "$CACHE_FILE" 2>/dev/null || true)
LAST_MOD=$(jq -r '.last_modified // empty' "$CACHE_FILE" 2>/dev/null || true)

# No validator means we cannot verify freshness — never serve from cache.
if [ -z "$ETAG" ] && [ -z "$LAST_MOD" ]; then
  dbg "cached entry has no etag/last-modified, cannot revalidate, bypass"
  exit 0
fi

HEADERS=()
[ -n "$ETAG" ]     && HEADERS+=(-H "If-None-Match: $ETAG")
[ -n "$LAST_MOD" ] && HEADERS+=(-H "If-Modified-Since: $LAST_MOD")

STATUS=$(curl -sI -o /dev/null -w "%{http_code}" \
  --max-time 5 -L \
  "${HEADERS[@]}" \
  "$URL" 2>/dev/null || echo "000")
dbg "revalidation HEAD status=$STATUS"

if [ "$STATUS" != "304" ]; then
  dbg "not 304, letting WebFetch proceed"
  exit 0
fi

# Server confirmed content unchanged. Serve cached copy to the agent.
CONTENT=$(jq -r '.content // empty' "$CACHE_FILE" 2>/dev/null || true)
if [ -z "$CONTENT" ]; then dbg "cache file has empty content field, bypass"; exit 0; fi
dbg "cache HIT, blocking WebFetch with ${#CONTENT} bytes of cached content"

VERIFIED_AT_ISO=$(date -u -r "$FETCHED_AT" +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null \
              || date -u -d "@$FETCHED_AT" +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null \
              || echo "unknown")

cat >&2 <<EOF
[sdd-cache] Cache hit for $URL

Freshness just verified via HTTP 304 Not Modified. The origin server
confirmed the content is unchanged since it was fetched at $VERIFIED_AT_ISO.
No new fetch is needed. Use the cached content below as if WebFetch had
just returned it:

----- BEGIN CACHED CONTENT -----
$CONTENT
----- END CACHED CONTENT -----
EOF
exit 2
