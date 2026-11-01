# ZIPPER completion release 20261101 — shared rules helpers (sourced by 30/31/32/39/41/49). bash 3.2 compatible.
# Holds NO deploy command: each script runs its own, exactly as written in it.

# rules_evidence <results-dir> <rules-file...>: the emulator results folder for the bundle must exist, hold
# RESULT.txt = PASS, be NEWER than every rules file about to be deployed and, when its SUMMARY.txt prints sha256
# lines, name the sha256 of the very files being deployed. Refuses otherwise.
rules_evidence() {
  local dir="$1"; shift
  [ -n "$dir" ] && [ -d "$dir" ] || stop "emulator results folder not found: '${dir:-none}' — run the bundle's rules suites on the Mac first"
  [ "$(cat "$dir/RESULT.txt" 2>/dev/null | tr -d '[:space:]')" = PASS ] || stop "$dir/RESULT.txt is not PASS"
  local f sha
  for f in "$@"; do
    [ "$dir/RESULT.txt" -nt "$f" ] || stop "$(basename "$dir") is older than $f — re-run the emulator suites on the exact text"
    sha="$(shasum -a 256 "$f" | cut -c1-64)"
    if grep -q 'sha256' "$dir/SUMMARY.txt" 2>/dev/null; then
      grep -q "$sha" "$dir/SUMMARY.txt" || stop "$(basename "$dir")/SUMMARY.txt does not name the sha256 of $f ($sha)"
    fi
  done
  check ok "emulator evidence $(basename "$dir"): PASS, newer than the rules text, hashes match"
}

# newest_results <bundle-dir>: the newest results-<UTC> folder inside a bundle folder (empty if none).
newest_results() {
  ls -d "$1"/results-*Z 2>/dev/null | LC_ALL=C sort | tail -1
}

# save_live_rules <firestore|storage> <out-prefix>: the LIVE ruleset text (read-only, backend verifier credential)
# saved as <out-prefix>.rules with <out-prefix>.rules.sha256 beside it — what 39/49 re-release. Sets LIVE_SHA.
save_live_rules() {
  local kind="$1" prefix="$2"
  venv_env
  [ -x "$VENV_PY" ] || stop "$VENV_PY not found (needed to save the live rules text before changing it)"
  ( cd "$REPO/backend" && $VENV_ENV "$VENV_PY" "$HERE/tools/live_rules.py" get "$kind" "$prefix.rules" ) > "$prefix.txt" 2>>"$ERR" || stop "could not read the live $kind rules (see $(basename "$prefix").txt and stderr.log)"  #RO
  LIVE_SHA="$(sed -n 's/^LIVE-SHA //p' "$prefix.txt")"
  [ -n "$LIVE_SHA" ] && [ "$(shasum -a 256 "$prefix.rules" | cut -c1-64)" = "$LIVE_SHA" ] || stop "the saved live $kind text does not hash to what the API reported"
  printf '%s  %s\n' "$LIVE_SHA" "$(basename "$prefix").rules" > "$prefix.rules.sha256"
  say "   live $kind: $(sed -n 's/^LIVE-RULESET /ruleset /p' "$prefix.txt") updated $(sed -n 's/^LIVE-UPDATED //p' "$prefix.txt") sha256 $LIVE_SHA (saved: $(basename "$prefix").rules)"
}

# verify_live_rules <firestore|storage> <expected-file>: after a release, the live text must equal the file.
verify_live_rules() {
  local kind="$1" file="$2" want got
  want="$(shasum -a 256 "$file" | cut -c1-64)"
  save_live_rules "$kind" "$OUT/live-$kind-after"
  got="$LIVE_SHA"
  [ "$got" = "$want" ] && check ok "live $kind rules = $(basename "$file") ($want)" || check "live $got" "live $kind rules = $(basename "$file") ($want)"
}

# rules_workdir <firebase.json text> <file...>: a temp deploy folder holding ONLY the chosen files and a generated
# firebase.json, so nothing else (functions, hosting, the other rules) can be deployed from there.
rules_workdir() {
  local cfg="$1"; shift
  WS="$OUT/deploy-workdir"; mkdir -p "$WS" && chmod 700 "$WS" || exit 2
  local f
  for f in "$@"; do cp "$f" "$WS/$(basename "$f")" || stop "could not copy $f"; done
  printf '%s\n' "$cfg" > "$WS/firebase.json"
  say "   deploy folder: $WS ($(ls "$WS" | tr '\n' ' '))"
}

# require_backend_serving_new: the completion backend revision (11) serves 100% (the rc2 rules and CRM need it).
require_backend_serving_new() {
  [ -f "$STATE_BACKEND" ] || stop "$STATE_BACKEND does not exist (the completion backend is not deployed)"
  local new now
  new="$(sed -n 's/^name=//p' "$STATE_BACKEND" | head -1)"
  now="$(split_now status)"
  [ "$now" = "$new=100" ] || stop "the backend serving 100% is '$now', not the completion revision $new (finish the canary first)"
  check ok "backend serving 100% = completion revision $new"
}

# require_crm_live: the new CRM is live (50 recorded its Hosting version) and still the live version.
require_crm_live() {
  [ -f "$STATE_CRM" ] || stop "$STATE_CRM does not exist (run 50 first: the MFA CRM must be live before these rules)"
  local want
  want="$(sed -n 's/^version=//p' "$STATE_CRM" | head -1)"
  hosting_live "$OUT/hosting.txt"
  grep -q "version=$want" "$OUT/hosting.txt" || stop "the live Hosting version is not the recorded CRM ($want): $(cat "$OUT/hosting.txt")"
  [ "$want" != "$OLD_CRM_VERSION" ] || stop "the recorded CRM version is the 20 Oct one"
  check ok "MFA CRM live as Hosting version $want"
}
