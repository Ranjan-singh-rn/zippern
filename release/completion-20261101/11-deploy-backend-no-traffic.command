#!/bin/bash
# ZIPPER completion release — 11: build and deploy the backend at the release HEAD as a NEW Cloud Run revision with
# 0% traffic, smoke-test it on its tag URL, send ONE observer-code e-mail from it, then remove the tag.
# Production changes, each only after you type its word:
#   DEPLOY — Cloud Build builds backend/ exactly as committed at HEAD (Dockerfile base pinned by digest,
#            requirements.lock, .gcloudignore); a new revision of zipper-api is created at 0% with the tag
#            completion-<short-commit>, built on the CURRENT SERVICE TEMPLATE (the Owner-MFA key revision:
#            OWNER_MFA_REQUIRED=false and OWNER_MFA_ENCRYPTION_KEY:1 are inherited) plus exactly:
#              --update-secrets SENDGRID_API_KEY=ZIPPER_SENDGRID_API_KEY:1
#              --update-env-vars EMAIL_PROVIDER=sendgrid,SENDGRID_FROM_EMAIL=no-reply@zipperlive.org,"SENDGRID_FROM_NAME=ZIPPER Live"
#            Every other new setting of app/config.py keeps its code default (none is required). At start-up the
#            revision runs ensure_indexes() on MongoDB (index DDL, idempotent).
#   (auto)   if traffic moved at all, it is pinned straight back to the serving revision by NAME.
#   EMAIL  — one POST <tag-url>/api/auth/observer/request-code: one sign-in code goes to the delivery mailbox.
#   UNTAG  — the tag is removed (the revision keeps 0% and stays for the canary, 12).
# Refuses if: the tree is dirty or not at RELEASE.txt's HEAD; traffic is not exactly 100% on one revision; the
# template's environment differs from the serving revision by anything but the two Owner-MFA names; the backend
# identity lacks the grants (10); an upload file is not committed or carries a forbidden name; backend-revision.txt
# already exists. Never --to-latest. Results: ./production/11-deploy-backend-<UTC>/ and ./production/backend-revision.txt
set -u
umask 077
. "$(dirname "$0")/rel_common.sh"
verify_scripts
new_out 11-deploy-backend
need_tools gcloud curl python3 git shasum tar

say "ZIPPER completion release — 11 backend no-traffic deploy   $TS"
who
require_release
[ -e "$STATE_BACKEND" ] && stop "$STATE_BACKEND already exists (a previous deploy of this release). Review it; move it aside only on purpose."
TAG="completion-$HEAD_SHORT"
printf '%s' "$TAG" | grep -Eq '^completion-[0-9a-f]{7}$' || stop "bad tag $TAG"

# ── 1. Read-only gate ───────────────────────────────────────────────────────────────────────────────
say ""; say "== 1. Pre-deploy gate (read-only)"
service_state "$OUT/service-before.txt"
grep -vE '^ENV ' "$OUT/service-before.txt" | sed 's/^/   /' | tee -a "$OUT/SUMMARY.txt"
SPLIT="$(sed -n 's/^TRAFFIC status //p' "$OUT/service-before.txt")"
SERVING="${SPLIT%=100}"
printf '%s' "$SERVING" | grep -Eq '^zipper-api-[0-9]{5}-[a-z0-9]{3}$' && [ "$SPLIT" = "$SERVING=100" ] || stop "traffic is not exactly 100% on one revision ($SPLIT)"
[ "$SERVING" != "$RETIRED_REV" ] || stop "the retired revision is serving"
[ "$(sed -n 's/^TRAFFIC spec //p' "$OUT/service-before.txt")" = "$SPLIT" ] || stop "spec traffic differs from status traffic"
check ok "traffic is 100% on $SERVING (spec and status, pinned by name)"
[ "$SERVING" = "$EXPECT_SERVING" ] && check ok "serving revision is the expected $EXPECT_SERVING" || say "   note: serving revision is $SERVING, not $EXPECT_SERVING (a previous step of this release moved traffic)"
grep -q "^TEMPLATE sa=$BACKEND_SA " "$OUT/service-before.txt" && check ok "template runs as $BACKEND_SA" || stop "template service account differs"
TEMPLATE_REV="$(sed -n 's/^LATEST created=\([^ ]*\) .*/\1/p' "$OUT/service-before.txt")"
say "   latest created revision (template): $TEMPLATE_REV"
revision_state "$OUT/revision-serving.txt" "$SERVING"
grep '^ENV ' "$OUT/service-before.txt" | sort > "$OUT/env-template.txt"
grep '^ENV ' "$OUT/revision-serving.txt" | sort > "$OUT/env-serving.txt"
$H env-diff "$OUT/env-serving.txt" "$OUT/env-template.txt" > "$OUT/env-diff-template.txt"
sed 's/^/   template vs serving: /' "$OUT/env-diff-template.txt" | tee -a "$OUT/SUMMARY.txt"
EXTRA="$(grep -vE '^(\+ ENV OWNER_MFA_REQUIRED \(plain\)|\+ ENV OWNER_MFA_ENCRYPTION_KEY <- secret OWNER_MFA_ENCRYPTION_KEY:1|DIFF )' "$OUT/env-diff-template.txt" | grep -c .)"
[ "$EXTRA" = 0 ] || stop "the template's environment differs from the serving revision by more than the two Owner-MFA names (env-diff-template.txt)"
check ok "template = serving revision + OWNER_MFA_REQUIRED + OWNER_MFA_ENCRYPTION_KEY:1 (names only)"
grep -q "^ENV OWNER_MFA_ENCRYPTION_KEY <- secret $MFA_SECRET:1\$" "$OUT/env-template.txt" || stop "the template does not carry $MFA_SECRET:1 (Observer TOTP needs it)"

