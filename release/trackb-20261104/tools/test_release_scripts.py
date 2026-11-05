"""Local test of the ZIPPER Track B release scripts (release/trackb-20261104) — no network, no credentials.
Adapted from the completion-release harness (release/completion-20261101/tools/test_release_scripts.py, 289/289).

Two parts:
  1. STATIC: every gcloud/firebase line (and every publish/restore/CRM/e-mail line) is marked #RO or #MUT-<id>; each
     #MUT tag is the reviewed command and appears exactly once, in the expected script; #RO lines use read verbs only;
     forbidden commands (--to-latest, versions access, --force deploys, deletes, git writes) appear nowhere; every
     script checks SCRIPTS.sha256 before anything else; SCRIPTS.sha256 lists exactly the production files.
  2. FUNCTIONAL: a throwaway git repository with the Mac layout (backend/, functions/, zipper-crm/, rules, hotfix
     bundle, build.gradle.kts, a fake guarded deploy-crm.command, this folder) and stub `gcloud`, `firebase`, `npm`,
     `node`, `curl`, `sleep`, `date` (+%u only), the backend venv `python` (live_rules / android_update_doc /
     publish_apk), `aapt2` and `apksigner`. Every script runs end to end in release order, every production script is
     refused without its word, rollbacks run their reviewed command, and the gates refuse: dirty tree, RELEASE.txt
     mismatch, tampered SCRIPTS.sha256, missing/old/failed emulator evidence, a hotfix text off its SHA256SUMS, missing
     IAM role, unpublished APK, wave B live, and a Functions rollback base that is not refs/heads/prod-live-20261030
     (f1af30a refused; the short name, shadowed by a same-named tag, never resolved). The fake project holds the 104
     production functions as they run on 4 Nov (95 from the cf64145 stand-in LIVE, 9 from the prod-live stand-in PROD;
     9 gen2; 9 in us-central1) and the release exports 168 (64 new); 20/21 refuse an export split other than WAVE_2A +
     WAVE_2B + NOT_REDEPLOYED or rollback bases that do not cover the deployed names (the `node -e` enumeration is
     stubbed); a deploy that stops part-way is reported per name and 29 rolls back exactly the updated ones, each to
     the tree it ran before (LIVE or PROD; new functions are left in place); 33 refuses an index file that is not a
     superset of the live indexes;
     45/46/47 (Owner MFA enforcement) refuse without their preconditions and words and pin back on failure.
     The prod APKs are synthetic ZIPs with an APK Signing Block (one v2 signer, self-signed test certificates made by
     openssl; the copy's FLEET_CERT_SHA256 names the "fleet" one) and the apksigner stub prints a format nothing
     parses: 60 publishes only the fleet certificate and refuses another Mac's debug key (same CN), a release key, two
     certificates, no signing block, and apksigner exit 1.
     Plus unit tests of tools/android_update_doc.py restore (in-memory Firestore fake), of fn-classify and of
     tools/apk_cert.py.

Usage: python3 -I tools/test_release_scripts.py <release/trackb-20261104 folder>
"""
import hashlib
import io
import json
import os
import re
import shutil
import struct
import subprocess
import sys
import tempfile
import time
import zipfile
from pathlib import Path

REL = Path(sys.argv[1]).resolve()
results = []


def ok(name, cond, detail=""):
    results.append((bool(cond), name))
    print(("PASS  " if cond else "FAIL  ") + name + (("  (" + str(detail)[-700:] + ")") if detail and not cond else ""))


def sha(text):
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


# ══ 1. STATIC ════════════════════════════════════════════════════════════════
PROD_FILES = sorted(p.name for p in REL.glob("[0-9][0-9]-*.command"))
LIBS = ["rel_common.sh", "rel_deploy_lib.sh", "rel_rules_lib.sh", "make-release-txt.sh"]
EXPECT_SHA_LIST = sorted(PROD_FILES + LIBS + ["rel_helpers.py", "tools/android_update_doc.py", "tools/live_rules.py",
                                               "tools/apk_cert.py"])

C10, C11, C12, C19 = ("10-grant-backend-sendgrid-secret.command", "11-deploy-backend-no-traffic.command",
                      "12-canary-backend.command", "19-rollback-backend.command")
C20, C21, C29 = "20-deploy-functions-wave2a.command", "21-deploy-functions-wave2b.command", "29-rollback-functions.command"
C30, C31, C39, C40 = ("30-deploy-rules-hotfix1.command", "31-deploy-rules-rc2.command", "39-rollback-rules.command",
                      "40-storage-iam-grant.command")
C32, C33 = "32-deploy-storage-hotfix1.command", "33-deploy-indexes.command"
C45, C46, C47 = "45-enable-owner-mfa-enforcement.command", "46-move-traffic-enforce.command", "47-rollback-enforcement.command"
REAL_PROD, REAL_NOTPROD = "4e21b7f14f7cafb01b8aacaf35368695a17d13e0", "f1af30a1d64fb8f20403fd6e7da5633cfab1234c"
REAL_LIVE = "cf64145525c4e425da50abceac90be8f1717b403"   # the tree the completion wave 2a runs since 2 Nov
REAL_FLEET = "4878a35fa2b4d8a0a6bcab84f22b66312385fe02523603ea23d3e190fc1948af"   # the certificate that signed APK 19
C41, C49, C50 = "41-deploy-storage-rules.command", "49-rollback-storage.command", "50-deploy-crm.command"
C60, C61, C70, C90 = ("60-publish-apk.command", "61-withdraw-apk.command", "70-monitoring-setup.command",
                      "90-postdeploy-verify-readonly.command")
UT = "gcloud run services update-traffic zipper-api --project zipper-83816 --region asia-south1 "
FB_FN = 'firebase deploy --only "$ONLY" --project zipper-83816 --non-interactive'
SA_STORAGE = "serviceAccount:service-239458555881@gcp-sa-firebasestorage.iam.gserviceaccount.com"
EXPECTED_MUT = {
    "MUT-DEPLOY-BACKEND": (C11, 'gcloud run deploy zipper-api --project zipper-83816 --region asia-south1 --source . --no-traffic --tag "$TAG" --update-secrets SENDGRID_API_KEY=ZIPPER_SENDGRID_API_KEY:1 --update-env-vars EMAIL_PROVIDER=sendgrid,SENDGRID_FROM_EMAIL=no-reply@zipperlive.org,"SENDGRID_FROM_NAME=ZIPPER Live"'),
    "MUT-PIN-BACK": (C11, UT + '--to-revisions "$SERVING=100"'),
    "MUT-EMAIL": (C11, "-X POST -H 'Content-Type: application/json' -d '{}' \"$TAGURL/api/auth/observer/request-code\""),
    "MUT-UNTAG": (C11, UT + '--remove-tags "$TAG"'),
    "MUT-CANARY-BACK": (C12, UT + '--to-revisions "$BASE=100"'),
    "MUT-CANARY-10": (C12, UT + '--to-revisions "$NEW=10,$BASE=90"'),
    "MUT-CANARY-50": (C12, UT + '--to-revisions "$NEW=50,$BASE=50"'),
    "MUT-CANARY-100": (C12, UT + '--to-revisions "$NEW=100"'),
    "MUT-ROLLBACK-BACKEND": (C19, UT + '--to-revisions "$BASE=100"'),
    "MUT-DEPLOY-2A": (C20, FB_FN), "MUT-DEPLOY-2B": (C21, FB_FN),
    "MUT-ROLLBACK-FN-LIVE": (C29, FB_FN), "MUT-ROLLBACK-FN-PROD": (C29, FB_FN),
    "MUT-RULES-RC2": (C31, "firebase deploy --only firestore:rules,firestore:indexes --project zipper-83816 --non-interactive"),
    "MUT-INDEXES": (C33, "firebase deploy --only firestore:indexes --project zipper-83816 --non-interactive < /dev/null"),
    "MUT-ENFORCE-NEW": (C45, "gcloud run services update zipper-api --project zipper-83816 --region asia-south1 --update-env-vars OWNER_MFA_REQUIRED=true --no-traffic"),
    "MUT-ENFORCE-NEW-PIN-BACK": (C45, UT + '--to-revisions "$BASE=100"'),
    "MUT-ENFORCE-TRAFFIC": (C46, UT + '--to-revisions "$NEW=100"'),
    "MUT-ENFORCE-PIN-BACK": (C46, UT + '--to-revisions "$BASE=100"'),
    "MUT-ENFORCE-ROLLBACK": (C47, UT + '--to-revisions "$BASE=100"'),
    "MUT-RULES-ROLLBACK": (C39, "firebase deploy --only firestore:rules --project zipper-83816 --non-interactive"),
    "MUT-STORAGE-IAM": (C40, "gcloud projects add-iam-policy-binding zipper-83816 --member=" + SA_STORAGE + " --role=roles/firebaserules.firestoreServiceAgent --condition=None"),
    "MUT-STORAGE-RC2": (C41, "firebase deploy --only storage --project zipper-83816 --non-interactive"),
    "MUT-STORAGE-ROLLBACK": (C49, "firebase deploy --only storage --project zipper-83816 --non-interactive"),
    "MUT-STORAGE-IAM-REVERT": (C49, "gcloud projects remove-iam-policy-binding zipper-83816 --member=" + SA_STORAGE + " --role=roles/firebaserules.firestoreServiceAgent --condition=None"),
    "MUT-CRM": (C50, "( cd \"$REPO\" && /bin/bash ./deploy-crm.command )"),
    "MUT-PUBLISH-APK": (C60, '-m scripts.publish_apk --channel "$APK_CHANNEL" --apk-dir "$STAGE" --min-supported "$APK_MIN_SUPPORTED" --notes "$APK_NOTES" --apply'),
    "MUT-WITHDRAW-APK": (C61, '"$HERE/tools/android_update_doc.py" restore "$SAVED" "$APK_CHANNEL"'),
    "MUT-MON-CHANNEL": (C70, 'gcloud beta monitoring channels create --project zipper-83816 --display-name="ZIPPER release alerts" --type=email --channel-labels="email_address=$EMAIL"'),
    "MUT-MON-UPTIME": (C70, "gcloud monitoring uptime create zipper-api-health --project zipper-83816 --resource-type=uptime-url --resource-labels=host=zipperlive.web.app,project_id=zipper-83816 --protocol=https --path=/api/health --period=5 --timeout=10"),
    "MUT-MON-POLICY": (C70, 'gcloud alpha monitoring policies create --project zipper-83816 --policy-from-file="$OUT/policy-$kind.json"'),
}
WORDS = {C11: "DEPLOY", C12: "CANARY10", C19: "ROLLBACK", C20: "DEPLOY2A", C21: "DEPLOY2B", C29: "ROLLBACK",
         C31: "RELEASE", C33: "INDEXES", C39: "ROLLBACK", C40: "GRANT", C41: "RELEASE",
         C45: "ENFORCE-NEW", C46: "ENFORCE", C47: "ROLLBACK", C49: "ROLLBACK", C50: "CRM",
         C60: "PUBLISH", C61: "WITHDRAW", C70: "MONITOR"}
RO_VERBS = ["gcloud --version", "gcloud config get-value", "gcloud auth list", "gcloud run services describe",
            "gcloud run revisions describe", "gcloud functions describe", "gcloud functions list",
            "gcloud secrets describe", "gcloud secrets versions list", "gcloud secrets get-iam-policy",
            "gcloud projects get-iam-policy", "gcloud logging read", "gcloud meta list-files-for-upload",
            "gcloud artifacts repositories describe", "gcloud services list", "gcloud builds list", "gcloud builds log",
            "gcloud storage buckets describe", "gcloud alpha monitoring policies list",
            "gcloud beta monitoring channels list", "gcloud monitoring uptime list-configs",
            "gcloud firestore indexes composite list", "gcloud firestore indexes fields list",
            "firebase --version", "firebase hosting:channel:list"]
FORBIDDEN = [r"(gcloud|update-traffic)[^#]*--to-latest", r"versions\s+access", r"firebase\s[^#]*--force\b", r"secrets\s+delete", r"versions\s+destroy",
             r"functions\s+delete", r"set-iam-policy", r"run\s+services\s+delete", r"revisions\s+delete",
             r"hosting:disable", r"firestore:delete", r"functions:secrets", r"gcloud\s[^#]*\s(delete|destroy)\b",
             r"\bgit\s+(-C\s+\S+\s+)?(push|commit|reset|checkout|add|rm|stash|clean|tag|merge|rebase|restore|switch|fetch|pull)(?![\w-])",
             r"\bcat\s+[^|]*\.env\b", r"\bsource\s+[^ ]*\.env\b", r"--min-supported\s+[^\"$]"]
INVOKE = re.compile(r"(^|[\s;&|(`$])(gcloud|firebase)\s")
OTHER_MUT = re.compile(r"scripts\.publish_apk|android_update_doc\.py\"? restore|bash\s+\S*deploy-crm\.command|-X POST")


def logical_lines(path):
    out, buf, start = [], "", 0
    for no, raw in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        if not buf:
            start = no
        if raw.rstrip().endswith("\\") and not raw.strip().startswith("#"):
            buf += raw.rstrip()[:-1] + " "
            continue
        out.append((start, buf + raw))
        buf = ""
    return out


code_files = sorted(REL.glob("[0-9][0-9]-*.command")) + [REL / f for f in LIBS if not f.endswith(".command")] + [REL / "tools" / "write-scripts-sha256.command"]
seen = {}
for f in code_files:
    first_invoke, first_verify = None, None
    for no, line in logical_lines(f):
        s = line.strip()
        if not s or s.startswith("#"):
            continue
        code = s.split("  #")[0] if "  #" in s else s
        for pat in FORBIDDEN:
            if re.search(pat, code):
                ok(f"{f.name}:{no} has no forbidden command", False, pat + " :: " + code[:160])
        if "verify_scripts" in code and first_verify is None:
            first_verify = no
        is_inv = INVOKE.search(code) and not re.search(r"\b(need_tools|command -v)\b", code)
        is_other = OTHER_MUT.search(code) or re.search(r"live_rules\.py\" get|android_update_doc\.py\" get", code)
        if not is_inv and not is_other:
            continue
        if first_invoke is None:
            first_invoke = no
        m = re.search(r"#(RO|MUT-[A-Z0-9-]+|LOCAL-GIT)\s*$", s)
        if not m:
            ok(f"{f.name}:{no} production command line is tagged", False, s[:160])
            continue
        tag = m.group(1)
        if tag == "RO":
            bad = []
            for mm in INVOKE.finditer(code):
                rest = re.sub(r"\s+", " ", code[mm.start(2):])
                if not any(rest.startswith(v) for v in RO_VERBS):
                    bad.append(rest[:80])
            if OTHER_MUT.search(code) and ("--apply" in code or " restore " in code or "-X POST" in code or "deploy-crm" in code):
                bad.append("mutating non-gcloud command marked #RO")
            if bad:
                ok(f"{f.name}:{no} #RO line uses read verbs only", False, bad)
        elif tag.startswith("MUT-"):
            seen.setdefault(tag, []).append(f.name)
            want = EXPECTED_MUT.get(tag)
            if not want or want[1] not in code:
                ok(f"{f.name}:{no} {tag} is the reviewed command", False, code[:200])
    if (f.suffix == ".command" and f.parent == REL) or f.name == "make-release-txt.sh":
        ok(f"{f.name}: verify_scripts runs before any production command",
           first_verify is not None and (first_invoke is None or first_verify < first_invoke), f"{first_verify} {first_invoke}")
for tag, (where, _) in EXPECTED_MUT.items():
    ok(f"{tag} appears exactly once, in {where}", seen.get(tag) == [where], seen.get(tag))
ok("no unexpected mutation tag", set(seen) <= set(EXPECTED_MUT), set(seen) - set(EXPECTED_MUT))
for f, w in WORDS.items():
    txt = (REL / f).read_text(encoding="utf-8")
    ok(f"{f} asks for its word {w} before its first change", re.search(r'confirm "?\$?\{?' + re.escape(w if f != C12 else "$WORD"), txt) or (f == C12 and 'confirm "$WORD"' in txt))
ok("10, 30 and 32 (done in the completion release: SendGrid grant, hotfix-1 rules) are not in this folder",
   not any((REL / c).exists() for c in (C10, C30, C32)))
# Rollback base rule: the production Functions tree by its FULL ref, pinned to 4e21b7f; f1af30a named as not production.
rcs = (REL / "rel_common.sh").read_text(encoding="utf-8")
ok("rel_common.sh: rollback bases refs/heads/prod-live-20261030 = 4e21b7f… and LIVE_FN_COMMIT = cf64145…, f1af30a… named NOT production",
   'PROD_FN_REF="refs/heads/prod-live-20261030"' in rcs and 'PROD_FN_COMMIT="%s"' % REAL_PROD in rcs
   and 'NOT_PROD_FN_COMMIT="%s"' % REAL_NOTPROD in rcs and 'LIVE_FN_COMMIT="%s"' % REAL_LIVE in rcs)
ok("rel_common.sh describes 4 Nov production: serving and template zipper-api-00057-xiq, CRM bf4066501e5f593a, APK 22 / 1.2.8 / min 22",
   'EXPECT_SERVING="zipper-api-00057-xiq"' in rcs and 'EXPECT_TEMPLATE="zipper-api-00057-xiq"' in rcs
   and 'OLD_CRM_VERSION="bf4066501e5f593a"' in rcs and "APK_VERSION_CODE=22" in rcs and 'APK_VERSION_NAME="1.2.8"' in rcs
   and "APK_MIN_SUPPORTED=22" in rcs)
# The fleet's signing certificate: pinned once (rel_common.sh); 60 and LOCAL-VERIFY 6b read the APK Signing Block.
ok("rel_common.sh pins the fleet's signing certificate FLEET_CERT_SHA256 = %s… (the key that signed APK 19)" % REAL_FLEET[:16],
   'FLEET_CERT_SHA256="%s"' % REAL_FLEET in rcs)
c60_txt = (REL / C60).read_text(encoding="utf-8")
ok("60 takes the signer from tools/apk_cert.py, never from apksigner's text",
   "tools/apk_cert.py" in c60_txt and "apk-cert-check" in c60_txt
   and not re.search(r"certificate DN|Signer #", c60_txt + (REL / "rel_helpers.py").read_text(encoding="utf-8")))
