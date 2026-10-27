#!/usr/bin/env bash
# Report new upstream Claude Code issues that touch the surfaces this extension
# calls: the environment in `buildChildEnv`, the stream-json fields the provider
# reads, the flags in `buildArgv`, and the billing identity label.
#
# GitHub search normalizes hyphens and underscores, so a search hit is only a
# recall step. Relevance is decided on the raw title and body: either a literal
# identifier this repository depends on, or a broad surface next to a metering
# word.
#
# Findings accumulate as comments on one tracking issue. That issue's body holds
# a JSON block with the last scan date and the numbers already reported, so a
# rerun or an overlapping window never repeats an item.

set -euo pipefail

UPSTREAM_REPO="${UPSTREAM_REPO:-anthropics/claude-code}"
TRACKER_REPO="${TRACKER_REPO:-${GH_REPO:?set GH_REPO or TRACKER_REPO to the repository that holds the tracking issue}}"
STATE_TITLE="${STATE_TITLE:-Upstream Claude Code watch}"
DRY_RUN="${DRY_RUN:-0}"
LOOKBACK_DAYS="${LOOKBACK_DAYS:-30}"
SEEN_LIMIT="${SEEN_LIMIT:-400}"
MAX_CANDIDATES="${MAX_CANDIDATES:-250}"
MAX_REPORTED="${MAX_REPORTED:-15}"
FIRST_RUN_MAX_REPORTED="${FIRST_RUN_MAX_REPORTED:-60}"
CLI_PACKAGE="${CLI_PACKAGE:-@anthropic-ai/claude-code}"
CLI_RANGE_SOURCE="${CLI_RANGE_SOURCE:-src/models.ts}"

# Identifiers this repository writes or reads. Rare enough to stand alone.
GATE_TOKENS=(
  cc_entrypoint
  x-anthropic-billing-header
  claude_code_sdk
  CLAUDE_CODE_EXTRA_BODY
  CLAUDE_CODE_PROMPT_CACHE_TTL
  CLAUDE_CODE_TOTAL_TOKENS_REMINDER
  isUsingOverage
  unifiedWindows
)

# Broad surfaces. Reported only when the same issue also discusses metering.
BROAD_PATTERN='sdk-cli|sdk-ts|sdk-py|claude_code_sdk|agent sdk|claude -p|headless'
IMPACT_PATTERN='usage.?limit|weekly limit|five.?hour|quota|overage|rate.?limit|allowance|utilization|session limit'
# The broad tier also catches surface reports from other Claude clients. Those
# do not describe how this transport is metered, so they stay out of it.
OFF_SURFACE_PATTERN='desktop|vs ?code|visual studio|cowork|slack|teams|mobile|web app'

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

shift_date() { # $1 = YYYY-MM-DD, $2 = signed day offset
  if date -u -d 1970-01-01 +%F >/dev/null 2>&1; then
    date -u -d "$1 $2 days" +%F
  else
    date -u -j -f %F -v"${2}d" "$1" +%F
  fi
}

matches() { # $1 = extended regex, $2 = text
  grep -Eiq -- "$1" <<<"$2"
}

state_body() { # $1 = state JSON
  cat <<BODY
Upstream issues that touch the surfaces this extension depends on. Automation
appends findings as comments and keeps its progress in the marker below.

<!-- upstream-watch-state $1 -->
BODY
}

# --- state ------------------------------------------------------------------

find_tracker() {
  STATE_TITLE="$STATE_TITLE" gh issue list --repo "$TRACKER_REPO" --state open --limit 50 \
    --search "in:title \"$STATE_TITLE\"" --json number,title \
    --jq '.[] | select(.title == env.STATE_TITLE) | .number' | head -1 || true
}

issue_number="$(find_tracker)"
state='{"lastScan":"","seen":[],"lastCliVersion":""}'
if [[ -n "$issue_number" ]]; then
  gh issue view "$issue_number" --repo "$TRACKER_REPO" --json body --jq .body >"$TMP/body.md"
  extracted="$(sed -n 's/.*<!-- upstream-watch-state \(.*\) -->.*/\1/p' "$TMP/body.md" | head -1)"
  if [[ -z "$extracted" ]]; then
    # Without the marker the scan would start from scratch and repeat every
    # report already posted on that issue.
    echo "tracker issue $TRACKER_REPO#$issue_number has no state marker; refusing to scan" >&2
    exit 1
  fi
  state="$extracted"