gcloud secrets versions list "$SG_SECRET" --project "$P" --format=json 2>>"$ERR" | $H versions - > "$OUT/secret-versions.txt"  #RO
[ "$(sed -n 's/^ENABLED //p' "$OUT/secret-versions.txt")" -ge 1 ] 2>/dev/null || stop "$SG_SECRET has no enabled version"
gcloud secrets get-iam-policy "$SG_SECRET" --project "$P" --format=json 2>>"$ERR" | $H iam - > "$OUT/secret-iam.txt"  #RO
grep -q "^BINDING roles/secretmanager.secretAccessor serviceAccount:$BACKEND_SA\$" "$OUT/secret-iam.txt" || stop "the backend identity is not granted on $SG_SECRET (run 10 first)"
check ok "backend identity granted on $SG_SECRET; an enabled version exists"
gcloud secrets get-iam-policy "$MFA_SECRET" --project "$P" --format=json 2>>"$ERR" | $H iam - > "$OUT/mfa-secret-iam.txt"  #RO
grep -q "^BINDING roles/secretmanager.secretAccessor serviceAccount:$BACKEND_SA\$" "$OUT/mfa-secret-iam.txt" || stop "the backend identity is not granted on $MFA_SECRET"
check ok "backend identity granted on $MFA_SECRET"

# ── 2. The source: backend/ exactly as committed at HEAD ────────────────────────────────────────────
say ""; say "== 2. Source tree (committed content only)"
SRC="$OUT/deploy/backend"; mkdir -p "$OUT/deploy" || exit 2
( git -C "$REPO" archive --format=tar HEAD backend | tar -x -C "$OUT/deploy" ) 2>>"$ERR" || stop "git archive of backend/ failed"
for f in Dockerfile requirements.lock requirements.txt .gcloudignore app/main.py app/config.py; do [ -f "$SRC/$f" ] || stop "$SRC/$f missing"; done
BASE_LINE="$(grep -m1 '^FROM ' "$SRC/Dockerfile")"
printf '%s' "$BASE_LINE" | grep -q '@sha256:[0-9a-f]\{64\}' && check ok "Dockerfile base image pinned by digest ($(printf '%s' "$BASE_LINE" | sed 's/^FROM //' | cut -c1-40)…)" || check "$BASE_LINE" "Dockerfile base image pinned by digest"
BASE_DIGEST="$(printf '%s' "$BASE_LINE" | sed -n 's/.*@\(sha256:[0-9a-f]*\).*/\1/p')"
grep -q 'pip install .*--no-deps .*requirements.lock' "$SRC/Dockerfile" && grep -q 'pip check' "$SRC/Dockerfile" && check ok "Dockerfile installs requirements.lock with --no-deps and runs pip check" || check "differs" "Dockerfile installs requirements.lock with --no-deps and runs pip check"
NLOCK="$(grep -vE '^\s*(#|$)' "$SRC/requirements.lock" | grep -c '==')"
say "   requirements.lock: $NLOCK pinned packages"
( cd "$SRC" && gcloud meta list-files-for-upload . 2>>"$ERR" ) | sed -e 's|^\./||' | LC_ALL=C sort > "$OUT/upload-files.txt"  #RO
$H tree-list "$REPO" HEAD backend | sed 's#^\([0-9a-f]*\)  backend/#\1  #' > "$OUT/tracked-backend.txt"
$H upload-check "$OUT/upload-files.txt" "$OUT/tracked-backend.txt" > "$OUT/upload-check.txt"
sed 's/^/   /' "$OUT/upload-check.txt" | tee -a "$OUT/SUMMARY.txt"
grep -q ' ok$' "$OUT/upload-check.txt" || stop "the upload set is not exactly committed, allowed files (upload-check.txt)"
UPLOAD_TREE="$(cd "$SRC" && while IFS= read -r f; do [ -f "$f" ] && printf './%s\0' "$f"; done < "$OUT/upload-files.txt" | LC_ALL=C sort -z | xargs -0 shasum -a 256 | shasum -a 256 | cut -c1-64)"
NFILES="$(grep -c . "$OUT/upload-files.txt")"
say "   upload set: $NFILES files, tree $UPLOAD_TREE"
check ok "every uploaded file is committed at HEAD; no .env, key or keystore in the upload"