short =["%s:%d" % (f.name, no) for f in code_files for no, ln in logical_lines(f) if not ln.strip().startswith("#")
         and re.search(r"(?<!refs/heads/)prod-live-20261030(?!-tag)", ln.split("  #")[0])]
ok("no script names prod-live-20261030 except as the full ref refs/heads/prod-live-20261030", not short, short)
# The Functions waves (rel_common.sh, evaluated by bash): every exported function in exactly one list.
LIST_NAMES = ["WAVE_2A_CHANGED", "WAVE_2A_NEW", "WAVE_2A", "WAVE_2B", "NOT_REDEPLOYED", "EMAIL_FNS", "FN_US_CENTRAL1",
              "FN_BASE_LIVE", "FN_BASE_PROD"]
lp = subprocess.run(["/bin/bash", "-c", '. ./rel_common.sh >/dev/null 2>&1; for v in %s; do eval "printf \'%%s=%%s\\n\' $v \\"\\$$v\\""; done' % " ".join(LIST_NAMES)],
                    cwd=str(REL), capture_output=True, text=True, env={"PATH": "/usr/bin:/bin", "HOME": "/nonexistent"})
LISTS = {k: v.split() for k, v in (l.split("=", 1) for l in lp.stdout.splitlines() if "=" in l)}
ok("rel_common.sh lists readable (%s)" % ", ".join(LIST_NAMES), set(LISTS) == set(LIST_NAMES), lp.stdout[-300:] + lp.stderr[-300:])
ALL3 = LISTS.get("WAVE_2A", []) + LISTS.get("WAVE_2B", []) + LISTS.get("NOT_REDEPLOYED", [])
ok("WAVE_2A, WAVE_2B and NOT_REDEPLOYED are disjoint and no name appears twice", len(ALL3) == len(set(ALL3)),
   sorted(n for n in set(ALL3) if ALL3.count(n) > 1))
ok("WAVE_2A ∪ WAVE_2B ∪ NOT_REDEPLOYED = 168 names (the 104 production functions + 64 new)", len(set(ALL3)) == 168, len(set(ALL3)))
ORIG_2B = ["generateAgoraToken", "settleGift", "startCall", "acceptCall", "tickCall", "endCall", "declineCall", "sweepStaleCalls"]
UNCHANGED = ["releaseBeansForWeek", "getPayoutStatus", "purgeDeletedAccounts", "purgeMyAccountNow",
             "recoverAccount", "requestAccountDeletion", "syncMyRoles", "toggleLike",
             "onHostInvitationWithdrawn"]
ok("WAVE_2A = 85 changed + 64 new; WAVE_2B = the 8 call/gift functions + joinPartyRoom + sweepEmptyPartyRooms; NOT_REDEPLOYED = the 9 unchanged; the 8 EMAIL_FNS in wave A",
   LISTS.get("WAVE_2A") == LISTS.get("WAVE_2A_CHANGED", []) + LISTS.get("WAVE_2A_NEW", [])
   and len(LISTS.get("WAVE_2A_CHANGED", [])) == 85 and len(LISTS.get("WAVE_2A_NEW", [])) == 64
   and LISTS.get("WAVE_2B") == ORIG_2B + ["joinPartyRoom", "sweepEmptyPartyRooms"]
   and LISTS.get("NOT_REDEPLOYED") == UNCHANGED and len(LISTS.get("EMAIL_FNS", [])) == 8
   and set(LISTS.get("EMAIL_FNS", [])) <= set(LISTS.get("WAVE_2A_CHANGED", [])), {k: len(v) for k, v in LISTS.items()})
ok("rollback bases: FN_BASE_PROD = the 8 call/gift functions, FN_BASE_LIVE = the 87 redeployed completion-wave-2a names, together with the new ones exactly the deployed names",
   LISTS.get("FN_BASE_PROD") == ORIG_2B and len(LISTS.get("FN_BASE_LIVE", [])) == 87
   and sorted(LISTS.get("FN_BASE_LIVE", []) + LISTS.get("FN_BASE_PROD", []) + LISTS.get("WAVE_2A_NEW", []))
       == sorted(LISTS.get("WAVE_2A", []) + LISTS.get("WAVE_2B", [])), {k: len(v) for k, v in LISTS.items()})
# The functions declared without .region() (us-central1) and the 2nd-gen ones, as functions/src declares them.
US_CENTRAL1 = {"weeklyPayoutReportGenerator", "dailyPlatformStatsAggregator", "scheduledTransactionalSweep", "scheduledAlertScan",
               "scheduledReconciliation", "scheduledDailyReports", "scheduledWeeklyBusinessReport", "scheduledPartnerStatements",
               "scheduledMonthlyReports"}
GEN2 = {"settleGift", "startCall", "acceptCall", "declineCall", "tickCall", "endCall", "recoverAccount", "purgeMyAccountNow", "requestAccountDeletion"}
ok("FN_US_CENTRAL1 = the 9 functions declared without .region()", set(LISTS.get("FN_US_CENTRAL1", [])) == US_CENTRAL1, LISTS.get("FN_US_CENTRAL1"))
ok("WAVE_2B carries the 6 gen-2 call/gift functions; the 3 gen-2 account functions are NOT_REDEPLOYED (unchanged)",
   GEN2 <= set(ALL3) and {"recoverAccount", "purgeMyAccountNow", "requestAccountDeletion"} <= set(LISTS.get("NOT_REDEPLOYED", []))
   and (GEN2 - {"recoverAccount", "purgeMyAccountNow", "requestAccountDeletion"}) <= set(LISTS.get("WAVE_2B", [])))
appr = REL / "APPROVAL-COMMANDS.txt"
if appr.exists():
    ok("APPROVAL-COMMANDS.txt has no --to-latest and no secret read",
       not re.search(r"--to-latest|versions\s+access", appr.read_text(encoding="utf-8")))
real_sums = REL / "SCRIPTS.sha256"
if real_sums.exists():
    listed = {}
    for line in real_sums.read_text(encoding="utf-8").splitlines():
        if line.strip():
            h, n = line.split(None, 1)
            listed[n.strip().lstrip("*")] = h
    ok("SCRIPTS.sha256 (this folder) lists exactly the production files", sorted(listed) == EXPECT_SHA_LIST,
       set(listed) ^ set(EXPECT_SHA_LIST))
    ok("SCRIPTS.sha256 (this folder) matches every file", all(
        hashlib.sha256((REL / n).read_bytes()).hexdigest() == h for n, h in listed.items() if (REL / n).exists()))
else:
    print("NOTE  SCRIPTS.sha256 not written yet in this folder (checked again after it is)")

# ══ 2. FUNCTIONAL ════════════════════════════════════════════════════════════
P = "zipper-83816"
# 4 Nov: the completion revision serves 100% and is the template; 00046-siw / 00047-9cj keep existing without traffic
SERVING, TEMPLATE, RETIRED, NEW = "zipper-api-00057-xiq", "zipper-api-00057-xiq", "zipper-api-00048-pit", "zipper-api-00058-new"
OLD20, OLDMFA = "zipper-api-00046-siw", "zipper-api-00047-9cj"
BACKEND_SA = "239458555881-compute@developer.gserviceaccount.com"
FN_SA = "zipper-83816@appspot.gserviceaccount.com"
AGENT = "service-239458555881@gcp-sa-firebasestorage.iam.gserviceaccount.com"
OLD_CRM = "bf4066501e5f593a"   # the completion CRM, live since 2 Nov
SECRET_VALUES = ["fake-agora-cert-value", "SG.fake-old-key", "ops-mailbox@example.com"]
PEOPLE = ["someone@example.com", "operator@example.com", "alerts.owner@example.org"]
WAVE_2A, WAVE_2B, NOT_REDEPLOYED = LISTS.get("WAVE_2A", []), LISTS.get("WAVE_2B", []), LISTS.get("NOT_REDEPLOYED", [])
EMAIL_FNS = LISTS.get("EMAIL_FNS", [])
ALL_FNS = WAVE_2A + WAVE_2B + NOT_REDEPLOYED   # the 168 functions functions/src/index.ts exports at the release HEAD
NEW_FNS = LISTS.get("WAVE_2A_NEW", [])
PROD_FNS = [n for n in ALL_FNS if n not in NEW_FNS]   # the 104 production runs today
ON_PROD_TREE = set(ORIG_2B + ["onHostInvitationWithdrawn"])   # still 20 Oct code; every other one runs the cf64145 stand-in
FN_ENV = {"AGORA_APP_CERTIFICATE": "fake-agora-cert-value", "SG_MAIL_KEY": "SG.fake-old-key", "API_BASE": "https://api.example"}
DEPLOYED_FS = "rules_version = '2';\n// DEPLOYED 20 Oct firestore\nservice cloud.firestore { match /databases/{d}/documents { } }\n"
DEPLOYED_ST = "rules_version = '2';\n// DEPLOYED 20 Oct storage\nservice firebase.storage { match /b/{b}/o { } }\n"
HOTFIX_FS = DEPLOYED_FS.replace("DEPLOYED 20 Oct firestore", "HOTFIX-1 firestore")
HOTFIX_ST = DEPLOYED_ST.replace("DEPLOYED 20 Oct storage", "HOTFIX-1 storage A-1 15 MB")
RC2_FS = DEPLOYED_FS.replace("DEPLOYED 20 Oct firestore", "RC2 firestore owner MFA")
RC2_ST = DEPLOYED_ST.replace("DEPLOYED 20 Oct storage", "RC2 storage ownerMfaSessions A-1")
# First line of functions/src/index.ts per commit (the firebase stub records it as the deployed "source").
PROD_SRC = "// functions PROD (prod-live-20261030: 20 Oct baseline + SendGrid wave A)"
LIVE_SRC = "// functions LIVE (cf64145: the completion release, wave 2a deployed 2 Nov)"
NOTPROD_SRC = "// functions v1 (f1af30a stand-in: unshipped Owner-MFA gate)"

GCLOUD_STUB = r'''#!/usr/bin/env python3
import json, os, sys
ST = os.environ["STUB_STATE"]; state = json.load(open(ST))
open(os.environ["STUB_LOG"], "a").write("gcloud " + " ".join(sys.argv[1:]) + "\n")
a = sys.argv[1:]
P = "zipper-83816"; BSA = "239458555881-compute@developer.gserviceaccount.com"
def out(o): print(json.dumps(o)); sys.exit(0)
def fail(m, rc=1): sys.stderr.write(m + "\n"); sys.exit(rc)
def save(): json.dump(state, open(ST, "w"))
def flag(n):
    for i, x in enumerate(a):
        if x == n and i + 1 < len(a): return a[i + 1]
        if x.startswith(n + "="): return x.split("=", 1)[1]
    return None
fmt = flag("--format") or ""
if "--to-latest" in a: fail("stub: --to-latest is never allowed", 9)
if a[:1] == ["--version"]: print("Google Cloud SDK 999.0.0 (stub)"); sys.exit(0)
if a[:3] == ["config", "get-value", "project"]: print(P); sys.exit(0)
if a[:2] == ["auth", "list"]: print("operator@example.com"); sys.exit(0)
svc = state["service"]
IMG = "asia-south1-docker.pkg.dev/zipper-83816/cloud-run-source-deploy/zipper-api@"
def rev_json(name):
    r = state["revisions"][name]
    cond = "True" if r.get("ready", True) else "False"
    return {"metadata": {"name": name, "creationTimestamp": "2026-11-01T00:00:00Z"},
            "status": {"imageDigest": IMG + r["digest"], "conditions": [{"type": t, "status": cond} for t in ("Ready", "Active", "ResourcesAvailable", "ContainerHealthy")]},
            "spec": {"serviceAccountName": BSA, "containers": [{"image": IMG + r["digest"], "env": r["env"]}]}}
def svc_json():
    tr = [{"revisionName": t["revisionName"], "percent": t["percent"]} for t in svc["traffic"]]
    spec = tr + [{"tag": k, "revisionName": v} for k, v in svc["tags"].items()]
    stat = tr + [{"tag": k, "revisionName": v, "url": "https://%s---zipper-api-abc-el.a.run.app" % k} for k, v in svc["tags"].items()]
    return {"metadata": {"name": "zipper-api", "generation": svc["generation"]},
            "status": {"url": "https://zipper-api-abc-el.a.run.app", "latestCreatedRevisionName": svc["latest"], "latestReadyRevisionName": svc["latest"], "observedGeneration": svc["generation"], "traffic": stat},
            "spec": {"traffic": spec, "template": {"metadata": {"annotations": {"run.googleapis.com/client-name": "gcloud"}}, "spec": {"serviceAccountName": BSA, "containers": [{"image": IMG + "x", "env": svc["template_env"]}]}}}}
if a[:3] == ["run", "services", "describe"]: out(svc_json())
if a[:3] == ["run", "revisions", "describe"]:
    if a[3] not in state["revisions"]: fail("NOT_FOUND")
    j = rev_json(a[3])
    if fmt.startswith("value(status.imageDigest"): print(j["status"]["imageDigest"]); sys.exit(0)
    out(j)
if a[:2] == ["run", "deploy"]:
    assert "--no-traffic" in a and flag("--source") == ".", "deploy without --no-traffic/--source"
    assert os.path.exists("Dockerfile"), "not run from the backend source"
    # a re-run of 11 (after a run that created 00049 and stopped on a check) gets its own name, as Cloud Run would
    new = "zipper-api-00058-new" if "zipper-api-00058-new" not in state["revisions"] else "zipper-api-00059-rer"; tag = flag("--tag")
    env = [e for e in svc["template_env"]]
    for pair in (flag("--update-secrets") or "").split(","):
        n, ref = pair.split("="); sname, ver = ref.split(":")
        env = [e for e in env if e["name"] != n] + [{"name": n, "valueFrom": {"secretKeyRef": {"name": sname, "key": ver}}}]
    for pair in (flag("--update-env-vars") or "").split(","):
        n, v = pair.split("=", 1)
        env = [e for e in env if e["name"] != n] + [{"name": n, "value": v}]
    state["revisions"][new] = {"digest": "sha256:" + "9" * 64, "env": env}
    svc["latest"] = new; svc["tags"][tag] = new; svc["template_env"] = env; svc["generation"] += 1
    if state.get("deploy_moves_traffic"): svc["traffic"] = [{"revisionName": new, "percent": 100}]
    save(); print("Service [zipper-api] revision [%s] has been deployed and is serving 0 percent of traffic." % new); sys.exit(0)
if a[:3] == ["run", "services", "update"]:
    # a template change: a new revision from the template's image (the latest revision's digest) with the env update
    assert "--no-traffic" in a, "services update without --no-traffic"
    base, new = svc["latest"], "zipper-api-00050-enf"
    env = [dict(e) for e in svc["template_env"]]
    for pair in (flag("--update-env-vars") or "").split(","):
        n, v = pair.split("=", 1)
        env = [e for e in env if e["name"] != n] + [{"name": n, "value": v}]
    state["revisions"][new] = {"digest": state["revisions"][base]["digest"], "env": env}
    svc["latest"] = new; svc["template_env"] = env; svc["generation"] += 1
    if state.get("update_moves_traffic"): svc["traffic"] = [{"revisionName": new, "percent": 100}]
    save(); print("Service [zipper-api] revision [%s] has been deployed and is serving 0 percent of traffic." % new); sys.exit(0)
if a[:3] == ["run", "services", "update-traffic"]:
    if flag("--to-revisions"):
        tr = []
        for pair in flag("--to-revisions").split(","):
            n, pct = pair.split("=")
            if n not in state["revisions"] or n == "zipper-api-00048-pit": fail("bad revision " + n, 9)
            tr.append({"revisionName": n, "percent": int(pct)})
        assert sum(t["percent"] for t in tr) == 100
        svc["traffic"] = tr
    if flag("--remove-tags"):
        svc["tags"].pop(flag("--remove-tags"), None)
    svc["generation"] += 1; save(); sys.exit(0)
if a[:2] == ["functions", "describe"]:
    f = state["functions"].get(a[2])
    if not f or "/locations/%s/" % flag("--region") not in f["name"]: fail("NOT_FOUND: function %s in %s" % (a[2], flag("--region")))
    out(f)
if a[:2] == ["functions", "list"]:
    # an update the CLI left running finishes on the second look (status DEPLOY_IN_PROGRESS / state DEPLOYING until then)
    busy = [f for f in state["functions"].values() if f.get("pending_update")]
    for f in busy:
        if f.get("polls_left", 0) > 0: f["polls_left"] -= 1
        else:
            f["updateTime"] = f.pop("pending_update"); f.pop("polls_left", None)
            f["state" if "state" in f else "status"] = "ACTIVE"
    if busy: save()
    out(list(state["functions"].values()))
ix = state["indexes"]
def tick(rows):
    moved = False
    for r in rows:
        for x in ([r] if "fields" in r else (r.get("indexConfig") or {}).get("indexes") or []):
            if x.get("state") == "CREATING" and not state.get("indexes_stuck"):
                if x.get("polls", 0) > 0: x["polls"] -= 1
                else: x["state"] = "READY"; x.pop("polls", None)
                moved = True
    return moved
if a[:4] == ["firestore", "indexes", "composite", "list"]:
    if tick(ix["composite"]): save()
    out(ix["composite"])
if a[:4] == ["firestore", "indexes", "fields", "list"]:
    if tick(ix["fields"]): save()
    out(ix["fields"])
sec = state["secrets"]
if a[:2] == ["secrets", "describe"]:
    if a[2] not in sec: fail("NOT_FOUND")
    out({"name": "projects/1/secrets/" + a[2], "replication": {"automatic": {}}, "createTime": "2026-10-30T22:21:38Z"})
if a[:3] == ["secrets", "versions", "list"]:
    out([{"name": "projects/1/secrets/%s/versions/%d" % (a[3], i + 1), "state": s, "createTime": "2026-10-30T22:29:02Z"} for i, s in enumerate(sec[a[3]]["versions"])])
if a[:2] == ["secrets", "get-iam-policy"]:
    m = sec[a[2]]["members"]
    out({"bindings": [{"role": "roles/secretmanager.secretAccessor", "members": m}]} if m else {"etag": "x"})
if a[:2] == ["secrets", "add-iam-policy-binding"]:
    sec[a[2]]["members"].append(flag("--member")); save(); sys.exit(0)
def policy():
    b = [{"role": r, "members": m} for r, m in sorted(state["project_roles"].items()) if m]
    return {"bindings": b + [{"role": "roles/owner", "members": ["user:someone@example.com"]}], "etag": "e"}
if a[:2] == ["projects", "get-iam-policy"]: out(policy())
if a[:2] in (["projects", "add-iam-policy-binding"], ["projects", "remove-iam-policy-binding"]):
    r, m = flag("--role"), flag("--member")
    ms = state["project_roles"].setdefault(r, [])
    if a[1].startswith("add"):
        if m not in ms: ms.append(m)
    elif m in ms: ms.remove(m)
    save(); print(json.dumps(policy())); sys.exit(0)
if a[:2] == ["meta", "list-files-for-upload"]:
    for root, dirs, files in os.walk("."):
        for fn in files: print(os.path.join(root, fn)[2:])
    sys.exit(0)
if a[:3] == ["artifacts", "repositories", "describe"]: print("projects/zipper-83816/locations/asia-south1/repositories/cloud-run-source-deploy"); sys.exit(0)
if a[:2] == ["services", "list"]:
    print("run.googleapis.com\ncloudbuild.googleapis.com\nartifactregistry.googleapis.com\nsecretmanager.googleapis.com"); sys.exit(0)
if a[:2] == ["builds", "list"]: print("build-0001"); sys.exit(0)
if a[:2] == ["builds", "log"]:
    print("Step 1/6 : FROM python:3.12-slim@sha256:" + "a" * 64)
    print("Successfully installed fastapi-0.110.0 uvicorn-0.29.0")
    print("No broken requirements found.")
    print("Digest: sha256:" + "9" * 64); sys.exit(0)
if a[:3] == ["storage", "buckets", "describe"]: print("zipper-83816.firebasestorage.app"); sys.exit(0)
if a[:2] == ["logging", "read"]:
    flt = a[2]
    if fmt.startswith("json"):
        if "run.googleapis.com%2Frequests" in flt and "NOT logName" not in flt:
            nb = state["backend_state"]
            rows = []
            for rev in (nb.get("new"), nb.get("base")):
                if rev:
                    rows += [{"resource": {"labels": {"revision_name": rev}}, "httpRequest": {"status": 200, "latency": "0.120s", "requestUrl": "https://zipperlive.web.app/api/x?q=secret"}}] * 250
            out(rows)
        out([])
    lines = 0
    if "NOT logName:" in flt and "severity" not in flt and "textPayload" not in flt:
        print("2026-11-01T00:00:00Z\tINFO\tZipper API ready"); sys.exit(0)
    for key, n in state["log_counts"].items():
        if key in flt: lines = n; break
    for i in range(lines): print("2026-11-01T00:%02d:00Z" % (i % 60))
    sys.exit(0)
mon = state["monitoring"]
if a[:4] == ["alpha", "monitoring", "policies", "list"]: out(mon["policies"])
if a[:4] == ["alpha", "monitoring", "policies", "create"]:
    pol = json.load(open(flag("--policy-from-file"))); pol["name"] = "projects/%s/alertPolicies/%d" % (P, 100 + len(mon["policies"]))
    mon["policies"].append(pol); save(); sys.exit(0)
if a[:4] == ["beta", "monitoring", "channels", "list"]: out(mon["channels"])
if a[:4] == ["beta", "monitoring", "channels", "create"]:
    lab = dict(x.split("=", 1) for x in (flag("--channel-labels") or "").split(","))
    ch = {"name": "projects/%s/notificationChannels/%d" % (P, 500 + len(mon["channels"])), "type": flag("--type"),
          "displayName": flag("--display-name"), "labels": lab, "enabled": True}
    mon["channels"].append(ch); save(); out(ch)
if a[:3] == ["monitoring", "uptime", "list-configs"]: out(mon["uptime"])
if a[:3] == ["monitoring", "uptime", "create"]:
    lab = dict(x.split("=", 1) for x in flag("--resource-labels").split(","))
    u = {"name": "projects/%s/uptimeCheckConfigs/%s-x1" % (P, a[3]), "displayName": a[3], "period": "300s",
         "monitoredResource": {"type": "uptime_url", "labels": lab}, "httpCheck": {"path": flag("--path"), "useSsl": True}}
    mon["uptime"].append(u); save(); out(u)
fail("stub: unexpected gcloud call: " + " ".join(a), 9)
'''