fi
last_scan="$(jq -r '.lastScan // ""' <<<"$state")"
last_cli="$(jq -r '.lastCliVersion // ""' <<<"$state")"
seen_json="$(jq -c '(.seen // []) | map(tonumber)' <<<"$state")"

if [[ -n "$last_scan" ]]; then
  since="$(shift_date "${last_scan:0:10}" -1)"
else
  # First run: no prior report, so one longer window and a raised report cap.
  since="$(shift_date "$(date -u +%F)" "-$LOOKBACK_DAYS")"
  (( FIRST_RUN_MAX_REPORTED > MAX_REPORTED )) && MAX_REPORTED="$FIRST_RUN_MAX_REPORTED"
fi

# --- scan -------------------------------------------------------------------

scan() { # $1 = extra search terms, $2 = tier
  gh api -X GET search/issues --paginate \
    -f q="repo:$UPSTREAM_REPO is:issue updated:>=$since $1" \
    -f per_page=50 -f sort=updated -f order=desc \
    --jq ".items[] | {number, title, tier: \"$2\"}"
  # A failed search must stop the run. Silently continuing would report an
  # incomplete scan as a complete one.
}

: >"$TMP/candidates.jsonl"
for token in "${GATE_TOKENS[@]}"; do
  scan "\"$token\"" A >>"$TMP/candidates.jsonl"
done
for terms in '"sdk-cli" usage' '"Agent SDK" usage' '"claude -p" limit'; do
  scan "$terms" B >>"$TMP/candidates.jsonl"
done

jq -s --argjson seen "$seen_json" '
  map(select(.number != null))
  | group_by(.number)
  | map(sort_by(.tier) | .[0])
  | map(select(.number as $n | ($seen | index($n)) | not))
  | sort_by(.tier, -.number)
' "$TMP/candidates.jsonl" >"$TMP/pending.json"
pending_total="$(jq 'length' "$TMP/pending.json")"
jq ".[0:$MAX_CANDIDATES]" "$TMP/pending.json" >"$TMP/window.json"
dropped_by_cap=$(( pending_total - $(jq 'length' "$TMP/window.json") ))

# --- classify ---------------------------------------------------------------

: >"$TMP/findings.tsv"
while IFS=$'\t' read -r number tier title; do
  text="$(gh api "repos/$UPSTREAM_REPO/issues/$number" --jq '(.title // "") + "\n" + (.body // "")')"
  tokens=""
  for token in "${GATE_TOKENS[@]}"; do
    if matches "$token" "$text"; then
      tokens+="${tokens:+,}$token"
    fi
  done
  if [[ -n "$tokens" ]]; then
    printf '%s\tA\t%s\t%s\n' "$number" "$tokens" "$title" >>"$TMP/findings.tsv"
  elif matches "$BROAD_PATTERN" "$text" && matches "$IMPACT_PATTERN" "$text" &&
    ! matches "$OFF_SURFACE_PATTERN" "$title"; then
    printf '%s\tB\t%s\t%s\n' "$number" - "$title" >>"$TMP/findings.tsv"
  fi
done < <(jq -r '.[] | [.number, .tier, (.title | gsub("[\t\n]"; " "))] | @tsv' "$TMP/window.json")

# --- release check ----------------------------------------------------------