gcloud artifacts repositories describe cloud-run-source-deploy --location "$REGION" --project "$P" --format='value(name)' > /dev/null 2>>"$ERR" \
  && check ok "repository cloud-run-source-deploy present" || check "missing" "repository cloud-run-source-deploy present"  #RO
APIS="$(gcloud services list --enabled --project "$P" --format='value(config.name)' 2>>"$ERR")"  #RO
MISSING=""; for A in run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com secretmanager.googleapis.com; do printf '%s\n' "$APIS" | grep -qx "$A" || MISSING="$MISSING $A"; done
[ -z "$MISSING" ] && check ok "required APIs enabled" || check "missing:$MISSING" "required APIs enabled"
[ "$FAILS" = 0 ] || stop "$FAILS gate check(s) failed. Nothing was deployed."

# ── 3. The reviewed deploy ──────────────────────────────────────────────────────────────────────────
confirm DEPLOY "build backend/ at HEAD $HEAD_SHORT and create a NEW zipper-api revision at 0% traffic, tag $TAG, from the template $TEMPLATE_REV plus the SendGrid settings (no other change)"
say "== 3. Deploy (started $(date -u +%H:%M:%SZ))"
( cd "$SRC" && gcloud run deploy zipper-api --project zipper-83816 --region asia-south1 --source . --no-traffic --tag "$TAG" --update-secrets SENDGRID_API_KEY=ZIPPER_SENDGRID_API_KEY:1 --update-env-vars EMAIL_PROVIDER=sendgrid,SENDGRID_FROM_EMAIL=no-reply@zipperlive.org,"SENDGRID_FROM_NAME=ZIPPER Live" ) > "$OUT/deploy-output.txt" 2>&1  #MUT-DEPLOY-BACKEND
DEPLOY_RC=$?
tail -12 "$OUT/deploy-output.txt" | sed 's/^/   | /' | tee -a "$OUT/SUMMARY.txt"
say "deploy exit code: $DEPLOY_RC (finished $(date -u +%H:%M:%SZ))"

# ── 4. Traffic safety net ───────────────────────────────────────────────────────────────────────────
say ""; say "== 4. Traffic"
service_state "$OUT/service-after.txt"
AFTER="$(sed -n 's/^TRAFFIC status //p' "$OUT/service-after.txt")"
if [ "$AFTER" != "$SPLIT" ]; then
  say "TRAFFIC MOVED ($AFTER): pinning back to $SERVING=100 now"
  gcloud run services update-traffic zipper-api --project zipper-83816 --region asia-south1 --to-revisions "$SERVING=100" > "$OUT/pin-back.txt" 2>&1  #MUT-PIN-BACK
  say "pin-back exit code: $?"
  service_state "$OUT/service-after.txt"
  check "traffic had moved; pinned back" "production traffic stayed on $SERVING"
else
  check ok "production traffic unchanged: $AFTER"