FIREBASE_STUB = r'''#!/usr/bin/env python3
import json, os, sys, hashlib
ST = os.environ["STUB_STATE"]; state = json.load(open(ST))
open(os.environ["STUB_LOG"], "a").write("firebase " + " ".join(sys.argv[1:]) + " [cwd=" + os.getcwd() + "]\n")
a = sys.argv[1:]
def save(): json.dump(state, open(ST, "w"))
def canon(cg, scope, fields):
    fs = [(f.get("fieldPath"), f.get("order") or "", f.get("arrayConfig") or "") for f in fields]
    if not fs or fs[-1][0] != "__name__": fs.append(("__name__", fs[-1][1] if fs and fs[-1][1] else "ASCENDING", ""))
    return (cg, scope or "COLLECTION", tuple(fs))
def deploy_indexes(spec):
    # as the CLI without --force: creates what is missing, PATCHes each field override to the file's config, deletes nothing
    ix = state["indexes"]
    live = {canon(r["name"].split("/collectionGroups/")[1].split("/")[0], r["queryScope"], r["fields"]) for r in ix["composite"]}
    want = set()
    for i in spec.get("indexes", []):
        k = canon(i["collectionGroup"], i.get("queryScope"), i["fields"]); want.add(k)
        if k not in live:
            ix["composite"].append({"name": "projects/zipper-83816/databases/(default)/collectionGroups/%s/indexes/NEW%d" % (k[0], len(ix["composite"])),
                                    "queryScope": k[1], "state": "CREATING", "polls": 1,
                                    "fields": [dict({"fieldPath": p}, **({"order": o} if o else {"arrayConfig": c})) for p, o, c in k[2]]})
            live.add(k)
    for o in spec.get("fieldOverrides", []):
        name = "projects/zipper-83816/databases/(default)/collectionGroups/%s/fields/%s" % (o["collectionGroup"], o["fieldPath"])
        cur = next((r for r in ix["fields"] if r["name"] == name), None)
        old = {(x["queryScope"], x["fields"][0].get("order", ""), x["fields"][0].get("arrayConfig", "")): x.get("state")
               for x in ((cur or {}).get("indexConfig") or {}).get("indexes", [])}
        new = []
        for c in o.get("indexes", []):
            key = (c.get("queryScope", "COLLECTION"), c.get("order", ""), c.get("arrayConfig", ""))
            fld = dict({"fieldPath": o["fieldPath"]}, **({"order": c["order"]} if c.get("order") else {"arrayConfig": c.get("arrayConfig")}))
            new.append(dict({"queryScope": key[0], "fields": [fld], "state": old.get(key) or "CREATING"}, **({} if old.get(key) else {"polls": 1})))
        row = {"name": name, "indexConfig": {"indexes": new}}
        if cur: ix["fields"][ix["fields"].index(cur)] = row
        else: ix["fields"].append(row)
    extra = [k for k in live if k not in want]
    return ("i  firestore: there are %d indexes defined in your project that are not present in your firestore indexes file. To delete them, run this command with the --force flag.\n" % len(extra)) if extra else ""
if a[:1] == ["--version"]: print("15.17.0"); sys.exit(0)
if a[:1] == ["hosting:channel:list"]:
    print(json.dumps({"status": "success", "result": {"channels": [{"name": "projects/zipper-83816/sites/zipperlive/channels/live",
          "release": {"version": {"name": "sites/zipperlive/versions/" + state["hosting_version"]}, "releaseTime": "2026-10-20T00:00:00Z",
                      "releaseUser": {"email": "someone@example.com"}}}]}})); sys.exit(0)
if a[:1] == ["deploy"]:
    if "--force" in a: print("stub: --force refused"); sys.exit(9)
    only = a[a.index("--only") + 1]
    assert a[a.index("--project") + 1] == "zipper-83816"
    if only == "hosting:production":
        assert os.path.exists("deploy-crm.command"), "CRM deploy not from the repository root"
        state["hosting_version"] = "c0ffee%010d" % (int(state.get("hosting_n", 0)) + 1); state["hosting_n"] = state.get("hosting_n", 0) + 1
        save(); print("+  Deploy complete!"); sys.exit(0)
    assert "--non-interactive" in a
    cfg = json.load(open("firebase.json"))
    parts = only.split(",")
    if all(p.startswith("functions:") for p in parts):
        assert set(cfg) == {"functions"}, "deploy folder carries more than functions"
        assert os.path.exists("functions/.env") and os.path.isdir("functions/lib") and os.path.isdir("functions/node_modules"), "functions not prepared"
        src = open("functions/src/index.ts").read().splitlines()[0]
        dotenv = dict(l.split("=", 1) for l in open("functions/.env").read().splitlines() if "=" in l)
        names = [p.split(":", 1)[1] for p in parts]
        fail_after = state.pop("deploy_fail_after", None)      # the write quota outlasts the CLI's retries after N updates
        in_progress = state.pop("deploy_in_progress", None)    # this one's update is still running when the CLI exits
        done = []
        for n in names:
            if fail_after is not None and len(done) >= fail_after: break
            f = state["functions"].get(n) or {"name": "projects/zipper-83816/locations/asia-south1/functions/" + n, "status": "ACTIVE",
                                             "entryPoint": n, "runtime": "nodejs22", "serviceAccountEmail": "zipper-83816@appspot.gserviceaccount.com",
                                             "versionId": "0", "secretEnvironmentVariables": []}
            state["clock"] += 1
            ut = "2026-11-01T%02d:%02d:%02dZ" % (2 + state["clock"] // 3600, state["clock"] // 60 % 60, state["clock"] % 60)
            env = dict(dotenv, FIREBASE_CONFIG="{}", GCLOUD_PROJECT="zipper-83816")
            if "serviceConfig" in f:   # 2nd gen: a new Cloud Run revision behind the function
                sc = f["serviceConfig"]; sc["environmentVariables"] = dict(env, LOG_EXECUTION_ID="true")
                sc["revision"] = "%s-%05d-abc" % (n.lower(), int(sc["revision"].split("-")[1]) + 1)
            else:
                f["versionId"] = str(int(f["versionId"]) + 1); f["environmentVariables"] = env
            f["source"] = src
            if n == in_progress:
                f["pending_update"] = ut; f["polls_left"] = 1
                f["state" if "state" in f else "status"] = "DEPLOYING" if "state" in f else "DEPLOY_IN_PROGRESS"
            else:
                f["updateTime"] = ut
            state["functions"][n] = f; done.append(n)
        save()
        if fail_after is not None:
            print("Functions deploy had errors with the following functions:\n" + "".join("\t%s(asia-south1)\n" % n for n in names[len(done):]))
            print("Error: There was an error deploying functions"); sys.exit(2)
        print("+  Deploy complete!"); sys.exit(0)
    if parts in (["firestore:rules"], ["firestore:rules", "firestore:indexes"], ["firestore:indexes"]):
        assert set(cfg) == {"firestore"}, "deploy folder carries more than firestore"
        if parts == ["firestore:indexes"]:
            assert set(cfg["firestore"]) == {"database", "indexes"} and sorted(os.listdir(".")) == ["firebase.json", "firestore.indexes.json"], "indexes deploy folder is not indexes-only"
        msg = ""
        if "firestore:rules" in parts:
            state["rules"]["firestore"] = open(cfg["firestore"]["rules"]).read()
            msg += "+  firestore: released rules firestore.rules to cloud.firestore\n"
        if "firestore:indexes" in parts:
            msg += deploy_indexes(json.load(open(cfg["firestore"]["indexes"])))
            msg += "+  firestore: deployed indexes in firestore.indexes.json successfully for (default) database\n"
        save(); print(msg + "+  Deploy complete!"); sys.exit(0)
    if parts == ["storage"]:
        assert cfg == {"storage": {"rules": "storage.rules"}}, "storage deploy config is not the single default-bucket form"
        state["rules"]["storage"] = open("storage.rules").read()
        save(); print("+  storage: released rules storage.rules to firebase.storage\n+  Deploy complete!"); sys.exit(0)
    print("stub: unexpected deploy " + only); sys.exit(9)
print("stub: unexpected firebase call " + " ".join(a)); sys.exit(9)
'''

VENV_STUB = r'''#!/usr/bin/env python3
import json, os, sys, hashlib, zipfile
ST = os.environ["STUB_STATE"]; state = json.load(open(ST))
a = sys.argv[1:]
open(os.environ["STUB_LOG"], "a").write("venv-python " + " ".join(a) + "\n")
def save(): json.dump(state, open(ST, "w"))
assert os.environ.get("ZIPPER_ALLOW_PRODUCTION_ACCESS") == "zipper-83816", "production acknowledgement missing"
ef = os.environ.get("ZIPPER_ENV_FILE", "")
assert ef and os.path.isfile(ef) and os.path.getsize(ef) == 0, "ZIPPER_ENV_FILE must be an empty file"
assert os.getcwd().endswith("/backend") and os.environ.get("PYTHONPATH") == ".", "not run from backend/ with PYTHONPATH=."
def write600(path, text):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600); os.write(fd, text.encode()); os.close(fd)
if a and a[0].endswith("live_rules.py"):
    kind, out = a[2], a[3]; text = state["rules"][kind]; write600(out, text)
    print("LIVE-RELEASE x\nLIVE-RULESET rs-%s\nLIVE-UPDATED 2026-11-01T00:00:00Z\nLIVE-FILE %s.rules\nLIVE-SIZE %d\nLIVE-SHA %s" % (
        hashlib.sha256(text.encode()).hexdigest()[:8], kind, len(text.encode()), hashlib.sha256(text.encode()).hexdigest()))
    sys.exit(0)
if a and a[0].endswith("android_update_doc.py"):
    doc = state["android"]
    if a[1] == "get":
        write600(a[2], json.dumps(doc, indent=1, sort_keys=True))
        for ch in ("debug", "release"):
            c = doc.get(ch) or {}
            print("ANDROID %s versionCode=%s versionName=%s minSupportedVersionCode=%s publishedAt=%s" % (ch, c.get("versionCode", 0), c.get("versionName", "?"), c.get("minSupportedVersionCode", 0), c.get("publishedAt", "?")))
        sys.exit(0)
    if a[1] == "restore":
        saved = json.load(open(a[2])); ch = a[3]
        print("RESTORE %s versionCode=%s" % (ch, saved[ch].get("versionCode")))
        doc[ch] = saved[ch]; save(); print("RESTORE done"); sys.exit(0)
if a[:2] == ["-m", "scripts.publish_apk"]:
    def flag(n):
        return a[a.index(n) + 1] if n in a else None
    ch, d = flag("--channel"), flag("--apk-dir")
    vers = set()
    for abi in ("arm64-v8a", "armeabi-v7a"):
        p = os.path.join(d, "app-%s-%s.apk" % (abi, ch))
        if not os.path.isfile(p): print("  x No %s APK at %s" % (abi, p)); sys.exit(1)
        kv = dict(x.split("=", 1) for x in zipfile.ZipFile(p).read("harness-meta.txt").decode().split() if "=" in x)
        vers.add((int(kv["versionCode"]), kv["versionName"]))
        # its signer comes from apksigner's TEXT: signer=none = it could not read that text (as publish_apk.py prints it)
        print("  %s\n    version    %s (%s)\n    signed as  %s" % (abi, kv["versionName"], kv["versionCode"], {"none": "unrecognised certificate"}.get(kv["signer"], kv["signer"])))
        if kv["signer"] not in ("none", ch): print("  x The %s APK is signed as '%s' but you asked to publish to '%s'. Nothing was published." % (abi, kv["signer"], ch)); sys.exit(1)
    (code, name), = vers
    cur = int((state["android"].get(ch) or {}).get("versionCode", 0))
    if code <= cur: print("  x versionCode %d is not greater than the published %d." % (code, cur)); sys.exit(1)
    print("  publishing            %s (%d)   mandatory=False" % (name, code))
    if "--apply" not in a: print("  DRY RUN - re-run with --apply to publish."); sys.exit(0)
    abis = {}
    for abi in ("arm64-v8a", "armeabi-v7a"):
        p = os.path.join(d, "app-%s-%s.apk" % (abi, ch)); b = open(p, "rb").read()
        abis[abi] = {"url": "https://storage.googleapis.com/x/appBuilds/%s/%s/zipper-%s-%d.apk" % (ch, abi, name, code), "sha256": hashlib.sha256(b).hexdigest(), "sizeBytes": len(b)}
    state["android"][ch] = dict({"versionCode": code, "versionName": name, "notes": flag("--notes"), "mandatory": False,
                                 "minSupportedVersionCode": int(flag("--min-supported") or 0), "publishedAt": "2026-11-01T03:00:00+00:00", "abis": abis}, **abis["arm64-v8a"])
    save(); print("  Published %s (%d) to %s, 2 architecture(s)." % (name, code, ch)); sys.exit(0)
print("venv stub: unexpected " + " ".join(a)); sys.exit(9)
'''

CURL_STUB = r'''#!/usr/bin/env python3
import os, sys
open(os.environ["STUB_LOG"], "a").write("curl " + " ".join(sys.argv[1:]) + "\n")
a = sys.argv[1:]; out = a[a.index("-o") + 1]; url = a[-1]; post = "-X" in a and a[a.index("-X") + 1] == "POST"
path = "/" + url.split("://", 1)[1].split("/", 1)[1]
code, body = 404, "{}"
if path == "/api/health": code, body = 200, '{"status":"ok","version":"x"}'
elif path == "/api/health/firestore": code, body = 200, '{"status":"ok"}'
elif path == "/api/auth/mfa/status": code, body = 401, '{"detail":"Not authenticated"}'
elif path == "/api/auth/observer/request-code" and post: code, body = 200, '{"detail":"A sign-in code has been sent"}'
open(out, "w").write(body); sys.stdout.write(str(code))
'''