cli_range=""
if [[ -f "$CLI_RANGE_SOURCE" ]]; then
  cli_range="$(grep -o 'QUALIFIED_CLI_RANGE = "[^"]*"' "$CLI_RANGE_SOURCE" | sed 's/.*= "//; s/"$//')"
fi
latest_cli="$(curl -fsS "https://registry.npmjs.org/$CLI_PACKAGE/latest" 2>/dev/null | jq -r '.version // ""' || true)"
release_line=""
if [[ -n "$latest_cli" && "$latest_cli" != "$last_cli" ]]; then
  if [[ -n "$cli_range" ]]; then
    upper="$(sed 's/.*<//' <<<"$cli_range")"
    lower="$(sed 's/.*>=\([0-9.]*\).*/\1/' <<<"$cli_range")"
    if [[ "$(printf '%s\n%s\n' "$upper" "$latest_cli" | sort -V | tail -1)" == "$latest_cli" ]] ||
      [[ "$(printf '%s\n%s\n' "$lower" "$latest_cli" | sort -V | head -1)" == "$latest_cli" && "$latest_cli" != "$lower" ]]; then
      release_line="- npm publication of \`$CLI_PACKAGE\` is at \`$latest_cli\`, outside the qualified range \`$cli_range\`. Re-verify before widening the range."
    else
      release_line="- npm publication of \`$CLI_PACKAGE\` is at \`$latest_cli\`, inside the qualified range \`$cli_range\`."
    fi
  else
    release_line="- npm publication of \`$CLI_PACKAGE\` is at \`$latest_cli\`; the qualified range could not be read from \`$CLI_RANGE_SOURCE\`."
  fi
fi

# --- report -----------------------------------------------------------------

total_findings="$(awk -F'\t' 'NF' "$TMP/findings.tsv" | wc -l | tr -d ' ')"
reported=()
emit_rows() { # $1 = matching rows of findings.tsv
  local rows="$1"
  [[ -z "$rows" ]] && return 0
  while IFS=$'\t' read -r number _tier tokens title; do
    (( ${#reported[@]} >= MAX_REPORTED )) && return 0
    (( ${#reported[@]} )) && [[ " ${reported[*]} " == *" $number "* ]] && continue
    printf -- '- [#%s](https://github.com/%s/issues/%s) `%s` %s\n' \
      "$number" "$UPSTREAM_REPO" "$number" "$tokens" "$title"
    reported+=("$number")
  done <<<"$rows"
}

{
  echo "Scan on $(date -u +%F) found $total_findings new item(s) since \`$since\`."
  echo
  if findings_a="$(awk -F'\t' '$2=="A"' "$TMP/findings.tsv")" && [[ -n "$findings_a" ]]; then
    echo "### Extension surface"
    emit_rows "$findings_a"
    echo
  fi
  if findings_b="$(awk -F'\t' '$2=="B"' "$TMP/findings.tsv")" && [[ -n "$findings_b" ]]; then
    echo "### Headless usage and limits"
    emit_rows "$findings_b"
    echo
  fi
  if [[ -n "$release_line" ]]; then
    echo "### Claude Code release"
    echo "$release_line"
    echo
  fi
  skipped=$(( total_findings - ${#reported[@]} ))
  if (( skipped > 0 )); then
    echo "_$skipped matching item(s) were not listed. Search the upstream tracker manually if that matters._"
    echo
  fi
  if (( dropped_by_cap > 0 )); then
    echo "_$dropped_by_cap candidate(s) fell outside the $MAX_CANDIDATES-item scan window._"
    echo
  fi
  echo "Listed items are recorded below and are not reported again."
} >"$TMP/comment.md"

reported_json="$(printf '%s\n' "${reported[@]+"${reported[@]}"}" | jq -R 'select(length>0) | tonumber' | jq -s -c 'unique')"
new_seen="$(jq -c -n --argjson seen "$seen_json" --argjson reported "$reported_json" \
  --argjson limit "$SEEN_LIMIT" '($seen + $reported | unique | sort) as $all | $all | .[-$limit:]' <<<"null")"
new_state="$(jq -c -n --arg lastScan "$(date -u +%F)" --arg lastCliVersion "${latest_cli:-$last_cli}" \
  --argjson seen "$new_seen" '{lastScan: $lastScan, seen: $seen, lastCliVersion: $lastCliVersion}')"

if (( ${#reported[@]} == 0 )) && [[ -z "$release_line" ]]; then
  echo "No new findings since $since."
  if [[ "$DRY_RUN" != "1" && -n "$issue_number" ]]; then
    gh issue edit "$issue_number" --repo "$TRACKER_REPO" --body "$(state_body "$new_state")" >/dev/null
  fi
  exit 0
fi

if [[ "$DRY_RUN" == "1" ]]; then
  echo "--- comment ---"
  cat "$TMP/comment.md"
  echo "--- state ---"
  echo "$new_state"
  exit 0
fi

if [[ -z "$issue_number" ]]; then
  gh issue create --repo "$TRACKER_REPO" --title "$STATE_TITLE" --body "$(state_body "$new_state")" >/dev/null
  issue_number="$(find_tracker)"
fi

gh issue comment "$issue_number" --repo "$TRACKER_REPO" --body-file "$TMP/comment.md" >/dev/null
gh issue edit "$issue_number" --repo "$TRACKER_REPO" --body "$(state_body "$new_state")" >/dev/null
echo "Reported ${#reported[@]} item(s) on $TRACKER_REPO issue $issue_number."