fi
[ $DEPLOY_RC -eq 0 ] && check ok "gcloud run deploy exit 0" || check "exit $DEPLOY_RC" "gcloud run deploy"
NEW="$(sed -n 's/^LATEST created=\([^ ]*\) .*/\1/p' "$OUT/service-after.txt")"
say "latest created revision: ${NEW:-unknown}"
if [ -z "$NEW" ] || [ "$NEW" = "$TEMPLATE_REV" ] || [ "$NEW" = "$SERVING" ]; then
  check "no new revision" "a new revision was created"
  finish "nothing to roll back: traffic unchanged"
fi
check ok "new revision $NEW"
TAGS="$(sed -n 's/^TAGS //p' "$OUT/service-after.txt")"
case ",$TAGS," in *",$TAG=$NEW,"*) check ok "tag $TAG -> $NEW";; *) check "$TAGS" "tag $TAG -> $NEW";; esac

# ── 5. Read-only verification of the new revision ───────────────────────────────────────────────────
say ""; say "== 5. Verification (read-only)"
revision_state "$OUT/revision-new.txt" "$NEW" EMAIL_PROVIDER=sendgrid SENDGRID_FROM_EMAIL=no-reply@zipperlive.org "SENDGRID_FROM_NAME=ZIPPER Live" OWNER_MFA_REQUIRED=false
grep -vE '^ENV ' "$OUT/revision-new.txt" | sed 's/^/   /' | tee -a "$OUT/SUMMARY.txt"
REVLINE="$(grep '^REV ' "$OUT/revision-new.txt")"
case "$REVLINE" in *" ready=True active=True "*) check ok "new revision Ready and Active";; *) check "see revision-new.txt" "new revision Ready and Active";; esac
case "$REVLINE" in *" sa=$BACKEND_SA") check ok "service account unchanged";; *) check "differs" "service account unchanged";; esac
DIG="$(printf '%s' "$REVLINE" | sed -n 's/.* digest=\([^ ]*\) .*/\1/p')"
grep '^ENV ' "$OUT/revision-new.txt" | sort > "$OUT/env-new.txt"
{ grep -v '^ENV SENDGRID_API_KEY ' "$OUT/env-template.txt"
  echo "ENV SENDGRID_API_KEY <- secret ZIPPER_SENDGRID_API_KEY:1"
  echo "ENV EMAIL_PROVIDER (plain)"; echo "ENV SENDGRID_FROM_EMAIL (plain)"; echo "ENV SENDGRID_FROM_NAME (plain)"; } | sort > "$OUT/env-expected.txt"
if diff "$OUT/env-expected.txt" "$OUT/env-new.txt" > "$OUT/env-unexpected.txt"; then
  check ok "environment = template + SENDGRID_API_KEY->ZIPPER_SENDGRID_API_KEY:1 + EMAIL_PROVIDER/SENDGRID_FROM_EMAIL/SENDGRID_FROM_NAME ($(grep -c . "$OUT/env-new.txt") names)"
else
  sed 's/^/   env: /' "$OUT/env-unexpected.txt" | tee -a "$OUT/SUMMARY.txt"; check "see env-unexpected.txt" "environment names exactly as expected"
fi
for v in EMAIL_PROVIDER SENDGRID_FROM_EMAIL SENDGRID_FROM_NAME OWNER_MFA_REQUIRED; do
  grep -q "^VALUE $v expected$" "$OUT/revision-new.txt" && check ok "$v has the reviewed value" || check "$(grep "^VALUE $v " "$OUT/revision-new.txt")" "$v has the reviewed value"
done
if [ -n "$DIG" ] && [ "$DIG" != "?" ]; then
  BID="$(gcloud builds list --project "$P" --region "$REGION" --filter="results.images.digest:\"$DIG\"" --format='value(id)' --limit 1 2>>"$ERR")"  #RO
  say "   image digest $DIG   build ${BID:-not found}"
  if [ -n "$BID" ]; then
    gcloud builds log "$BID" --project "$P" --region "$REGION" 2>>"$ERR" \
      | grep -E 'Step [0-9]+/[0-9]+|FROM |Digest: sha256|Successfully installed|No broken requirements found|has requirement|ERROR' > "$OUT/build-log-filtered.txt"  #RO
    grep -qF "$BASE_DIGEST" "$OUT/build-log-filtered.txt" && check ok "build used the pinned base image" || check "not seen" "build used the pinned base image"
    grep -q 'No broken requirements found' "$OUT/build-log-filtered.txt" && check ok "pip check passed in the build" || check "not seen" "pip check passed in the build"
    LOCKCMP="$(python3 -I - "$SRC/requirements.lock" "$OUT/build-log-filtered.txt" <<'PY'