NPM_STUB = '''#!/bin/bash
[ -n "${STUB_LOG:-}" ] && echo "npm $* [cwd=$PWD]" >> "$STUB_LOG"
case "$1" in
  --version) echo 10.9.9;;
  ci) mkdir -p node_modules && echo stub > node_modules/.stub;;
  run) [ "$2" = build ] && mkdir -p lib && echo "// built" > lib/index.js;;
esac
exit 0
'''
NODE_STUB = '''#!/bin/bash
[ -n "${STUB_LOG:-}" ] && echo "node $*" >> "$STUB_LOG"
case "$1" in
  --version) echo v22.11.0;;
  --test) # like the real suite, some tests read ../firestore.rules (the 1 Nov run of 20 had functions/ alone: 4 failed)
      if [ ! -f ../firestore.rules ]; then printf 'TAP version 13\\nnot ok 1 - reads ../firestore.rules\\n# tests 3\\n# suites 0\\n# pass 2\\n# fail 1\\n'; exit 1; fi
      printf 'TAP version 13\\nok 1 - a\\n# tests 3\\n# suites 0\\n# pass 3\\n# fail 0\\n';;
  -e) # the export enumeration of check_exports: "name region" per export, from the harness's control file
      echo "node -e cwd=$PWD home=$HOME stublog=${STUB_LOG:-unset} gcloud_project=${GCLOUD_PROJECT:-unset}" >> "@EXPORTS@.calls"
      [ -f lib/index.js ] || { echo "Error: Cannot find module './lib/index.js'" >&2; exit 1; }
      case "$2" in *'require("./lib/index.js")'*) cat "@EXPORTS@";; *) echo "stub: unexpected node -e" >&2; exit 9;; esac;;
esac
exit 0
'''
SLEEP_STUB = '#!/bin/bash\nexit 0\n'
REAL_DATE = "/bin/date" if os.path.exists("/bin/date") else "/usr/bin/date"
DATE_STUB = '#!/bin/bash\n# day-of-week is fixed (Wednesday) so 20 never meets its Sunday window in a test\nif [ "$*" = "-u +%%u" ]; then echo 3; exit 0; fi\nexec %s "$@"\n' % REAL_DATE
SHASUM_STUB = '#!/bin/bash\n# shasum -a 256 [-c file] [files]\nshift 2\nexec sha256sum "$@"\n'
AAPT_STUB = r'''#!/usr/bin/env python3
import sys, zipfile
kv = dict(x.split("=", 1) for x in zipfile.ZipFile(sys.argv[3]).read("harness-meta.txt").decode().split() if "=" in x)
print("package: name='%s' versionCode='%s' versionName='%s' platformBuildVersionName='15'" % (kv["package"], kv["versionCode"], kv["versionName"]))
if kv.get("debuggable") == "yes": print("application-debuggable")
'''
APKSIGNER_STUB = r'''#!/usr/bin/env python3
# apksigner verify --print-certs <apk>: exit 1 if the APK's harness-meta.txt says apksigner=fail; otherwise exit 0 with
# text in a format no script parses (under build-tools 37.0.0 no pattern found a signer) — the signer comes from the block.
import sys, zipfile
kv = dict(x.split("=", 1) for x in zipfile.ZipFile(sys.argv[-1]).read("harness-meta.txt").decode().split() if "=" in x)
if kv.get("apksigner") == "fail":
    print("DOES NOT VERIFY\nERROR: APK Signature Scheme v2 signer 1: APK integrity check failed. CHUNKED_SHA256 digest mismatch.")
    sys.exit(1)
print("Verified signers: 1 (harness stub: an output format no script parses)")
'''
DEPLOY_CRM = '''#!/bin/bash
# fake guarded CRM deploy (harness): asks DEPLOY, then hosting only
set -euo pipefail
HOSTING_TARGET="production"
read -r -p "Type DEPLOY to publish, anything else to abort: " WORD
if [ "$WORD" != "DEPLOY" ]; then echo "Aborted. Nothing was deployed."; exit 0; fi
firebase deploy --project zipper-83816 --only "hosting:$HOSTING_TARGET"
echo "CRM IS LIVE"
'''


def env_list(d):
    return [{"name": k, "value": v} for k, v in d.items()]


SERVING_ENV = [
    {"name": "MONGO_URI", "valueFrom": {"secretKeyRef": {"name": "MONGO_URI", "key": "latest"}}},
    {"name": "JWT_SECRET", "valueFrom": {"secretKeyRef": {"name": "JWT_SECRET", "key": "latest"}}},
    {"name": "SENDGRID_API_KEY", "valueFrom": {"secretKeyRef": {"name": "SENDGRID_API_KEY", "key": "latest"}}},
    {"name": "MAIL_FROM", "value": "ops-mailbox@example.com"},
    {"name": "ENVIRONMENT", "value": "production"},
]
OLD20_ENV = SERVING_ENV
# The completion revision (serving and template on 4 Nov): the 20 Oct environment + the two Owner-MFA names + the
# SendGrid settings 11 of the completion release added (SENDGRID_API_KEY now from ZIPPER_SENDGRID_API_KEY:1).
SERVING_ENV = [e for e in SERVING_ENV if e["name"] != "SENDGRID_API_KEY"] + [
    {"name": "SENDGRID_API_KEY", "valueFrom": {"secretKeyRef": {"name": "ZIPPER_SENDGRID_API_KEY", "key": "1"}}},
    {"name": "OWNER_MFA_REQUIRED", "value": "false"},
    {"name": "OWNER_MFA_ENCRYPTION_KEY", "valueFrom": {"secretKeyRef": {"name": "OWNER_MFA_ENCRYPTION_KEY", "key": "1"}}},
    {"name": "EMAIL_PROVIDER", "value": "sendgrid"}, {"name": "SENDGRID_FROM_EMAIL", "value": "no-reply@zipperlive.org"},
    {"name": "SENDGRID_FROM_NAME", "value": "ZIPPER Live"}]
TEMPLATE_ENV = SERVING_ENV


def fn_obj(n):
    """One production function as `gcloud functions describe/list` returns it: 1st gen (v1 shape, App Engine identity)
    or 2nd gen (v2 shape, compute identity); us-central1 for the functions declared without .region(). Its source is
    the tree it runs on 4 Nov: PROD for the 8 call/gift functions and onHostInvitationWithdrawn, LIVE for the rest."""
    src = PROD_SRC if n in ON_PROD_TREE else LIVE_SRC
    sec = []
    if n == "weeklyPayoutReportGenerator":
        sec = [{"key": "ZIPPER_ACCRUAL_KEY", "secret": "ZIPPER_ACCRUAL_KEY", "version": "1"},
               {"key": "ZIPPER_SENDGRID_API_KEY", "secret": "ZIPPER_SENDGRID_API_KEY", "version": "1"}]
    elif n in EMAIL_FNS:
        sec = [{"key": "ZIPPER_SENDGRID_API_KEY", "secret": "ZIPPER_SENDGRID_API_KEY", "version": "1"}]
    name = "projects/zipper-83816/locations/%s/functions/%s" % ("us-central1" if n in US_CENTRAL1 else "asia-south1", n)
    env = dict(FN_ENV, FIREBASE_CONFIG="{}", GCLOUD_PROJECT=P)
    if n in GEN2:
        return {"name": name, "state": "ACTIVE", "environment": "GEN_2", "updateTime": "2026-10-20T08:31:41Z",
                "buildConfig": {"runtime": "nodejs22", "entryPoint": n},
                "serviceConfig": {"serviceAccountEmail": BACKEND_SA, "revision": "%s-00006-abc" % n.lower(),
                                  "environmentVariables": dict(env, LOG_EXECUTION_ID="true"), "secretEnvironmentVariables": sec},
                "source": src}
    return {"name": name, "status": "ACTIVE", "entryPoint": n, "runtime": "nodejs22", "serviceAccountEmail": FN_SA,
            "updateTime": "2026-10-20T08:31:41Z", "versionId": "6", "environmentVariables": env,
            "secretEnvironmentVariables": sec, "source": src}


# firestore.indexes.json of the throwaway repository: 2 composite indexes live today (one written with its __name__, as
# the CLI's export does), 2 new ones, and the live collection-group override of beanTransactions.type.
IDX_FILE = {"indexes": [
    {"collectionGroup": "calls", "queryScope": "COLLECTION", "fields": [{"fieldPath": "status", "order": "ASCENDING"}, {"fieldPath": "createdAt", "order": "DESCENDING"}]},
    {"collectionGroup": "agents", "queryScope": "COLLECTION", "density": "SPARSE_ALL", "fields": [
        {"fieldPath": "referralCode", "order": "ASCENDING"}, {"fieldPath": "status", "order": "ASCENDING"}, {"fieldPath": "__name__", "order": "ASCENDING"}]},
    {"collectionGroup": "publicProfiles", "queryScope": "COLLECTION", "fields": [
        {"fieldPath": "isListed", "order": "ASCENDING"}, {"fieldPath": "languageCodes", "arrayConfig": "CONTAINS"}, {"fieldPath": "lastSeen", "order": "DESCENDING"}]},
    {"collectionGroup": "techTickets", "queryScope": "COLLECTION", "fields": [{"fieldPath": "status", "order": "ASCENDING"}, {"fieldPath": "createdAt", "order": "DESCENDING"}]}],
    "fieldOverrides": [{"collectionGroup": "beanTransactions", "fieldPath": "type", "indexes": [{"queryScope": "COLLECTION_GROUP", "order": "ASCENDING"}]}]}
DB = "projects/zipper-83816/databases/(default)/collectionGroups/"


def live_ix(cg, fields, n, scope="COLLECTION", state="READY"):
    return {"name": DB + "%s/indexes/LIVE%d" % (cg, n), "queryScope": scope, "fields": fields, "state": state, "density": "SPARSE_ALL"}


def live_field(cg, fp, cfgs):
    return {"name": DB + "%s/fields/%s" % (cg, fp), "indexConfig": {"ancestorField": DB + "__default__/fields/*", "indexes": [
        {"queryScope": s, "fields": [dict({"fieldPath": fp}, **({"order": o} if o in ("ASCENDING", "DESCENDING") else {"arrayConfig": o}))], "state": "READY"}
        for s, o in cfgs]}}


def fresh_state():
    fns = {n: fn_obj(n) for n in PROD_FNS}   # the 64 new functions do not exist before 20
    return {
        "service": {"traffic": [{"revisionName": SERVING, "percent": 100}], "tags": {}, "latest": TEMPLATE,
                    "template_env": TEMPLATE_ENV, "generation": 57},
        "revisions": {SERVING: {"digest": "sha256:" + "1" * 64, "env": SERVING_ENV},
                      OLD20: {"digest": "sha256:" + "4" * 64, "env": OLD20_ENV},
                      OLDMFA: {"digest": "sha256:" + "2" * 64, "env": OLD20_ENV},
                      RETIRED: {"digest": "sha256:" + "3" * 64, "env": OLD20_ENV}},
        "functions": fns, "clock": 0,
        "secrets": {"ZIPPER_SENDGRID_API_KEY": {"versions": ["ENABLED"], "members": ["serviceAccount:" + FN_SA, "serviceAccount:" + BACKEND_SA]},
                    "SENDGRID_API_KEY": {"versions": ["ENABLED"], "members": ["serviceAccount:" + BACKEND_SA]},
                    "OWNER_MFA_ENCRYPTION_KEY": {"versions": ["ENABLED"], "members": ["serviceAccount:" + BACKEND_SA]}},
        "project_roles": {"roles/editor": ["serviceAccount:" + FN_SA, "serviceAccount:" + BACKEND_SA],
                          "roles/firebasestorage.serviceAgent": ["serviceAccount:" + AGENT]},
        "rules": {"firestore": HOTFIX_FS, "storage": HOTFIX_ST},   # hotfix-1, live since 1 Nov
        "hosting_version": OLD_CRM,
        "android": {"debug": {"versionCode": 19, "versionName": "1.2.5", "notes": "1.2.5", "mandatory": False,
                              "publishedAt": "2026-10-20T08:00:00+00:00", "abis": {"arm64-v8a": {"url": "u19", "sha256": "0" * 64, "sizeBytes": 1}},
                              "url": "u19", "sha256": "0" * 64, "sizeBytes": 1},
                    "release": {"versionCode": 3, "versionName": "1.0.3"}},
        "monitoring": {"policies": [], "channels": [], "uptime": []},
        "backend_state": {},
        "log_counts": {"accepted (": 1},
        "indexes": {"composite": [
            live_ix("calls", [{"fieldPath": "status", "order": "ASCENDING"}, {"fieldPath": "createdAt", "order": "DESCENDING"}, {"fieldPath": "__name__", "order": "DESCENDING"}], 1),
            live_ix("agents", [{"fieldPath": "referralCode", "order": "ASCENDING"}, {"fieldPath": "status", "order": "ASCENDING"}, {"fieldPath": "__name__", "order": "ASCENDING"}], 2)],
            "fields": [live_field("__default__", "*", [("COLLECTION", "ASCENDING"), ("COLLECTION", "DESCENDING"), ("COLLECTION", "CONTAINS")]),
                       live_field("beanTransactions", "type", [("COLLECTION_GROUP", "ASCENDING")])]},
    }


T = Path(tempfile.mkdtemp(prefix="zrel-")).resolve()   # macOS: /var → /private/var, as the scripts see it
REPO, HOME, BIN = T / "repo", T / "home", T / "bin"
RELC = REPO / "release" / REL.name
STATE, LOG = T / "state.json", T / "calls.log"


def mkcert(name, subj):
    """A self-signed RSA 2048 certificate (DER), made by openssl as a debug keystore holds one; the key stays in T."""
    der = T / "certs" / (name + ".der")
    der.parent.mkdir(parents=True, exist_ok=True)
    try:
        subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "2", "-subj", subj,
                        "-keyout", str(T / "certs" / (name + ".key")), "-outform", "DER", "-out", str(der)],
                       capture_output=True, timeout=120)
    except (OSError, subprocess.SubprocessError):
        pass
    return der.read_bytes() if der.exists() else b""


# "fleet" stands for the key that signed APK 19 (its SHA-256 replaces FLEET_CERT_SHA256 in the copy's rel_common.sh),
# "other" for another Mac's debug key (the same subject, another key), "release" for a release key.
CERTS = {"fleet": mkcert("fleet", "/CN=Android Debug/O=Android/C=US"), "other": mkcert("other", "/CN=Android Debug/O=Android/C=US"),
         "release": mkcert("release", "/CN=Zipper Release/O=Zipper")}
ok("openssl made the test certificates: fleet, another Mac's debug key (same subject), a release key",
   all(CERTS.values()) and len(set(CERTS.values())) == 3)
FLEET_SHA = hashlib.sha256(CERTS["fleet"]).hexdigest()


def lp(b):
    return struct.pack("<I", len(b)) + b


def signed_zip(meta, certs):
    """A synthetic APK: a ZIP whose entry harness-meta.txt carries what the aapt / apksigner / publish_apk stubs read
    and, unless certs is None, an APK Signing Block between the entries and the central directory (the end record
    pointing past it) with one APK Signature Scheme v2 signer listing `certs` (DER). Nothing is signed: tools/apk_cert.py
    only reads the block; the apksigner stub stands in for the verification."""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("AndroidManifest.xml", "harness")
        z.writestr("harness-meta.txt", meta)
    d = buf.getvalue()
    if certs is None:
        return d
    eocd = len(d) - 22                                                         # no ZIP comment
    cd = struct.unpack_from("<I", d, eocd + 16)[0]
    signed_data = lp(b"") + lp(b"".join(lp(c) for c in certs)) + lp(b"")       # digests, certificates, attributes
    value = lp(lp(lp(signed_data) + lp(b"") + lp(b"")))                        # signers: one (signed data, signatures, key)
    pair = struct.pack("<QI", 4 + len(value), 0x7109871A) + value
    size = len(pair) + 24
    block = struct.pack("<Q", size) + pair + struct.pack("<Q", size) + b"APK Sig Block 42"
    return d[:cd] + block + d[cd:eocd + 16] + struct.pack("<I", cd + len(block)) + d[eocd + 20:]


def put(st):
    STATE.write_text(json.dumps(st))


def st():
    return json.loads(STATE.read_text())


def w(path, text, mode=None):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)
    if mode:
        path.chmod(mode)


def git(*args, check=True):
    return subprocess.run(["git", "-C", str(REPO), "-c", "user.name=harness", "-c", "user.email=harness@example.invalid",
                           "-c", "commit.gpgsign=false", *args], capture_output=True, text=True, check=check).stdout.strip()


# stubs (node -e prints the export list of the harness's control file T/exports.txt: the 168 functions of the release)
EXPORTS = T / "exports.txt"
GOOD_EXPORTS = "".join("EXPORT %s %s\n" % (n, "us-central1" if n in US_CENTRAL1 else "asia-south1") for n in ALL_FNS)
EXPORTS.write_text(GOOD_EXPORTS)
for name, body in [("gcloud", GCLOUD_STUB), ("firebase", FIREBASE_STUB), ("npm", NPM_STUB), ("node", NODE_STUB.replace("@EXPORTS@", str(EXPORTS))),
                   ("curl", CURL_STUB), ("sleep", SLEEP_STUB), ("date", DATE_STUB)] + \
                  ([] if shutil.which("shasum") else [("shasum", SHASUM_STUB)]):
    w(BIN / name, body, 0o755)
BT = HOME / "Library" / "Android" / "sdk" / "build-tools" / "35.0.0"
w(BT / "aapt2", AAPT_STUB, 0o755)
w(BT / "apksigner", APKSIGNER_STUB, 0o755)