import re, sys
norm = lambda n: re.sub(r"[-_.]+", "-", n).lower()
want = set()
for line in open(sys.argv[1], encoding="utf-8"):
    line = line.split("#", 1)[0].strip()
    if line and "==" in line:
        n, v = line.split("==")
        want.add((norm(n.strip()), v.strip()))
got = set()
for line in open(sys.argv[2], encoding="utf-8", errors="replace"):
    if "Successfully installed" in line:
        for tok in line.split("Successfully installed", 1)[1].split():
            n, _, v = tok.rpartition("-")
            got.add((norm(n), v))
print("ok" if got == want else "missing %s; unexpected %s" % (sorted(want - got)[:8], sorted(got - want)[:8]))
PY
)"
    [ "$LOCKCMP" = ok ] && check ok "the build installed exactly the $NLOCK packages of requirements.lock" || check "$LOCKCMP" "the build installed exactly requirements.lock"
  fi
fi
TAGURL="$(sed -n "s/^TAG-URL $TAG //p" "$OUT/service-after.txt")"
say "   tag URL: ${TAGURL:-none}"
if [ -n "$TAGURL" ]; then
  HC="$(curl -sS --max-time 30 -o "$OUT/health.txt" -w '%{http_code}' "$TAGURL/api/health" 2>>"$ERR")"  #RO
  [ "$HC" = 200 ] && grep -q '"status":"ok"' "$OUT/health.txt" && check ok "GET /api/health -> 200 ok" || check "HTTP $HC" "GET /api/health -> 200 ok"
  FC="$(curl -sS --max-time 30 -o "$OUT/health-firestore.txt" -w '%{http_code}' "$TAGURL/api/health/firestore" 2>>"$ERR")"  #RO
  [ "$FC" = 200 ] && grep -q '"status":"ok"' "$OUT/health-firestore.txt" && check ok "GET /api/health/firestore -> 200 ok (one real Firestore read)" || check "HTTP $FC $(head -c 200 "$OUT/health-firestore.txt")" "GET /api/health/firestore -> 200 ok"
  MC="$(curl -sS --max-time 30 -o "$OUT/mfa-status.txt" -w '%{http_code}' "$TAGURL/api/auth/mfa/status" 2>>"$ERR")"  #RO
  [ "$MC" = 401 ] && check ok "GET /api/auth/mfa/status without a token -> 401" || check "HTTP $MC" "GET /api/auth/mfa/status without a token -> 401"
else
  check "no tag URL" "tag URL present"
fi
say "   waiting 45 s for start-up logs"; sleep 45
gcloud logging read "resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"$SERVICE\" AND resource.labels.revision_name=\"$NEW\" AND NOT logName:\"run.googleapis.com%2Frequests\"" --project "$P" --freshness=2h --limit 300 --order=asc --format='value(timestamp,severity,textPayload)' > "$OUT/startup-logs.txt" 2>>"$ERR"  #RO
gcloud logging read "resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"$SERVICE\" AND resource.labels.revision_name=\"$NEW\" AND severity>=ERROR" --project "$P" --freshness=2h --limit 100 --format='value(timestamp,severity,textPayload)' > "$OUT/error-logs.txt" 2>>"$ERR"  #RO
say "   start-up log lines: $(grep -c . "$OUT/startup-logs.txt"); ERROR entries: $(grep -c . "$OUT/error-logs.txt")"
[ "$(grep -c . "$OUT/error-logs.txt")" = 0 ] && check ok "no ERROR-or-higher log entry for $NEW" || check "$(grep -c . "$OUT/error-logs.txt") entries" "no ERROR logs"
grep -q "Zipper API ready" "$OUT/startup-logs.txt" && check ok "start-up log: 'Zipper API ready'" || check "not seen" "start-up log: 'Zipper API ready'"

# ── 6. One controlled e-mail from the new revision ──────────────────────────────────────────────────
say ""; say "== 6. Controlled e-mail (observer sign-in code, delivery mailbox)"
if [ -n "$TAGURL" ]; then
  say "ABOUT TO: POST $TAGURL/api/auth/observer/request-code — ONE sign-in code e-mail leaves through SendGrid from this revision"
  printf 'Type EMAIL to send it, SKIP to continue without it (anything else stops): '
  ans=""; read -r ans
  if [ "$ans" = EMAIL ]; then
    say "Confirmed by typing EMAIL at $(date -u +%FT%TZ)"
    EC="$(curl -sS --max-time 40 -o "$OUT/request-code.txt" -w '%{http_code}' -X POST -H 'Content-Type: application/json' -d '{}' "$TAGURL/api/auth/observer/request-code" 2>>"$ERR")"  #MUT-EMAIL
    [ "$EC" = 200 ] && grep -q 'A sign-in code has been sent' "$OUT/request-code.txt" && check ok "request-code -> 200, 'A sign-in code has been sent' (no code in the response)" || check "HTTP $EC" "request-code -> 200"
    grep -Eq '"code"' "$OUT/request-code.txt" && check "a code field is in the response" "the response carries no code" || check ok "the response carries no code"
    say "   waiting 25 s for the delivery log"; sleep 25
    SINCE="$(since_utc 5)"
    gcloud logging read "resource.type=\"cloud_run_revision\" AND resource.labels.revision_name=\"$NEW\" AND timestamp>=\"$SINCE\" AND (textPayload:\"accepted (\" OR textPayload:\"FAILED (HTTP\" OR textPayload:\"not sent\")" --project "$P" --limit 50 --format='value(timestamp,severity)' > "$OUT/mail-log.tsv" 2>>"$ERR"  #RO
    gcloud logging read "resource.type=\"cloud_run_revision\" AND resource.labels.revision_name=\"$NEW\" AND timestamp>=\"$SINCE\" AND textPayload:\"accepted (\"" --project "$P" --limit 50 --format='value(timestamp)' > "$OUT/mail-accepted.tsv" 2>>"$ERR"  #RO
    say "   mail log lines: $(grep -c . "$OUT/mail-log.tsv"); accepted: $(grep -c . "$OUT/mail-accepted.tsv") (content not read)"
    [ "$(grep -c . "$OUT/mail-accepted.tsv")" -ge 1 ] 2>/dev/null && check ok "SendGrid accepted the message (key usable by the backend)" || check "no 'accepted' line yet" "SendGrid accepted the message"
    say "   NOW CHECK THE DELIVERY MAILBOX (Show original): From 'ZIPPER Live <no-reply@zipperlive.org>', SPF/DKIM/DMARC pass, no tracking links."
  elif [ "$ans" = SKIP ]; then
    say "E-mail test skipped by you (SKIP). Record the reason in the runbook."
  else
    say "Not confirmed. Nothing was sent. The tag $TAG is still in place — re-run later or remove it (APPROVAL-COMMANDS.txt, UNTAG)."; exit 4
  fi
fi

# ── 7. Remove the tag ───────────────────────────────────────────────────────────────────────────────
confirm UNTAG "remove the public tag $TAG from $SERVICE (the revision $NEW keeps 0% and stays; traffic unchanged)"
gcloud run services update-traffic zipper-api --project zipper-83816 --region asia-south1 --remove-tags "$TAG" > "$OUT/untag-output.txt" 2>&1  #MUT-UNTAG
say "untag exit code: $?"
service_state "$OUT/service-final.txt"
case ",$(sed -n 's/^TAGS //p' "$OUT/service-final.txt")," in *",$TAG="*) check "still present" "tag $TAG removed";; *) check ok "tag $TAG removed";; esac
[ "$(sed -n 's/^TRAFFIC status //p' "$OUT/service-final.txt")" = "$SPLIT" ] && check ok "traffic still $SPLIT" || check "$(sed -n 's/^TRAFFIC status //p' "$OUT/service-final.txt")" "traffic still $SPLIT"

if [ "$FAILS" = 0 ]; then
  printf 'name=%s\ndigest=%s\nbase=%s\ntag=%s\nhead=%s\nrecorded=%s\n' "$NEW" "$DIG" "$SERVING" "$TAG" "$HEAD_SHA" "$TS" > "$STATE_BACKEND"
  say "recorded: $STATE_BACKEND (NEW=$NEW, BASE=$SERVING)"
else
  say "NOT recorded in backend-revision.txt because a check failed. Review before anything else; the revision has 0%."
fi
finish "the revision has 0% traffic; 19-rollback-backend.command only if traffic moved"