# the repository: NOTPROD (the f1af30a stand-in: an ancestor of HEAD whose functions/ is NOT production), branch
# prod-live-20261030 = PROD (the production Functions tree; not an ancestor of HEAD), a TAG of the same base name on
# NOTPROD (the short name resolves to the tag; only refs/heads/… finds PROD), LIVE (the cf64145 stand-in: the
# completion release, an ancestor of HEAD), then the release commit (functions v2 + this folder, whose rel_common.sh
# names PROD / NOTPROD / LIVE in place of 4e21b7f… / f1af30a… / cf64145…)
w(REPO / ".gitignore", "node_modules/\nfunctions/lib/\n**/build/\nbackend/.venv/\n.env\n.env.*\nzipper-crm/out/\nzipper-crm/.next/\n*.log\n__pycache__/\n")
w(REPO / "backend" / "Dockerfile", "FROM python:3.12-slim@sha256:" + "a" * 64 + "\nCOPY requirements.lock .\nRUN pip install --no-cache-dir --no-deps -r requirements.lock && pip check\nCOPY . .\n")
w(REPO / "backend" / "requirements.lock", "fastapi==0.110.0\nuvicorn==0.29.0\n")
w(REPO / "backend" / "requirements.txt", "fastapi\nuvicorn\n")
w(REPO / "backend" / ".gcloudignore", ".venv/\n")
w(REPO / "backend" / "app" / "main.py", "print('Zipper API ready')\n")
w(REPO / "backend" / "app" / "config.py", "x = 1\n")
w(REPO / "backend" / "scripts" / "publish_apk.py", "raise SystemExit('the harness never runs the real publisher')\n")
w(REPO / "backend" / ".venv" / "bin" / "python", VENV_STUB, 0o755)
w(REPO / "functions" / "package.json", '{"name":"functions","scripts":{"build":"tsc"}}\n')
w(REPO / "functions" / "package-lock.json", '{"lockfileVersion":3}\n')
w(REPO / "functions" / "src" / "index.ts", NOTPROD_SRC + "\nexport const x = 1\n")
w(REPO / "functions" / "src" / "mail.ts", "// reads ZIPPER_SENDGRID_API_KEY via runWith({ secrets })\n")
w(REPO / "functions" / "test" / "a.test.js", "// test\n")
w(REPO / "functions" / ".env", "".join("%s=%s\n" % kv for kv in FN_ENV.items()))
w(REPO / "tests" / "package.json", '{"name":"rules-tests"}\n')
w(REPO / "zipper-crm" / "package.json", '{"name":"zipper-crm"}\n')
w(REPO / "zipper-crm" / "app" / "page.tsx", "export default function P() { return null }\n")
w(REPO / "firestore.rules", RC2_FS)
w(REPO / "storage.rules", RC2_ST)
w(REPO / "firestore.indexes.json", json.dumps(IDX_FILE, indent=1) + "\n")
w(REPO / "firebase.json", json.dumps({"firestore": {"rules": "firestore.rules"}, "storage": {"rules": "storage.rules"},
                                      "functions": [{"source": "functions", "codebase": "default"}],
                                      "hosting": [{"target": "production", "public": "zipper-crm/out"}]}, indent=1) + "\n")
w(REPO / ".firebaserc", '{"projects":{"default":"zipper-83816"}}\n')
w(REPO / "deploy-crm.command", DEPLOY_CRM, 0o755)
w(REPO / "zipper-app" / "app" / "build.gradle.kts", 'android {\n    defaultConfig {\n        versionCode = 22\n        versionName = "1.2.8"\n    }\n    buildTypes { create("prod") { } }\n}\n')
HF = REPO / "hotfix" / "rules-20261101"
w(HF / "firestore.rules", HOTFIX_FS)
w(HF / "storage.rules", HOTFIX_ST)
w(HF / "SHA256SUMS", "%s  firestore.rules\n%s  storage.rules\n" % (sha(HOTFIX_FS), sha(HOTFIX_ST)))
subprocess.run(["git", "init", "-q", str(REPO)], check=True)
git("add", "-A")
git("commit", "-q", "-m", "base (not production: unshipped Owner-MFA gate)")
NOTPROD = git("rev-parse", "HEAD")
git("checkout", "-q", "-b", "prod-live-20261030")
w(REPO / "functions" / "src" / "index.ts", PROD_SRC + "\nexport const x = 0\n")
git("commit", "-q", "-am", "production as live since 30 Oct")
PROD = git("rev-parse", "HEAD")
git("checkout", "-q", "-")
git("tag", "prod-live-20261030", NOTPROD)
w(REPO / "functions" / "src" / "index.ts", LIVE_SRC + "\nexport const x = 1\n")
git("commit", "-q", "-am", "the completion release (cf64145 stand-in: what the completion wave 2a runs)")
LIVE = git("rev-parse", "HEAD")
shutil.copytree(REL, RELC, ignore=shutil.ignore_patterns("production", "RELEASE.txt", "SCRIPTS.sha256", "scripts-mac-*", "__pycache__", "rules-results"))
rcs_copy = (RELC / "rel_common.sh").read_text(encoding="utf-8")
ok("the copy's rel_common.sh names 4e21b7f…, f1af30a…, cf64145… and the fleet certificate 4878a35f… (pointed at PROD / NOTPROD / LIVE of the throwaway repository and the harness's fleet certificate)",
   REAL_PROD in rcs_copy and REAL_NOTPROD in rcs_copy and REAL_LIVE in rcs_copy and REAL_FLEET in rcs_copy)
(RELC / "rel_common.sh").write_text(rcs_copy.replace(REAL_PROD, PROD).replace(REAL_NOTPROD, NOTPROD).replace(REAL_LIVE, LIVE)
                                    .replace(REAL_FLEET, FLEET_SHA), encoding="utf-8")
old = time.time() - 300
for f in [REPO / "firestore.rules", REPO / "storage.rules", HF / "firestore.rules", HF / "storage.rules"]:
    os.utime(f, (old, old))
ENV = {"PATH": "%s:/usr/bin:/bin" % BIN, "HOME": str(HOME), "CLOUDSDK_CONFIG": str(T / "no-gcloud-config"),
       "STUB_STATE": str(STATE), "STUB_LOG": str(LOG), "LANG": "C", "TZ": "UTC"}
p = subprocess.run(["/bin/bash", str(RELC / "tools" / "write-scripts-sha256.command")], capture_output=True, text=True, env=ENV)
ok("tools/write-scripts-sha256.command writes the list", p.returncode == 0 and (RELC / "SCRIPTS.sha256").exists(), p.stdout + p.stderr)
listed = sorted(l.split(None, 1)[1].strip() for l in (RELC / "SCRIPTS.sha256").read_text().splitlines() if l.strip())
ok("SCRIPTS.sha256 lists exactly the production files (scripts, libs, helpers, make-release-txt.sh; not the harness)",
   listed == EXPECT_SHA_LIST, set(listed) ^ set(EXPECT_SHA_LIST))
w(REPO / "functions" / "src" / "index.ts", "// functions v2 (RELEASE)\nexport const x = 2\n")
git("add", "-A")
git("commit", "-q", "-m", "release")
HEAD = git("rev-parse", "HEAD")
put(fresh_state())


ALL_CALLS = []


def run(script, stdin="", args=(), env=None):
    if LOG.exists():
        ALL_CALLS.append(LOG.read_text())
        LOG.unlink()
    p = subprocess.run(["/bin/bash", str(RELC / script), *args], input=stdin, text=True, env=dict(ENV, **(env or {})),
                       capture_output=True, timeout=900)
    return p.returncode, p.stdout + p.stderr


def calls():
    return LOG.read_text() if LOG.exists() else ""


def newest(prefix):
    d = sorted((RELC / "production").glob(prefix + "*Z"))
    return d[-1] if d else None


def leaks(o):
    return [x for x in SECRET_VALUES + PEOPLE if x in o]


# Inside the scripts' own environment (rel_common.sh adds fallback PATH entries), every tool is a stub.
probe = RELC / "_probe.sh"
probe.write_text('. "$(dirname "$0")/rel_common.sh"\nfor x in gcloud firebase npm node curl sleep; do command -v $x; done\n')
_, where = run("_probe.sh")
probe.unlink()
ok("inside the scripts, gcloud/firebase/npm/node/curl/sleep are the stubs (no real tool can run)",
   len(where.split()) == 6 and all(x.startswith(str(BIN) + "/") for x in where.split()), where)
if not (len(where.split()) == 6 and all(x.startswith(str(BIN) + "/") for x in where.split())):
    print("ABORT: a real tool would run inside the scripts; nothing else is run.")
    sys.exit(2)

# ── make-release-txt.sh: rollback base = refs/heads/prod-live-20261030 by default, still the reviewed commit; f1af30a refused ──
w(REPO / "backend" / "app" / "scratch.py", "x = 1\n")
rc, o = run("make-release-txt.sh")
ok("make-release-txt.sh refuses a dirty tree (exit 3, names the path)", rc == 3 and "scratch.py" in o and not (RELC / "RELEASE.txt").exists(), o[-300:])
(REPO / "backend" / "app" / "scratch.py").unlink()
rc, o = run("make-release-txt.sh", args=("deadbeef",))
ok("make-release-txt.sh refuses an unknown BASE_COMMIT", rc == 3 and not (RELC / "RELEASE.txt").exists(), o[-300:])
rc, o = run("make-release-txt.sh", args=(HEAD[:9],))
ok("make-release-txt.sh refuses BASE_COMMIT = HEAD", rc == 3, o[-300:])
rc, o = run("make-release-txt.sh", args=(NOTPROD[:7],))
ok("make-release-txt.sh refuses f1af30a (its stand-in) with the reason: NOT production, unshipped Owner-MFA gate",
   rc == 3 and "NOT production" in o and "Owner-MFA" in o and not (RELC / "RELEASE.txt").exists(), o[-400:])
rc, o = run("make-release-txt.sh", args=("prod-live-20261030",))
ok("make-release-txt.sh never resolves the short name (an argument must be a commit id)", rc == 3 and "commit id" in o and not (RELC / "RELEASE.txt").exists(), o[-300:])
git("branch", "-f", "prod-live-20261030", NOTPROD)
rc, o = run("make-release-txt.sh")
ok("make-release-txt.sh refuses the production branch once it moved off the reviewed commit", rc == 3 and "moved" in o and not (RELC / "RELEASE.txt").exists(), o[-400:])
git("branch", "-f", "prod-live-20261030", PROD)
rc, o = run("make-release-txt.sh")
rel = (RELC / "RELEASE.txt").read_text() if (RELC / "RELEASE.txt").exists() else ""
ok("make-release-txt.sh (no argument) records BASE_COMMIT = refs/heads/prod-live-20261030 (not the same-named tag), BASE_REF, HEAD, LIVE_FN_COMMIT",
   rc == 0 and "BASE_COMMIT=%s\n" % PROD in rel and "BASE_REF=refs/heads/prod-live-20261030\n" in rel and "HEAD=%s\n" % HEAD in rel
   and "LIVE_FN_COMMIT=%s\n" % LIVE in rel and "(ancestor of HEAD)" in o, o[-600:])
ok("make-release-txt.sh writes RELEASE.txt: HEAD, BASE_COMMIT, 4 TREE + 7 FILE lines, verified",
   rc == 0 and "HEAD=%s\n" % HEAD in rel and "BASE_COMMIT=%s\n" % PROD in rel and len(re.findall(r"^TREE ", rel, re.M)) == 4
   and len(re.findall(r"^FILE ", rel, re.M)) == 7 and "TREE functions/src " in rel and "TREE zipper-crm " in rel
   and "FILE zipper-app/app/build.gradle.kts " in rel, o[-600:])
ok("RELEASE.txt and production/ are git-ignored (the tree stays clean)", git("status", "--porcelain") == "", git("status", "--porcelain"))
relp = RELC / "RELEASE.txt"; good_rel0 = relp.read_text()
relp.write_text("\n".join(l for l in good_rel0.splitlines() if not l.startswith("LIVE_FN_COMMIT=")) + "\n")
rc, o = run("00-preflight-readonly.command")
ok("a RELEASE.txt without LIVE_FN_COMMIT is refused (00: exit 3)", rc == 3 and "LIVE_FN_COMMIT absent" in o, o[-400:])
relp.write_text(good_rel0.replace("LIVE_FN_COMMIT=" + LIVE, "LIVE_FN_COMMIT=" + PROD))
rc, o = run("00-preflight-readonly.command")
ok("a RELEASE.txt whose LIVE_FN_COMMIT is not an ancestor of HEAD is refused (00: exit 3)", rc == 3 and "NOT-AN-ANCESTOR-OF-HEAD" in o, o[-400:])
relp.write_text(good_rel0)

# ── 00 preflight ──
rc, o = run("00-preflight-readonly.command")
ok("00 read-only preflight passes on the expected production state", rc == 0 and "RESULT: PASS" in o, o[-1500:])
MUTATING = r"add-iam|remove-iam|firebase deploy|run deploy|update-traffic|run services update | create |android_update_doc.py restore|--apply|POST"
ok("00 runs no mutating command", not re.search(MUTATING, calls()), re.findall(r".*(?:%s).*" % MUTATING, calls())[:3])
ok("00 shows no environment value, secret or unmasked address", not leaks(o), leaks(o))

# ── 11 backend no-traffic ──
rc, o = run(C11, "NO\n")
ok("11 refuses without DEPLOY (exit 4), no deploy", rc == 4 and "run deploy" not in calls(), o[-400:])

# The 1 Nov sequence: a run whose e-mail check finds no 'accepted' line creates a revision at 0% and records nothing;
# a re-run must accept that revision as the template (and only that one). Afterwards the state is put back as it was,
# so the normal run below starts from the same production state as before.
SNAP = st()
BS11 = RELC / "production" / "backend-revision.txt"
s = st(); s["log_counts"] = {}; put(s)
rc, o = run(C11, "DEPLOY\nEMAIL\nUNTAG\n")
ok("11 with no mail log line: polls up to 3 min, then 1 check fails, nothing recorded, traffic and tag as before",
   rc == 1 and "after 180 s: mail log lines: 0; accepted: 0" in o and "FAIL  SendGrid accepted the message" in o
   and "NOT recorded" in o and not BS11.exists() and st()["service"]["traffic"] == [{"revisionName": SERVING, "percent": 100}]
   and not st()["service"]["tags"], o[-1500:])
s = st(); s["log_counts"] = {"accepted (": 1}; put(s)
rc, o = run(C11, "DEPLOY\nEMAIL\nUNTAG\n")
ok("11 re-run: the template is the revision the failed run created and verified -> accepted; a new revision, PASS, recorded",
   rc == 0 and "RESULT: PASS" in o and "this is a re-run of 11" in o and "after 15 s: mail log lines: 1; accepted: 1" in o
   and BS11.exists() and "name=zipper-api-00059-rer\n" in BS11.read_text() and "head=%s\n" % HEAD in BS11.read_text(), o[-2500:])
ok("11 re-run: environment = template + the SendGrid settings, each name once", "environment = template + SENDGRID_API_KEY" in o, o[-1500:])
put(SNAP)
if BS11.exists():
    BS11.unlink()
s = st(); s["log_counts"] = {"FAILED (HTTP": 1}; put(s)
rc, o = run(C11, "DEPLOY\nEMAIL\nUNTAG\n")
ok("11: a FAILED mail line for the revision fails the e-mail check at the first read, nothing recorded",
   rc == 1 and "after 15 s: mail log lines: 1; accepted: 0" in o and "FAIL  no failed or unsent mail line" in o and not BS11.exists(), o[-1500:])
put(SNAP)
s = st(); s["service"]["template_env"] = s["service"]["template_env"] + [{"name": "SOMETHING_ELSE", "value": "x"}]; put(s)
rc, o = run(C11, "DEPLOY\n")
ok("11 refuses a template with other changes that no earlier run of 11 created", rc == 3 and "no earlier run of 11 in this folder created it" in o and "run deploy" not in calls(), o[-600:])
put(SNAP)
for d in (RELC / "production").glob("11-deploy-backend-*Z"):
    shutil.rmtree(d)

rc, o = run(C11, "DEPLOY\nEMAIL\nUNTAG\n")
c = calls()
ok("11 deploys at 0%, smoke-tests, sends one e-mail, untags: PASS", rc == 0 and "RESULT: PASS" in o, o[-2500:])
ok("11 ran the reviewed deploy (no traffic, tag, SendGrid secret + 3 settings)",
   "gcloud run deploy zipper-api --project zipper-83816 --region asia-south1 --source . --no-traffic --tag trackb-%s --update-secrets SENDGRID_API_KEY=ZIPPER_SENDGRID_API_KEY:1 --update-env-vars EMAIL_PROVIDER=sendgrid,SENDGRID_FROM_EMAIL=no-reply@zipperlive.org,SENDGRID_FROM_NAME=ZIPPER Live" % HEAD[:7] in c)
s = st()
ok("11 left traffic on %s and removed the tag" % SERVING, s["service"]["traffic"] == [{"revisionName": SERVING, "percent": 100}] and not s["service"]["tags"])
bs = (RELC / "production" / "backend-revision.txt")
ok("11 recorded backend-revision.txt (NEW, BASE, digest, HEAD)", bs.exists() and "name=%s\n" % NEW in bs.read_text() and "base=%s\n" % SERVING in bs.read_text() and "head=%s\n" % HEAD in bs.read_text())
ok("11 shows no environment value or unmasked address", not leaks(o), leaks(o))
rc, o = run(C11, "DEPLOY\n")
ok("11 refuses a second deploy while backend-revision.txt exists", rc == 3 and "run deploy" not in calls(), o[-300:])
s = st(); s["backend_state"] = {"new": NEW, "base": SERVING}; put(s)

# ── 12 / 13 canary, 19 rollback ──
rc, o = run(C12, "NO\n", ("10",))
ok("12 10 refuses without CANARY10 (exit 4)", rc == 4 and "update-traffic" not in calls(), o[-300:])
rc, o = run(C12, "CANARY10\n", ("10",))
ok("12 10 sets NEW=10/BASE=90 by name: PASS", rc == 0 and "RESULT: PASS" in o and UT + "--to-revisions %s=10,%s=90" % (NEW, SERVING) in calls(), o[-800:])
rc, o = run(C12, "NO\n", ("back",))
ok("12 back refuses without BACK (exit 4)", rc == 4 and "update-traffic" not in calls(), o[-300:])
rc, o = run(C12, "BACK\n", ("back",))
ok("12 back pins BASE=100 with the reviewed command: PASS", rc == 0 and UT + "--to-revisions %s=100" % SERVING in calls() and st()["service"]["traffic"][0]["revisionName"] == SERVING, o[-500:])
time.sleep(1.1)
rc, o = run(C12, "CANARY10\n", ("10",))
time.sleep(1.1)
rc, o = run(C12, "CANARY50\n", ("50",))
ok("12 50 refuses without a newer CONTINUE monitor run", rc == 3 and "update-traffic" not in calls(), o[-300:])
time.sleep(1.1)
rc, o = run("13-canary-monitor-readonly.command", "", ("60",))
ok("13 monitor (read-only) says CONTINUE on a healthy canary", "RESULT: CONTINUE" in o and not re.search(r"update-traffic|deploy", calls()), o[-800:])
ok("13 writes no URL or query string", "q=secret" not in o and not any("q=secret" in p.read_text(errors="replace") for p in newest("13-monitor-").iterdir() if p.is_file()))
time.sleep(1.1)
rc, o = run(C12, "CANARY50\n", ("50",))
ok("12 50 after CONTINUE: PASS", rc == 0 and "RESULT: PASS" in o, o[-500:])
time.sleep(1.1)
run("13-canary-monitor-readonly.command", "", ("60",))
time.sleep(1.1)
rc, o = run(C12, "CANARY100\n", ("100",))
ok("12 100: NEW serves 100%: PASS", rc == 0 and st()["service"]["traffic"] == [{"revisionName": NEW, "percent": 100}], o[-500:])
rc, o = run(C19, "NO\n")
ok("19 refuses without ROLLBACK (exit 4)", rc == 4 and "update-traffic" not in calls(), o[-300:])
rc, o = run(C19, "ROLLBACK\n")
ok("19 rollback pins BASE=100 with the reviewed command: PASS", rc == 0 and "RESULT: PASS" in o and UT + "--to-revisions %s=100" % SERVING in calls(), o[-500:])
rc, o = run(C19, "")
ok("19 re-run: nothing to do, no prompt", rc == 0 and "ABOUT TO" not in o and "update-traffic" not in calls(), o[-300:])
s = st(); s["service"]["traffic"] = [{"revisionName": NEW, "percent": 100}]; put(s)   # canary re-done (as tested above)

# A later commit after 11 recorded the backend (2 Nov: the deploy-crm.command fix, after the backend was at 100%).
# With NEW at 100%, `12 10` passes the record check and then stops at the split check — that proves which check spoke.
w(REPO / "deploy-crm.command", DEPLOY_CRM.replace("#!/bin/bash", "#!/bin/bash\n# a later fix, no backend file", 1), 0o755)
git("add", "deploy-crm.command"); git("commit", "-q", "-m", "a later fix, no backend file")
run("make-release-txt.sh")
rc, o = run(C12, "", ("10",))
ok("12: backend-revision.txt of an ancestor commit with the same backend/ tree is accepted (note), then the split is checked",
   "has the same backend/ tree" in o and "not RELEASE.txt's HEAD" not in o and "current split is not the previous step" in o, o[-800:])
w(REPO / "backend" / "app" / "config.py", "x = 2\n")
git("add", "backend/app/config.py"); git("commit", "-q", "-m", "a backend change after 11")
run("make-release-txt.sh")
rc, o = run(C12, "", ("10",))
ok("12 refuses backend-revision.txt once backend/ changed after it was written", rc == 3 and "not RELEASE.txt's HEAD, nor an ancestor" in o, o[-600:])
rc, o = run(C45, "", env={"ALL_OWNERS_ENROLLED": "yes"})
ok("45 refuses it the same way", rc == 3 and "not RELEASE.txt's HEAD, nor an ancestor" in o, o[-600:])
git("reset", "-q", "--hard", HEAD)
run("make-release-txt.sh")
ok("back at the reviewed HEAD for the rest of the run", git("rev-parse", "HEAD") == HEAD and "HEAD=%s\n" % HEAD in (RELC / "RELEASE.txt").read_text())

# ── 33 Firestore indexes ──
good_ix = st()["indexes"]
s = st(); s["indexes"]["composite"].append(live_ix("legacyThings", [{"fieldPath": "a", "order": "ASCENDING"}, {"fieldPath": "b", "order": "ASCENDING"}, {"fieldPath": "__name__", "order": "ASCENDING"}], 9)); put(s)
rc, o = run(C33, "INDEXES\n")
ok("33 refuses when a live composite index is not in firestore.indexes.json (it could be deleted), nothing deployed",
   rc == 3 and "LIVE-NOT-IN-FILE index legacyThings" in o and "firebase deploy" not in calls(), o[-500:])
s = st(); s["indexes"] = json.loads(json.dumps(good_ix)); s["indexes"]["fields"][1] = live_field("beanTransactions", "type", [("COLLECTION_GROUP", "ASCENDING"), ("COLLECTION", "ASCENDING")]); put(s)
rc, o = run(C33, "INDEXES\n")
ok("33 refuses a field override of the file that would drop a live single-field index, nothing deployed",
   rc == 3 and "WOULD-REMOVE field-override beanTransactions.type COLLECTION ASCENDING" in o and "firebase deploy" not in calls(), o[-500:])
s = st(); s["indexes"] = json.loads(json.dumps(good_ix)); put(s)
rc, o = run(C33, "NO\n")
ok("33 refuses without INDEXES (exit 4) after its read-only superset check; nothing deployed",
   rc == 4 and "SUPERSET ok" in o and "TO-CREATE index publicProfiles" in o and "firebase deploy" not in calls(), o[-600:])
rc, o = run(C33, "INDEXES\n")
ev33 = newest("33-indexes-")
ix_now = st()["indexes"]
ok("33 deploys ONLY firestore:indexes from a temp folder with the reviewed command, waits until READY: PASS",
   rc == 0 and "RESULT: PASS" in o and "firebase deploy --only firestore:indexes --project zipper-83816 --non-interactive [cwd=%s/deploy-workdir]" % ev33 in calls()
   and len(ix_now["composite"]) == 4 and all(x["state"] == "READY" for x in ix_now["composite"]) and "still building" in o, o[-1500:])
wd33 = (ev33 or T) / "deploy-workdir"
ok("33 deploy folder: only firestore.indexes.json and firebase.json {\"firestore\":{\"database\":\"(default)\",\"indexes\":…}}",
   wd33.is_dir() and sorted(x.name for x in wd33.iterdir()) == ["firebase.json", "firestore.indexes.json"]
   and json.loads((wd33 / "firebase.json").read_text()) == {"firestore": {"database": "(default)", "indexes": "firestore.indexes.json"}})
ok("33 kept every index live before (KEPT-ALL) and changed no rules", "every index that was live before is still live" in o
   and st()["rules"]["firestore"] == HOTFIX_FS and st()["rules"]["storage"] == HOTFIX_ST, o[-600:])
rc, o = run(C33, "")
ok("33 re-run: nothing to deploy, no prompt, READY: PASS", rc == 0 and "ABOUT TO" not in o and "firebase deploy" not in calls() and "RESULT: PASS" in o, o[-400:])
s = st(); s["indexes"]["composite"][3]["state"] = "CREATING"; s["indexes_stuck"] = True; put(s)
rc, o = run(C33, "")
ok("33 reports the indexes still building after its 30-minute poll (FAIL) and deploys nothing",
   rc == 1 and "BUILDING index techTickets" in o and "still building after 30 min" in o and "firebase deploy" not in calls(), o[-600:])
s = st(); s.pop("indexes_stuck"); s["indexes"]["composite"][3]["state"] = "READY"; put(s)

# ── 20 / 29 Functions wave 2a ──
WAVE_2A_ONLY = ",".join("functions:" + n for n in WAVE_2A)
rc, o = run(C20, "NO\n")
ok("20 refuses without DEPLOY2A (exit 4), after building, testing and classifying the exact tree",
   rc == 4 and "firebase deploy" not in calls() and "node --test on the exact tree: 3/3" in o and "CLASSIFY ok" in o
   and "each of the 168 exported functions is in exactly one of WAVE_2A, WAVE_2B, NOT_REDEPLOYED" in o
   and "BASES ok" in o and "every deployed function has one rollback base" in o, o[-800:])
ncalls = Path(str(EXPORTS) + ".calls").read_text() if Path(str(EXPORTS) + ".calls").exists() else ""
ok("20 lists the exports with node -e in the built deploy tree, empty environment (no stub log, demo project id)",
   re.search(r"cwd=\S*/production/20-functions-2a-\d{8}T\d{6}Z/deploy/functions home=\S*/home stublog=unset gcloud_project=demo-zipper-exports", ncalls), ncalls[-300:])
EXPORTS.write_text("module load says hello (not an export line)\n" + GOOD_EXPORTS + "EXPORT brandNewFunction asia-south1\n")
rc, o = run(C20, "DEPLOY2A\n")
ok("20 refuses an exported function that is in no list (UNCLASSIFIED), nothing deployed",
   rc == 3 and "UNCLASSIFIED brandNewFunction" in o and "EXPORTS 169 " in o and "firebase deploy" not in calls(), o[-600:])
EXPORTS.write_text("".join(l + "\n" for l in GOOD_EXPORTS.splitlines() if not l.startswith("EXPORT syncPhoneKey ")))
rc, o = run(C20, "DEPLOY2A\n")
ok("20 refuses a listed function the deploy tree does not export (NOT-EXPORTED), nothing deployed",
   rc == 3 and "NOT-EXPORTED syncPhoneKey (listed in WAVE_2A)" in o and "firebase deploy" not in calls(), o[-600:])
EXPORTS.write_text(GOOD_EXPORTS.replace("EXPORT scheduledAlertScan us-central1", "EXPORT scheduledAlertScan asia-south1"))
rc, o = run(C20, "DEPLOY2A\n")
ok("20 refuses a function declared in another region than the scripts describe it in, nothing deployed",
   rc == 3 and "REGION scheduledAlertScan code=asia-south1 scripts=us-central1" in o and "firebase deploy" not in calls(), o[-600:])
EXPORTS.write_text(GOOD_EXPORTS)
s = st(); s["deploy_fail_after"] = 40; put(s)
rc, o = run(C20, "DEPLOY2A\n")
ev20p = newest("20-functions-2a-")
upd = (ev20p / "updated.txt").read_text().split() if (ev20p / "updated.txt").exists() else []
nupd = (ev20p / "not-updated.txt").read_text().split() if (ev20p / "not-updated.txt").exists() else []
ok("20 after a deploy that stops part-way (CLI exit 2): FAIL, SCOPE PARTIAL, updated.txt = the 40 updated, not-updated.txt = the other 109",
   rc == 1 and "SCOPE PARTIAL" in o and "WAVE updated=40 of 149" in o and upd == sorted(WAVE_2A[:40]) and nupd == sorted(WAVE_2A[40:])
   and "29-rollback-functions.command 2a %s" % ev20p in o, o[-1500:])
rc, o = run(C29, "ROLLBACK\n", ("2b", str(ev20p)))
ok("29 refuses an evidence folder of another wave", rc == 3 and "not an evidence folder of wave 2b" in o and "firebase deploy" not in calls(), o[-300:])
rc, o = run(C29, "ROLLBACK\n", ("2a", str(ev20p)))
ok("29 2a <that evidence> rolls back EXACTLY the 40 updated functions, each to the tree it ran before (LIVE: cf64145 stand-in): PASS",
   rc == 0 and "RESULT: PASS" in o and "rolling back EXACTLY the 40 function(s)" in o
   and "firebase deploy --only %s --project zipper-83816 --non-interactive" % ",".join("functions:" + n for n in sorted(WAVE_2A[:40])) in calls()
   and all(st()["functions"][n]["source"] == LIVE_SRC for n in WAVE_2A[:40])
   and all(n not in st()["functions"] for n in NEW_FNS) and "SCOPE PASS" in o and "changed=40" in o
   and "deploy-prod" not in calls(), o[-1500:])
time.sleep(1.1)
s = st(); s["deploy_in_progress"] = "partyHeartbeat"; put(s)
rc, o = run(C20, "DEPLOY2A\n")
ok("20 deploys wave A only and verifies (SCOPE PASS, changed=149 incl. the 64 new), after waiting for an update still running: PASS",
   rc == 0 and "RESULT: PASS" in o and "SCOPE PASS" in o and "changed=149" in o and "still deploying (1/20" in o
   and "note: partyHeartbeat does not exist yet (new in this release)" in o, o[-1500:])
ok("20 checked every function's own runtime identity (1st gen App Engine; new ones by generation) and region", "all 149 functions keep their runtime identity" in o
   and "all 149 functions ACTIVE" in o, o[-1500:])
ok("20 ran exactly the reviewed command", "firebase deploy --only %s --project zipper-83816 --non-interactive" % WAVE_2A_ONLY in calls())
ok("20 deployed the RELEASE tree (functions v2) to the 149, nothing to wave B or NOT_REDEPLOYED (they keep LIVE / PROD)",
   all(st()["functions"][n]["source"].startswith("// functions v2") for n in WAVE_2A)
   and all(st()["functions"][n]["source"] == (PROD_SRC if n in ON_PROD_TREE else LIVE_SRC) for n in WAVE_2B + NOT_REDEPLOYED))
ok("20 left no .env copy and no node_modules", not list((RELC / "production").glob("20-*/deploy/functions/.env")) and not list((RELC / "production").glob("20-*/deploy/functions/node_modules")))
ok("20's deploy folder holds the whole commit (the functions tests read ../firestore.rules)",
   (newest("20-functions-2a-") / "deploy" / "firestore.rules").exists() and (newest("20-functions-2a-") / "deploy" / "functions" / "package.json").exists())
ok("20 output shows no environment value", not leaks(o), leaks(o))
s = st(); s2 = json.loads(json.dumps(s)); s2["functions"]["weeklyPayoutReportGenerator"]["environmentVariables"]["API_BASE"] = "https://other.example"; put(s2)
rc, o = run(C20, "DEPLOY2A\n")
ok("20 refuses when functions/.env differs from the deployed environment (value not shown)", rc == 3 and "firebase deploy" not in calls() and "other.example" not in o, o[-400:])
put(s)
relp = RELC / "RELEASE.txt"; good_rel = relp.read_text()
relp.write_text(good_rel.replace("BASE_COMMIT=" + PROD, "BASE_COMMIT=" + NOTPROD))
rc, o = run(C29, "ROLLBACK\n", ("2a",))
ok("29 refuses a RELEASE.txt whose BASE_COMMIT is f1af30a (its stand-in): NOT production, nothing deployed",
   rc == 3 and "NOT production" in o and "firebase deploy" not in calls(), o[-400:])
relp.write_text(good_rel)
rc, o = run(C29, "NO\n", ("2a",))
ok("29 2a refuses without ROLLBACK (exit 4)", rc == 4 and "firebase deploy" not in calls(), o[-400:])
rc, o = run(C29, "ROLLBACK\n", ("2a",))
ok("29 2a redeploys the 85 changed functions from the LIVE tree (cf64145 stand-in) with the reviewed command and leaves the 64 new ones: PASS",
   rc == 0 and "RESULT: PASS" in o
   and "firebase deploy --only %s --project zipper-83816 --non-interactive" % ",".join("functions:" + n for n in LISTS["WAVE_2A_CHANGED"]) in calls()
   and all(st()["functions"][n]["source"] == LIVE_SRC for n in LISTS["WAVE_2A_CHANGED"])
   and all(st()["functions"][n]["source"].startswith("// functions v2") for n in NEW_FNS)
   and "NOT rolled back — new in this release" in o and "to BASE_COMMIT" in o and "deploy group prod" not in o, o[-1500:])
ok("29 asked for ROLLBACK once and deployed only from the LIVE tree (no PROD group in wave A)",
   o.count("ABOUT TO:") == 1 and "[cwd=%s/deploy-live]" % newest("29-rollback-functions-2a-") in calls() and "deploy-prod" not in calls(), o[-800:])
ok("29 removed its worktree", git("worktree", "list").count("\n") == 0, git("worktree", "list"))
ok("29's deploy folder holds the whole LIVE commit, so its tests (which read ../firestore.rules) ran",
   (newest("29-rollback-functions-2a-") / "deploy-live" / "firestore.rules").exists() and "node --test on the exact tree: 3/3" in o, o[-800:])
time.sleep(1.1)
run(C20, "DEPLOY2A\n")

# ── 50 CRM ──
s = st(); s["service"]["traffic"] = [{"revisionName": SERVING, "percent": 100}]; put(s)
rc, o = run(C50, "CRM\nDEPLOY\n\n")
ok("50 refuses while the completion backend does not serve 100%", rc == 3 and "hosting:production" not in calls(), o[-300:])
s["service"]["traffic"] = [{"revisionName": NEW, "percent": 100}]; put(s)
rc, o = run(C50, "NO\n")
ok("50 refuses without CRM (exit 4); deploy-crm.command not started", rc == 4 and "hosting:production" not in calls(), o[-300:])
rc, o = run(C50, "CRM\nNO\n")
ok("50 records nothing when deploy-crm.command is aborted (FAIL, version unchanged)", rc == 1 and not (RELC / "production" / "crm-live.txt").exists(), o[-400:])
rc, o = run(C50, "CRM\nDEPLOY\n")
crm = (RELC / "production" / "crm-live.txt")
ok("50 runs deploy-crm.command (hosting only) and records the new version: PASS", rc == 0 and "RESULT: PASS" in o and crm.exists()
   and "firebase deploy --project zipper-83816 --only hosting:production" in calls() and "version=c0ffee" in crm.read_text(), o[-800:])
ok("50 shows no unmasked address", not leaks(o), leaks(o))

# ── 31 Firestore rules (RC2 + Track B), 39 rollback, 40 IAM, 41 Storage RC2, 49 rollback ──
# The results of tools/run-trackb-rules-tests.command: release/trackb-20261104/rules-results/results-<UTC>/ (git-ignored).
rc2 = RELC / "rules-results" / "results-20261104T020000Z"
TSV_HEAD = "suite\tmode\texit\tverdict\tfirestore_rules_sha256\tstorage_rules_sha256\tlog\n"
def trackb_tsv(b12=True):
    rows = "rc2\tmust\t0\t→ PASS\t%s\t%s\trc2.log\n" % (sha(RC2_FS), sha(RC2_ST))
    if b12:
        rows += "b12live\tmust\t0\t→ PASS\t%s\t%s\tb12live.log\n" % (sha(RC2_FS), sha(RC2_ST))
    return TSV_HEAD + rows
w(rc2 / "RESULT.txt", "PASS\n")
w(rc2 / "SUMMARY.txt", "firestore rules sha256: %s\nstorage rules sha256: %s\n" % (sha(RC2_FS), sha(RC2_ST)))
w(rc2 / "suites.tsv", trackb_tsv(b12=False))
ok("the rules results folder is git-ignored (rules-results/), the tree stays clean", git("status", "--porcelain") == "", git("status", "--porcelain"))
rc, o = run(C31, "RELEASE\n", (str(rc2),))
ok("31 refuses a results folder of the plain RC2 run (no passing b12live line)", rc == 3 and "is not a Track B rules run" in o and "firebase deploy" not in calls(), o[-400:])
w(rc2 / "suites.tsv", trackb_tsv())
rc, o = run(C31, "NO\n", (str(rc2),))
ok("31 refuses without RELEASE (exit 4); without 60 evidence it says APK 19 phones lose PK battles", rc == 4 and "firebase deploy" not in calls()
   and "b12live PASS" in o and "APK 19 phones lose PK battles" in o, o[-600:])
rc, o = run(C31, "RELEASE\n", (str(rc2),))
ev31 = newest("31-rules-rc2-")
ok("31 releases the Firestore rules + indexes with the reviewed command: PASS", rc == 0 and "RESULT: PASS" in o and st()["rules"]["firestore"] == RC2_FS
   and "firebase deploy --only firestore:rules,firestore:indexes --project zipper-83816 --non-interactive" in calls(), o[-600:])
ok("31 saved the live Firestore text (hotfix-1) before changing it", ev31 is not None and (ev31 / "live-firestore-before.rules").read_text() == HOTFIX_FS)
rc, o = run(C39, "ROLLBACK\n", (str(rc2),))
ok("39 refuses an evidence folder that is not 31's", rc == 3 and "is not an evidence folder of 31" in o and "firebase deploy" not in calls(), o[-300:])
rc, o = run(C39, "NO\n", (str(ev31),))
ok("39 refuses without ROLLBACK (exit 4)", rc == 4 and "firebase deploy" not in calls(), o[-300:])
rc, o = run(C39, "ROLLBACK\n", (str(ev31),))
ok("39 rollback re-releases the saved hotfix-1 text with the reviewed command: PASS", rc == 0 and "RESULT: PASS" in o
   and "firebase deploy --only firestore:rules --project zipper-83816 --non-interactive" in calls() and st()["rules"]["firestore"] == HOTFIX_FS, o[-600:])
time.sleep(1.1)
rc, o = run(C31, "RELEASE\n", (str(rc2),))
ok("31 again after the rollback: PASS", rc == 0 and st()["rules"]["firestore"] == RC2_FS, o[-400:])
rc, o = run(C41, "RELEASE\n")
ok("41 refuses while the Storage agent lacks the role (40 not run)", rc == 3 and "lacks" in o and "firebase deploy" not in calls(), o[-300:])
rc, o = run(C40, "NO\n")
ok("40 refuses without GRANT (exit 4)", rc == 4 and "add-iam-policy-binding" not in calls(), o[-300:])
rc, o = run(C40, "GRANT\n")
ok("40 grants the Storage agent role with the reviewed command: PASS", rc == 0 and "RESULT: PASS" in o and EXPECTED_MUT["MUT-STORAGE-IAM"][1] in calls(), o[-400:])
ok("40 shows no unmasked address (the policy output is discarded)", not leaks(o), leaks(o))
rc, o = run(C40, "")
ok("40 re-run: nothing to do, no prompt", rc == 0 and "ABOUT TO" not in o and "add-iam" not in calls(), o[-300:])
rc2.rename(rc2.with_name("hold"))
rc, o = run(C41, "RELEASE\n")
ok("41 refuses without the rules emulator results folder", rc == 3 and "firebase deploy" not in calls(), o[-300:])
rc2.with_name("hold").rename(rc2)
os.utime(rc2 / "RESULT.txt", (old - 600, old - 600))
rc, o = run(C41, "RELEASE\n")
ok("41 refuses results older than storage.rules", rc == 3 and "older" in o and "firebase deploy" not in calls(), o[-300:])
os.utime(rc2 / "RESULT.txt", None)
w(rc2 / "SUMMARY.txt", "storage rules sha256: %s\n" % ("f" * 64))
rc, o = run(C41, "RELEASE\n")
ok("41 refuses results that name another storage.rules hash", rc == 3 and "firebase deploy" not in calls(), o[-300:])
w(rc2 / "SUMMARY.txt", "firestore rules sha256: %s\nstorage rules sha256: %s\n" % (sha(RC2_FS), sha(RC2_ST)))
if crm.exists():
    crm.rename(crm.with_name("crm-hold"))
rc, o = run(C41, "RELEASE\n")
ok("41 refuses while the CRM of this release is not recorded live (50)", rc == 3 and "firebase deploy" not in calls(), o[-300:])
if crm.with_name("crm-hold").exists():
    crm.with_name("crm-hold").rename(crm)
rc, o = run(C41, "NO\n")
ok("41 refuses without RELEASE (exit 4)", rc == 4 and "firebase deploy" not in calls(), o[-300:])
rc, o = run(C41, "RELEASE\n")
ev41 = newest("41-storage-rules-")
ok("41 releases RC2 Storage rules from a temp folder with the reviewed command: PASS", rc == 0 and "RESULT: PASS" in o and st()["rules"]["storage"] == RC2_ST
   and "firebase deploy --only storage --project zipper-83816 --non-interactive [cwd=%s/deploy-workdir]" % ev41 in calls(), o[-600:])
ok("41 saved the live Storage text (hotfix-1, live since 1 Nov) before changing it", (ev41 / "live-storage-before.rules").read_text() == HOTFIX_ST)
rc, o = run(C49, "ROLLBACK\n", (str(ev31),))
ok("49 refuses an evidence folder that is not 41's (31's)", rc == 3 and "is not an evidence folder of 41" in o and "firebase deploy" not in calls(), o[-300:])
rc, o = run(C41, "")
ok("41 re-run: already live, no prompt", rc == 0 and "ABOUT TO" not in o and "firebase deploy" not in calls(), o[-300:])
rc, o = run(C49, "NO\n", (str(ev41),))
ok("49 refuses without ROLLBACK (exit 4)", rc == 4 and "firebase deploy" not in calls(), o[-300:])
rc, o = run(C49, "ROLLBACK\nKEEP\n", (str(ev41),))
ok("49 on 41's evidence re-releases the saved hotfix-1 text with the reviewed command and keeps the role on KEEP: PASS", rc == 0 and "RESULT: PASS" in o
   and st()["rules"]["storage"] == HOTFIX_ST and "saved text = hotfix-1 storage.rules" in o and "remove-iam-policy-binding" not in calls()
   and "serviceAccount:" + AGENT in st()["project_roles"]["roles/firebaserules.firestoreServiceAgent"], o[-600:])
rc, o = run(C49, "NO\n", (str(ev41),))
ok("49 IAM revert refuses without REVOKE (exit 4), role unchanged", rc == 4 and "remove-iam" not in calls(), o[-300:])
rc, o = run(C49, "REVOKE\n", (str(ev41),))
ok("49 revokes the role with the reviewed command once the old text is live: PASS", rc == 0 and "RESULT: PASS" in o
   and EXPECTED_MUT["MUT-STORAGE-IAM-REVERT"][1] in calls() and not st()["project_roles"]["roles/firebaserules.firestoreServiceAgent"], o[-500:])
time.sleep(1.1)
run(C40, "GRANT\n")
run(C41, "RELEASE\n")

# ── 21 / 60 / 61 / 29 2b ──
rc, o = run(C21, "DEPLOY2B\n")
ok("21 refuses before APK 22 is published with minSupportedVersionCode 22", rc == 3 and "firebase deploy" not in calls(), o[-300:])
APKD = REPO / "zipper-app" / "app" / "build" / "outputs" / "apk" / "prod"


def apks(code="22", dbg="no", signer="debug", certs=("fleet",), apksigner="ok"):
    """Both prod APKs. `certs`: the test certificates in the signing block (None: no block); `signer`: what publish_apk.py
    makes of apksigner's text (none = it cannot read it); `apksigner`: ok | fail (the stub's exit 0 | 1)."""
    for abi in ("arm64-v8a", "armeabi-v7a"):
        p = APKD / ("app-%s-prod.apk" % abi)
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(signed_zip("FAKEAPK package=com.zipper.app versionCode=%s versionName=1.2.8 debuggable=%s signer=%s abi=%s apksigner=%s\n"
                                 % (code, dbg, signer, abi, apksigner), None if certs is None else [CERTS[c] for c in certs]))


apks(signer="release", certs=("release",))
rc, o = run(C60, "PUBLISH\n")
ok("60 refuses an APK signed with a release key (CN=Zipper Release), before any production read",
   rc == 3 and "venv-python" not in calls() and "CN=Zipper Release, not Android Debug" in o, o[-400:])
apks(certs=("other",))
rc, o = run(C60, "PUBLISH\n")
ok("60 refuses an APK signed with another Mac's debug key (CN=Android Debug, another SHA-256), before any production read",
   rc == 3 and "venv-python" not in calls() and "is not the fleet's %s" % FLEET_SHA in o and "every phone would refuse" in o, o[-400:])
apks(certs=("fleet", "other"))
rc, o = run(C60, "PUBLISH\n")
ok("60 refuses an APK whose signing block holds two certificates", rc == 3 and "venv-python" not in calls()
   and "2 distinct signing certificates (exactly 1 expected)" in o, o[-400:])
apks(certs=None)
rc, o = run(C60, "PUBLISH\n")
ok("60 refuses an APK without an APK Signing Block (although apksigner exits 0)", rc == 3 and "venv-python" not in calls()
   and "NO-SIGNING-BLOCK" in o, o[-400:])
apks(apksigner="fail")
rc, o = run(C60, "PUBLISH\n")
ok("60 refuses an APK, signed with the fleet certificate, on which apksigner verify exits non-zero",
   rc == 3 and "venv-python" not in calls() and "apksigner verify exit 1" in o, o[-400:])
apks(signer="release")
rc, o = run(C60, "PUBLISH\n")
ok("60 refuses when publish_apk.py's dry run reads the fleet-signed APKs as release (a contradiction)",
   rc == 3 and "--apply" not in calls() and "did not agree" in o, o[-400:])
apks(signer="none")
rc, o = run(C60, "NO\n")
ok("60 does not need publish_apk.py to read apksigner's text ('unrecognised certificate' passes its dry run; NO: exit 4)",
   rc == 4 and "--apply" not in calls() and "unrecognised certificate/unrecognised certificate (no contradiction)" in o, o[-500:])
apks(dbg="yes")
rc, o = run(C60, "PUBLISH\n")
ok("60 refuses a debuggable APK", rc == 3 and "--apply" not in calls(), o[-300:])
apks(code="21")
rc, o = run(C60, "PUBLISH\n")
ok("60 refuses an APK whose versionCode is not 22 (APK 21)", rc == 3 and "--apply" not in calls(), o[-300:])
apks()
before_doc = st()["android"]
rc, o = run(C60, "NO\n")
ok("60 refuses without PUBLISH (exit 4) after a clean dry run", rc == 4 and "--apply" not in calls() and "dry run" in o, o[-500:])
rc, o = run(C60, "PUBLISH\n")
ev60 = newest("60-publish-apk-")
d = st()["android"]["debug"]
ok("60 publishes APK 22 with minSupportedVersionCode 22 to the debug channel: PASS", rc == 0 and "RESULT: PASS" in o and d["versionCode"] == 22
   and d["minSupportedVersionCode"] == 22 and d["versionName"] == "1.2.8" and st()["android"]["release"] == before_doc["release"], o[-900:])
ok("60 ran publish_apk.py --apply on the staged prod APKs (app-<abi>-debug.apk copies)", re.search(r"-m scripts\.publish_apk --channel debug --apk-dir \S+/apk --min-supported 22 --notes .* --apply", calls()))
s60 = (ev60 / "SUMMARY.txt").read_text() if ev60 else ""
ok("60 SUMMARY records each APK's certificate (CN, SHA-256 = FLEET_CERT_SHA256); apksigner's raw output and apk_cert.py's line are kept",
   s60.count("SIGNER schemes=v2 certificates=1 sha256=%s CN=Android Debug" % FLEET_SHA) == 2 and s60.count("SIGNER-CHECK ok") == 2
   and all((ev60 / ("apksigner-%s.txt" % a)).is_file() and (ev60 / ("apk-cert-%s.txt" % a)).is_file() for a in ("arm64-v8a", "armeabi-v7a")),
   s60[-1500:])
sv = ev60 / "android-update-before.json"
ok("60 saved the previous androidUpdate document (mode 600) for 61", sv.exists() and json.loads(sv.read_text()) == before_doc and (sv.stat().st_mode & 0o777) == 0o600)
rc, o = run(C60, "PUBLISH\n")
ok("60 re-run refuses: version 22 already published", rc == 3 and "--apply" not in calls(), o[-300:])
EXPORTS.write_text(GOOD_EXPORTS + "EXPORT brandNewFunction asia-south1\n")
rc, o = run(C21, "DEPLOY2B\n")
ok("21 refuses an exported function that is in no list (UNCLASSIFIED), nothing deployed",
   rc == 3 and "UNCLASSIFIED brandNewFunction" in o and "firebase deploy" not in calls(), o[-600:])
EXPORTS.write_text(GOOD_EXPORTS)
rc, o = run(C21, "NO\n")
ok("21 refuses without DEPLOY2B (exit 4)", rc == 4 and "firebase deploy" not in calls() and "CLASSIFY ok" in o, o[-300:])
rc, o = run(C21, "DEPLOY2B\n")
ok("21 deploys wave B only and verifies (6 of the 10 are 2nd gen, compute identity): PASS", rc == 0 and "RESULT: PASS" in o and "changed=10" in o
   and "all 10 functions keep their runtime identity" in o
   and "firebase deploy --only %s --project zipper-83816 --non-interactive" % ",".join("functions:" + n for n in WAVE_2B) in calls(), o[-1200:])
rc, o = run(C61, "WITHDRAW\n", (str(ev60),))
ok("61 refuses while wave B is live (roll 2b back first)", rc == 3 and "wave B (2b)" in o and "restore" not in calls(), o[-300:])
time.sleep(1.1)
rc, o = run(C29, "ROLLBACK\n", ("2b",))
c29 = calls()
ok("29 2b rolls back each function to the tree it ran before — joinPartyRoom + sweepEmptyPartyRooms to LIVE, the 8 call/gift functions to PROD — after ONE ROLLBACK: PASS",
   rc == 0 and "RESULT: PASS" in o and o.count("ABOUT TO:") == 1
   and all(st()["functions"][n]["source"] == PROD_SRC for n in ORIG_2B)
   and all(st()["functions"][n]["source"] == LIVE_SRC for n in ("joinPartyRoom", "sweepEmptyPartyRooms"))
   and "firebase deploy --only functions:joinPartyRoom,functions:sweepEmptyPartyRooms --project zipper-83816 --non-interactive" in c29
   and "firebase deploy --only %s --project zipper-83816 --non-interactive" % ",".join("functions:" + n for n in ORIG_2B) in c29
   and c29.index("functions:joinPartyRoom,") < c29.index("functions:generateAgoraToken,"), o[-1500:])
rc, o = run(C61, "NO\n", (str(ev60),))
ok("61 refuses without WITHDRAW (exit 4)", rc == 4 and "restore" not in calls(), o[-300:])
rc, o = run(C61, "WITHDRAW\n", (str(ev60),))
ok("61 restores exactly the saved debug record with the reviewed command: PASS", rc == 0 and "RESULT: PASS" in o
   and st()["android"] == before_doc and "android_update_doc.py restore %s debug" % sv in calls(), o[-600:])
time.sleep(1.1)
run(C60, "PUBLISH\n")
time.sleep(1.1)
run(C21, "DEPLOY2B\n")

# ── 45 / 46 / 47 Owner MFA enforcement (a separate decision, not part of this release's order; the scripts are kept) ──
OWN = {"ALL_OWNERS_ENROLLED": "yes"}
ENF = "zipper-api-00050-enf"
es = RELC / "production" / "enforce-revision.txt"
rc, o = run(C90, "", ("60",))
ok("90 shows Owner MFA enforcement as an INFO row while 45/46 have not run (not part of this release), never a FAIL",
   re.search(r"INFO\s+run: Owner MFA enforcement \(45/46\)\s+separate decision\s+not enforced", o)
   and not re.search(r"FAIL\s+run: Owner MFA", o), o[-3000:])
rc, o = run(C45, "ENFORCE-NEW\n")
ok("45 refuses without ALL_OWNERS_ENROLLED=yes (exit 3), nothing changed", rc == 3 and "ALL_OWNERS_ENROLLED=yes is not set" in o and "services update" not in calls(), o[-300:])
s = st(); s["rules"]["firestore"] = HOTFIX_FS; put(s)
rc, o = run(C45, "ENFORCE-NEW\n", env=OWN)
ok("45 refuses while the live Firestore rules are not the RC2 text (rolled back)", rc == 3 and "not the RC2 firestore.rules" in o and "services update" not in calls(), o[-300:])
s = st(); s["rules"]["firestore"] = RC2_FS; put(s)
crm.rename(crm.with_name("crm-hold"))
rc, o = run(C45, "ENFORCE-NEW\n", env=OWN)
ok("45 refuses while the MFA CRM is not recorded live", rc == 3 and "crm-live.txt does not exist" in o and "services update" not in calls(), o[-300:])
crm.with_name("crm-hold").rename(crm)
s = st(); s["service"]["traffic"] = [{"revisionName": NEW, "percent": 50}, {"revisionName": SERVING, "percent": 50}]; put(s)
rc, o = run(C45, "ENFORCE-NEW\n", env=OWN)
ok("45 refuses unless the completion revision serves exactly 100%", rc == 3 and "not exactly 100% on the completion revision" in o and "services update" not in calls(), o[-300:])
s = st(); s["service"]["traffic"] = [{"revisionName": NEW, "percent": 100}]; put(s)
rc, o = run(C45, "NO\n", env=OWN)
ok("45 refuses without ENFORCE-NEW (exit 4) after its read-only gate (RC2 rules, CRM, 100%, OWNER_MFA_REQUIRED=false)",
   rc == 4 and "services update" not in calls() and "RC2 Firestore rules live" in o and "CRM of this release live" in o and "OWNER_MFA_REQUIRED=false" in o, o[-800:])
s = st(); s["update_moves_traffic"] = True; put(s)
rc, o = run(C45, "ENFORCE-NEW\n", env=OWN)
ok("45 pins traffic straight back to the completion revision by name if the update moved it (FAIL, nothing recorded)",
   rc == 1 and UT + "--to-revisions %s=100" % NEW in calls() and st()["service"]["traffic"] == [{"revisionName": NEW, "percent": 100}] and not es.exists(), o[-800:])
s = st(); s.pop("update_moves_traffic"); s["service"]["latest"] = NEW; s["service"]["template_env"] = s["revisions"][NEW]["env"]; s["revisions"].pop(ENF); put(s)
rc, o = run(C45, "ENFORCE-NEW\n", env=OWN)
ok("45 creates the enforcement revision at 0% with exactly the reviewed command: PASS", rc == 0 and "RESULT: PASS" in o
   and EXPECTED_MUT["MUT-ENFORCE-NEW"][1] in calls() and st()["service"]["traffic"] == [{"revisionName": NEW, "percent": 100}], o[-1500:])
ok("45 verified OWNER_MFA_REQUIRED=true, the same image, the completion revision's environment names; no value shown",
   "OWNER_MFA_REQUIRED = true" in o and "same image as %s" % NEW in o and "environment names and secret versions identical" in o and not leaks(o), o[-1000:])
ok("45 recorded enforce-revision.txt: name = the enforcement revision (NEW), base = the completion revision (BASE), digest, head",
   es.exists() and "name=%s\n" % ENF in es.read_text() and "base=%s\n" % NEW in es.read_text() and "digest=sha256:%s\n" % ("9" * 64) in es.read_text()
   and "head=%s\n" % HEAD in es.read_text())
rc, o = run(C45, "ENFORCE-NEW\n", env=OWN)
ok("45 refuses a second run while enforce-revision.txt exists", rc == 3 and "already exists" in o and "services update" not in calls(), o[-300:])
rc, o = run(C46, "ENFORCE\n")
ok("46 refuses without ALL_OWNERS_ENROLLED=yes (exit 3)", rc == 3 and "update-traffic" not in calls(), o[-300:])
rc, o = run(C46, "NO\n", env=OWN)
ok("46 refuses without ENFORCE (exit 4), traffic unchanged", rc == 4 and "update-traffic" not in calls()
   and st()["service"]["traffic"] == [{"revisionName": NEW, "percent": 100}], o[-400:])
s = st(); s["revisions"][ENF]["ready"] = False; put(s)
rc, o = run(C46, "ENFORCE\n", env=OWN)
ok("46 pins back to the completion revision automatically when the enforcement revision is not live within 120 s (FAIL)",
   rc == 1 and UT + "--to-revisions %s=100" % ENF in calls() and UT + "--to-revisions %s=100" % NEW in calls()
   and st()["service"]["traffic"] == [{"revisionName": NEW, "percent": 100}], o[-800:])
s = st(); s["revisions"][ENF]["ready"] = True; put(s)
rc, o = run(C46, "ENFORCE\n", env=OWN)
c = calls()
ok("46 moves 100% to the enforcement revision by name; /api/health ok and unauthenticated /api/auth/mfa/status 401: PASS",
   rc == 0 and "RESULT: PASS" in o and UT + "--to-revisions %s=100" % ENF in c and st()["service"]["traffic"] == [{"revisionName": ENF, "percent": 100}]
   and "https://zipper-api-abc-el.a.run.app/api/auth/mfa/status" in c and "https://zipper-api-abc-el.a.run.app/api/health" in c, o[-800:])
rc, o = run(C46, "", env=OWN)
ok("46 re-run: enforcement already live, no prompt", rc == 0 and "ABOUT TO" not in o and "update-traffic" not in calls(), o[-300:])
rc, o = run(C41, "")
ok("after 9b, 41 accepts the enforcement revision as the completion backend (re-run: already live)",
   rc == 0 and "the Owner-MFA enforcement revision %s" % ENF in o and "firebase deploy" not in calls(), o[-400:])
rc, o = run(C47, "NO\n")
ok("47 refuses without ROLLBACK (exit 4)", rc == 4 and "update-traffic" not in calls(), o[-300:])
rc, o = run(C47, "ROLLBACK\n")
ok("47 pins 100% back to the completion revision by name with the reviewed command: PASS (enforcement off)",
   rc == 0 and "RESULT: PASS" in o and UT + "--to-revisions %s=100" % NEW in calls() and st()["service"]["traffic"] == [{"revisionName": NEW, "percent": 100}], o[-500:])
rc, o = run(C47, "")
ok("47 re-run: nothing to do, no prompt", rc == 0 and "ABOUT TO" not in o and "update-traffic" not in calls(), o[-300:])
s = st(); s["service"]["traffic"] = [{"revisionName": SERVING, "percent": 100}]; put(s)
rc, o = run(C47, "ROLLBACK\n")
ok("47 refuses while the enforcement revision has no traffic (whole-backend rollback is 19)", rc == 3 and "has no traffic" in o and "update-traffic" not in calls(), o[-300:])
s = st(); s["service"]["traffic"] = [{"revisionName": NEW, "percent": 100}]; put(s)
good_es = es.read_text()
es.write_text(good_es.replace("base=%s\n" % NEW, "base=%s\n" % RETIRED))
rc47, o47 = run(C47, "ROLLBACK\n")
c47 = calls()
rc46, o46 = run(C46, "ENFORCE\n", env=OWN)
ok("46 and 47 refuse an enforce-revision.txt that names zipper-api-00048-pit (never receives traffic)",
   rc47 == 3 and rc46 == 3 and "must never receive traffic" in o47 and "must never receive traffic" in o46
   and "update-traffic" not in c47 + calls(), (o47 + o46)[-400:])
es.write_text(good_es)
rc, o = run(C46, "ENFORCE\n", env=OWN)
ok("46 again: Owner MFA enforcement live for the post-deploy verification", rc == 0 and st()["service"]["traffic"] == [{"revisionName": ENF, "percent": 100}], o[-300:])

# ── 70 monitoring ──
rc, o = run(C70, "not-an-address\nMONITOR\n")
ok("70 refuses an invalid address", rc == 3 and "create" not in calls(), o[-300:])
rc, o = run(C70, "alerts.owner@example.org\nNO\n")
ok("70 refuses without MONITOR (exit 4), nothing created", rc == 4 and " create " not in calls(), o[-300:])
rc, o = run(C70, "alerts.owner@example.org\nMONITOR\n")
m = st()["monitoring"]
ok("70 creates channel, uptime check and 3 policies: PASS", rc == 0 and "RESULT: PASS" in o and len(m["channels"]) == 1 and len(m["uptime"]) == 1 and len(m["policies"]) == 3, o[-900:])
ok("70 never prints or saves the typed address (masked a***@example.org only)", "alerts.owner@example.org" not in o and "a***@example.org" in o
   and not any("alerts.owner@example.org" in p.read_text(errors="replace") for p in newest("70-monitoring-").rglob("*") if p.is_file()))
ok("70 policies reference the channel; the uptime policy references the check", all(pp["notificationChannels"] == [m["channels"][0]["name"]] for pp in m["policies"])
   and any("zipper-api-health-x1" in json.dumps(pp) for pp in m["policies"]))
rc, o = run(C70, "")
ok("70 re-run is idempotent: nothing to create, no prompt", rc == 0 and "ABOUT TO" not in o and " create " not in calls() and "RESULT: PASS" in o, o[-400:])

# ── 90 post-deploy verification ──
rc, o = run(C90, "", ("1440",))
ok("90 read-only verification: every row PASS on the released state", rc == 0 and "RESULT: PASS" in o and "FAIL 0" in o, o[-3000:])
ok("90 runs no mutating command", not re.search(MUTATING, calls()), re.findall(r".*(?:%s).*" % MUTATING, calls())[:3])
ok("90 prints a table with traffic, functions, rules, hosting, android, monitoring and log rows",
   all(x in o for x in ("run: traffic (status)", "fn: generateAgoraToken", "rules: live storage sha256", "hosting: live zipperlive version",
                        "android: debug", "monitor: uptime zipper-api-health", "logs: replica_drift alert mails", "logs: backend mail accepted")), o[-1500:])

# ── gates: dirty tree, RELEASE.txt mismatch, SCRIPTS.sha256 ──
w(REPO / "backend" / "app" / "scratch.py", "x = 1\n")
rc, o = run(C40, "GRANT\n")
ok("an untracked file makes every script refuse (40: exit 3)", rc == 3 and "untracked" in o and "add-iam" not in calls(), o[-300:])
(REPO / "backend" / "app" / "scratch.py").unlink()
w(REPO / "storage.rules", RC2_ST + "// edited\n")
rc, o = run(C41, "RELEASE\n")
ok("a modified tracked file makes every script refuse (41: exit 3)", rc == 3 and "firebase deploy" not in calls(), o[-300:])
w(REPO / "storage.rules", RC2_ST)
os.utime(REPO / "storage.rules", (old, old))
relp = RELC / "RELEASE.txt"; good = relp.read_text()
relp.write_text(good.replace("HEAD=" + HEAD, "HEAD=" + NOTPROD))
rc, o = run(C19, "ROLLBACK\n")
ok("RELEASE.txt naming another HEAD: refused (19: exit 3)", rc == 3 and "update-traffic" not in calls(), o[-300:])
relp.write_text(re.sub(r"^(TREE backend )[0-9a-f]{64}", lambda mm: mm.group(1) + "0" * 64, good, flags=re.M))
rc, o = run(C61, "WITHDRAW\n", (str(ev60),))
ok("RELEASE.txt with a different tree hash: refused (61: exit 3)", rc == 3 and "restore" not in calls(), o[-300:])
relp.write_text("\n".join(l for l in good.splitlines() if not l.startswith("FILE storage.rules")) + "\n")
rc, o = run(C90, "")
ok("RELEASE.txt missing a recorded line: refused (90: exit 3)", rc == 3, o[-300:])
relp.write_text(good)
with open(RELC / C41, "a") as f:
    f.write("\n# tampered\n")
rc, o = run(C41, "RELEASE\n")
ok("a script that no longer matches SCRIPTS.sha256 refuses before anything (exit 2)", rc == 2 and "REFUSING" in o and calls() == "", o[-200:])
rc, o = run("00-preflight-readonly.command")
ok("...and so does every other script while one file differs (00: exit 2)", rc == 2 and "REFUSING" in o, o[-200:])

# ── unit: tools/android_update_doc.py restore REPLACES the channel map (no deep merge) ──
U = T / "unit"
w(U / "app" / "__init__.py", "")
w(U / "app" / "db" / "__init__.py", "")
w(U / "app" / "db" / "firebase.py", r'''
import json, os
from datetime import datetime
F = os.environ["FAKE_FS"]
def _load(): return json.load(open(F))
def _dump(d): json.dump(d, open(F, "w"), default=lambda o: o.isoformat() if isinstance(o, datetime) else str(o))
def _deep(a, b):
    for k, v in b.items():
        if isinstance(v, dict) and isinstance(a.get(k), dict): _deep(a[k], v)
        else: a[k] = v
class Snap:
    def __init__(s, d): s._d = d; s.exists = d is not None
    def to_dict(s): return s._d
class Ref:
    def get(s): return Snap(_load().get("doc"))
    def set(s, data, merge=False):
        d = _load(); cur = d.get("doc") or {}
        if merge: _deep(cur, data)
        else: cur = data
        d["doc"] = cur; _dump(d)
    def update(s, data):
        d = _load(); cur = d["doc"]
        for k, v in data.items(): cur[k] = v
        d["doc"] = cur; _dump(d)
class Coll:
    def document(s, name): assert name == "androidUpdate"; return Ref()
class Client:
    def collection(s, name): assert name == "appConfig"; return Coll()
def init(): pass
def firestore_client(): return Client()
''')
saved = {"debug": {"versionCode": 19, "versionName": "1.2.5", "publishedAt": "2026-10-20T08:00:00+00:00",
                   "abis": {"arm64-v8a": {"url": "u19", "sha256": "0" * 64}}}, "release": {"versionCode": 3}}
live = {"debug": {"versionCode": 20, "versionName": "1.2.6", "minSupportedVersionCode": 20, "publishedAt": "2026-11-01T03:00:00+00:00",
                  "abis": {"arm64-v8a": {"url": "u20", "sha256": "1" * 64, "patches": {"19": {"url": "p"}}}}}, "release": {"versionCode": 3}}
w(U / "fs.json", json.dumps({"doc": live}))
w(U / "saved.json", json.dumps(saved))
p = subprocess.run([sys.executable, str(RELC / "tools" / "android_update_doc.py"), "restore", str(U / "saved.json"), "debug"],
                   cwd=str(U), env={"PATH": "/usr/bin:/bin", "PYTHONPATH": str(U), "FAKE_FS": str(U / "fs.json")}, capture_output=True, text=True)
after = json.loads((U / "fs.json").read_text())["doc"]
ok("android_update_doc.py restore replaces the debug map exactly (no leftover minSupportedVersionCode/patches; release untouched)",
   p.returncode == 0 and after["debug"] == saved["debug"] and after["release"] == live["release"], p.stdout + p.stderr + json.dumps(after)[:300])

# ── unit: rel_helpers.py fn-classify — a name in two lists, and the exact split ──
w(U / "exports.txt", "EXPORT a asia-south1\nEXPORT b asia-south1\nEXPORT c us-central1\n")
p = subprocess.run([sys.executable, "-I", str(RELC / "rel_helpers.py"), "fn-classify", str(U / "exports.txt"), "a b", "b", "c", "asia-south1", "us-central1", "c"],
                   capture_output=True, text=True)
ok("fn-classify refuses a name listed in two waves (DUPLICATE)", "DUPLICATE b in WAVE_2A,WAVE_2B" in p.stdout and "CLASSIFY FAIL" in p.stdout, p.stdout + p.stderr)
p = subprocess.run([sys.executable, "-I", str(RELC / "rel_helpers.py"), "fn-classify", str(U / "exports.txt"), "a b", "", "c", "asia-south1", "us-central1", "c"],
                   capture_output=True, text=True)
ok("fn-classify accepts an exact split in the right regions", p.stdout.strip().endswith("CLASSIFY ok"), p.stdout + p.stderr)

# ── unit: rel_helpers.py fn-bases-check — every deployed name has exactly one rollback base ──
FBC = [sys.executable, "-I", str(RELC / "rel_helpers.py"), "fn-bases-check"]
p = subprocess.run(FBC + ["a n1", "b c", "z", "a b", "c", "n1"], capture_output=True, text=True)
ok("fn-bases-check accepts live/prod/new bases that cover exactly the deployed names", p.stdout.strip().endswith("BASES ok"), p.stdout + p.stderr)
p = subprocess.run(FBC + ["a n1", "b c", "z", "a", "c", "n1"], capture_output=True, text=True)
ok("fn-bases-check refuses a deployed name without a base (NO-BASE)", "NO-BASE b" in p.stdout and "BASES FAIL" in p.stdout, p.stdout + p.stderr)
p = subprocess.run(FBC + ["a n1", "b c", "z", "a b z", "c", "n1"], capture_output=True, text=True)
ok("fn-bases-check refuses a base for a name no wave deploys (a NOT_REDEPLOYED one)", "BASE-NOT-DEPLOYED z" in p.stdout and "BASES FAIL" in p.stdout, p.stdout + p.stderr)
p = subprocess.run(FBC + ["a", "b c n1", "z", "a b", "c", "n1"], capture_output=True, text=True)
ok("fn-bases-check refuses a NEW function outside wave A", "NEW-NOT-IN-WAVE-A n1" in p.stdout and "BASES FAIL" in p.stdout, p.stdout + p.stderr)
p = subprocess.run(FBC + ["a n1", "b c", "z", "a b", "c b", "n1"], capture_output=True, text=True)
ok("fn-bases-check refuses a name with two bases", "BASE-DUPLICATE b in FN_BASE_LIVE,FN_BASE_PROD" in p.stdout and "BASES FAIL" in p.stdout, p.stdout + p.stderr)

# ── unit: the repository's real deploy-crm.command (the harness runs a fake one) reads .firebaserc as JSON ──
REAL_CRM = REL.parent.parent / "deploy-crm.command"
if REAL_CRM.exists():
    rc_text = REAL_CRM.read_text(encoding="utf-8")
    ok("deploy-crm.command never require()s .firebaserc (2 Nov: Node parsed it as JavaScript, SyntaxError, no deploy)",
       "require('./.firebaserc')" not in rc_text and rc_text.count("JSON.parse(require('fs').readFileSync('./.firebaserc','utf8'))") == 2)

# ── unit: tools/apk_cert.py — the certificate(s) of the APK Signing Block ──
for name, certs in (("one", ["fleet"]), ("two", ["fleet", "release"]), ("none", None)):
    (U / ("%s.apk" % name)).write_bytes(signed_zip("FAKEAPK\n", None if certs is None else [CERTS[c] for c in certs]))
(U / "notzip.apk").write_bytes(b"not a ZIP file " * 8)
AC = [sys.executable, "-I", str(RELC / "tools" / "apk_cert.py")]
p = subprocess.run(AC + [str(U / "one.apk")], capture_output=True, text=True)
ok("apk_cert.py: one v2 signer -> 'APK one.apk SCHEMES v2 CERTS 1 SHA256 <sha256 of its DER> CN Android Debug', exit 0",
   p.returncode == 0 and p.stdout == "APK one.apk SCHEMES v2 CERTS 1 SHA256 %s CN Android Debug\n" % FLEET_SHA, p.stdout + p.stderr)
p = subprocess.run(AC + [str(U / "two.apk")], capture_output=True, text=True)
ok("apk_cert.py: two certificates -> CERTS 2 with both SHA-256s and both CNs", p.returncode == 0
   and "CERTS 2 SHA256 %s,%s CN Android Debug | Zipper Release\n" % (FLEET_SHA, hashlib.sha256(CERTS["release"]).hexdigest()) in p.stdout,
   p.stdout + p.stderr)
p = subprocess.run(AC + [str(U / "one.apk"), str(U / "none.apk"), str(U / "notzip.apk")], capture_output=True, text=True)
ok("apk_cert.py: no signing block -> NO-SIGNING-BLOCK, not a ZIP -> UNREADABLE, exit 2 (one line per APK)",
   p.returncode == 2 and len(p.stdout.splitlines()) == 3 and "APK one.apk SCHEMES v2 CERTS 1 " in p.stdout
   and "APK none.apk NO-SIGNING-BLOCK" in p.stdout and "APK notzip.apk UNREADABLE" in p.stdout, p.stdout + p.stderr)

if LOG.exists():
    ALL_CALLS.append(LOG.read_text())
ok("no command of the whole run used --to-latest (the stub also refuses it)", not any("--to-latest" in c for c in ALL_CALLS))
ok("no command of the whole run read a secret value", not any(re.search(r"versions\s+access", c) for c in ALL_CALLS))
if os.environ.get("KEEP_HARNESS_TMP"):
    print("kept: %s" % T)
else:
    shutil.rmtree(T, ignore_errors=True)
bad = [r for r in results if not r[0]]
print("\nbash: %s" % subprocess.run(["/bin/bash", "--version"], capture_output=True, text=True).stdout.splitlines()[0])
print("%d/%d PASS" % (len(results) - len(bad), len(results)))
sys.exit(1 if bad else 0)
