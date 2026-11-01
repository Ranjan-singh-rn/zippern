"""Local test of the ZIPPER completion-release scripts (release/completion-20261101) — no network, no credentials.

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
     IAM role, unpublished APK, wave 2b live, and a Functions rollback base that is not refs/heads/prod-live-20261030
     (f1af30a refused; the short name, shadowed by a same-named tag, never resolved).
     Plus a unit test of tools/android_update_doc.py restore against an in-memory Firestore fake.

Usage: python3 -I tools/test_release_scripts.py <release/completion-20261101 folder>
"""
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
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
EXPECT_SHA_LIST = sorted(PROD_FILES + LIBS + ["rel_helpers.py", "tools/android_update_doc.py", "tools/live_rules.py"])

C10, C11, C12, C19 = ("10-grant-backend-sendgrid-secret.command", "11-deploy-backend-no-traffic.command",
                      "12-canary-backend.command", "19-rollback-backend.command")
C20, C21, C29 = "20-deploy-functions-wave2a.command", "21-deploy-functions-wave2b.command", "29-rollback-functions.command"
C30, C31, C39, C40 = ("30-deploy-rules-hotfix1.command", "31-deploy-rules-rc2.command", "39-rollback-rules.command",
                      "40-storage-iam-grant.command")
C32 = "32-deploy-storage-hotfix1.command"
REAL_PROD, REAL_NOTPROD = "4e21b7f14f7cafb01b8aacaf35368695a17d13e0", "f1af30a1d64fb8f20403fd6e7da5633cfab1234c"
C41, C49, C50 = "41-deploy-storage-rules.command", "49-rollback-storage.command", "50-deploy-crm.command"
C60, C61, C70, C90 = ("60-publish-apk.command", "61-withdraw-apk.command", "70-monitoring-setup.command",
                      "90-postdeploy-verify-readonly.command")
UT = "gcloud run services update-traffic zipper-api --project zipper-83816 --region asia-south1 "
FB_FN = 'firebase deploy --only "$ONLY" --project zipper-83816 --non-interactive'
SA_STORAGE = "serviceAccount:service-239458555881@gcp-sa-firebasestorage.iam.gserviceaccount.com"
EXPECTED_MUT = {
    "MUT-GRANT-BACKEND": (C10, "gcloud secrets add-iam-policy-binding ZIPPER_SENDGRID_API_KEY --project zipper-83816 --member=serviceAccount:239458555881-compute@developer.gserviceaccount.com --role=roles/secretmanager.secretAccessor --condition=None"),
    "MUT-DEPLOY-BACKEND": (C11, 'gcloud run deploy zipper-api --project zipper-83816 --region asia-south1 --source . --no-traffic --tag "$TAG" --update-secrets SENDGRID_API_KEY=ZIPPER_SENDGRID_API_KEY:1 --update-env-vars EMAIL_PROVIDER=sendgrid,SENDGRID_FROM_EMAIL=no-reply@zipperlive.org,"SENDGRID_FROM_NAME=ZIPPER Live"'),
    "MUT-PIN-BACK": (C11, UT + '--to-revisions "$SERVING=100"'),
    "MUT-EMAIL": (C11, "-X POST -H 'Content-Type: application/json' -d '{}' \"$TAGURL/api/auth/observer/request-code\""),
    "MUT-UNTAG": (C11, UT + '--remove-tags "$TAG"'),
    "MUT-CANARY-BACK": (C12, UT + '--to-revisions "$BASE=100"'),
    "MUT-CANARY-10": (C12, UT + '--to-revisions "$NEW=10,$BASE=90"'),
    "MUT-CANARY-50": (C12, UT + '--to-revisions "$NEW=50,$BASE=50"'),
    "MUT-CANARY-100": (C12, UT + '--to-revisions "$NEW=100"'),
    "MUT-ROLLBACK-BACKEND": (C19, UT + '--to-revisions "$BASE=100"'),
    "MUT-DEPLOY-2A": (C20, FB_FN), "MUT-DEPLOY-2B": (C21, FB_FN), "MUT-ROLLBACK-FN": (C29, FB_FN),
    "MUT-RULES-HOTFIX1": (C30, "firebase deploy --only firestore:rules --project zipper-83816 --non-interactive"),
    "MUT-STORAGE-HOTFIX1": (C32, "firebase deploy --only storage --project zipper-83816 --non-interactive"),
    "MUT-RULES-RC2": (C31, "firebase deploy --only firestore:rules,firestore:indexes --project zipper-83816 --non-interactive"),
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
WORDS = {C10: "GRANT", C11: "DEPLOY", C12: "CANARY10", C19: "ROLLBACK", C20: "DEPLOY2A", C21: "DEPLOY2B", C29: "ROLLBACK",
         C30: "RELEASE", C31: "RELEASE", C32: "RELEASE", C39: "ROLLBACK", C40: "GRANT", C41: "RELEASE", C49: "ROLLBACK", C50: "CRM",
         C60: "PUBLISH", C61: "WITHDRAW", C70: "MONITOR"}
RO_VERBS = ["gcloud --version", "gcloud config get-value", "gcloud auth list", "gcloud run services describe",
            "gcloud run revisions describe", "gcloud functions describe", "gcloud functions list",
            "gcloud secrets describe", "gcloud secrets versions list", "gcloud secrets get-iam-policy",
            "gcloud projects get-iam-policy", "gcloud logging read", "gcloud meta list-files-for-upload",
            "gcloud artifacts repositories describe", "gcloud services list", "gcloud builds list", "gcloud builds log",
            "gcloud storage buckets describe", "gcloud alpha monitoring policies list",
            "gcloud beta monitoring channels list", "gcloud monitoring uptime list-configs",
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
code32 = [ln for _, ln in logical_lines(REL / C32) if ln.strip() and not ln.strip().startswith("#")]
mut32 = [ln for ln in code32 if re.search(r"#MUT-[A-Z0-9-]+\s*$", ln)]
ok("32 holds exactly one mutation line (#MUT-STORAGE-HOTFIX1) and no IAM command",
   len(mut32) == 1 and mut32[0].rstrip().endswith("#MUT-STORAGE-HOTFIX1") and not any("iam-policy" in ln for ln in code32), mut32)
# Rollback base rule: the production Functions tree by its FULL ref, pinned to 4e21b7f; f1af30a named as not production.
rcs = (REL / "rel_common.sh").read_text(encoding="utf-8")
ok("rel_common.sh: rollback base refs/heads/prod-live-20261030 = 4e21b7f…, f1af30a… named NOT production",
   'PROD_FN_REF="refs/heads/prod-live-20261030"' in rcs and 'PROD_FN_COMMIT="%s"' % REAL_PROD in rcs
   and 'NOT_PROD_FN_COMMIT="%s"' % REAL_NOTPROD in rcs)
short = ["%s:%d" % (f.name, no) for f in code_files for no, ln in logical_lines(f) if not ln.strip().startswith("#")
         and re.search(r"(?<!refs/heads/)prod-live-20261030(?!-tag)", ln.split("  #")[0])]
ok("no script names prod-live-20261030 except as the full ref refs/heads/prod-live-20261030", not short, short)
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
SERVING, TEMPLATE, RETIRED, NEW = "zipper-api-00046-siw", "zipper-api-00047-9cj", "zipper-api-00048-pit", "zipper-api-00049-new"
BACKEND_SA = "239458555881-compute@developer.gserviceaccount.com"
FN_SA = "zipper-83816@appspot.gserviceaccount.com"
AGENT = "service-239458555881@gcp-sa-firebasestorage.iam.gserviceaccount.com"
OLD_CRM = "ba740f4158292308"
SECRET_VALUES = ["fake-agora-cert-value", "SG.fake-old-key", "ops-mailbox@example.com"]
PEOPLE = ["someone@example.com", "operator@example.com", "alerts.owner@example.org"]
WAVE_2A = ["releaseBeansForWeek", "weeklyPayoutReportGenerator", "syncPublicProfile", "backfillPublicProfiles", "startMobileSession"]
WAVE_2B = ["generateAgoraToken", "settleGift", "startCall", "acceptCall", "tickCall", "endCall", "declineCall", "sweepStaleCalls"]
EMAIL_FNS = ["requestEmailBindCode", "requestLoginEmailCode", "onAgencyApproved", "onAgencyRegistered", "onSellerRegistered",
             "onSellerApproved", "onAgencyResendEmail", "onSellerResendEmail"]
FN_ENV = {"AGORA_APP_CERTIFICATE": "fake-agora-cert-value", "SG_MAIL_KEY": "SG.fake-old-key", "API_BASE": "https://api.example"}
DEPLOYED_FS = "rules_version = '2';\n// DEPLOYED 20 Oct firestore\nservice cloud.firestore { match /databases/{d}/documents { } }\n"
DEPLOYED_ST = "rules_version = '2';\n// DEPLOYED 20 Oct storage\nservice firebase.storage { match /b/{b}/o { } }\n"
HOTFIX_FS = DEPLOYED_FS.replace("DEPLOYED 20 Oct firestore", "HOTFIX-1 firestore")
HOTFIX_ST = DEPLOYED_ST.replace("DEPLOYED 20 Oct storage", "HOTFIX-1 storage A-1 15 MB")
RC2_FS = DEPLOYED_FS.replace("DEPLOYED 20 Oct firestore", "RC2 firestore owner MFA")
RC2_ST = DEPLOYED_ST.replace("DEPLOYED 20 Oct storage", "RC2 storage ownerMfaSessions A-1")
# First line of functions/src/index.ts per commit (the firebase stub records it as the deployed "source").
PROD_SRC = "// functions PROD (prod-live-20261030: 20 Oct baseline + SendGrid wave A)"
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
    return {"metadata": {"name": name, "creationTimestamp": "2026-11-01T00:00:00Z"},
            "status": {"imageDigest": IMG + r["digest"], "conditions": [{"type": t, "status": "True"} for t in ("Ready", "Active", "ResourcesAvailable", "ContainerHealthy")]},
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
    new = "zipper-api-00049-new"; tag = flag("--tag")
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
    if not f: fail("NOT_FOUND: function " + a[2])
    out(f)
if a[:2] == ["functions", "list"]: out(list(state["functions"].values()))
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
        for n in [p.split(":", 1)[1] for p in parts]:
            f = state["functions"].get(n) or {"name": "projects/zipper-83816/locations/asia-south1/functions/" + n, "status": "ACTIVE",
                                             "entryPoint": n, "runtime": "nodejs22", "serviceAccountEmail": "zipper-83816@appspot.gserviceaccount.com",
                                             "versionId": "0", "secretEnvironmentVariables": []}
            f["versionId"] = str(int(f["versionId"]) + 1); state["clock"] += 1
            f["updateTime"] = "2026-11-01T02:%02d:%02dZ" % (state["clock"] // 60 % 60, state["clock"] % 60)
            f["environmentVariables"] = dict(dotenv, FIREBASE_CONFIG="{}", GCLOUD_PROJECT="zipper-83816")
            f["source"] = src
            state["functions"][n] = f
        save(); print("+  Deploy complete!"); sys.exit(0)
    if parts in (["firestore:rules"], ["firestore:rules", "firestore:indexes"]):
        assert set(cfg) == {"firestore"}, "deploy folder carries more than firestore"
        state["rules"]["firestore"] = open(cfg["firestore"]["rules"]).read()
        if "firestore:indexes" in parts: json.load(open(cfg["firestore"]["indexes"]))
        save(); print("+  firestore: released rules firestore.rules to cloud.firestore\n+  Deploy complete!"); sys.exit(0)
    if parts == ["storage"]:
        assert cfg == {"storage": {"rules": "storage.rules"}}, "storage deploy config is not the single default-bucket form"
        state["rules"]["storage"] = open("storage.rules").read()
        save(); print("+  storage: released rules storage.rules to firebase.storage\n+  Deploy complete!"); sys.exit(0)
    print("stub: unexpected deploy " + only); sys.exit(9)
print("stub: unexpected firebase call " + " ".join(a)); sys.exit(9)
'''

VENV_STUB = r'''#!/usr/bin/env python3
import json, os, sys, hashlib
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
        kv = dict(x.split("=", 1) for x in open(p).read().split() if "=" in x)
        vers.add((int(kv["versionCode"]), kv["versionName"]))
        print("  %s\n    version    %s (%s)\n    signed as  %s" % (abi, kv["versionName"], kv["versionCode"], kv["signer"]))
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
  --test) printf 'TAP version 13\\nok 1 - a\\n# tests 3\\n# suites 0\\n# pass 3\\n# fail 0\\n';;
esac
exit 0
'''
SLEEP_STUB = '#!/bin/bash\nexit 0\n'
REAL_DATE = "/bin/date" if os.path.exists("/bin/date") else "/usr/bin/date"
DATE_STUB = '#!/bin/bash\n# day-of-week is fixed (Wednesday) so 20 never meets its Sunday window in a test\nif [ "$*" = "-u +%%u" ]; then echo 3; exit 0; fi\nexec %s "$@"\n' % REAL_DATE
SHASUM_STUB = '#!/bin/bash\n# shasum -a 256 [-c file] [files]\nshift 2\nexec sha256sum "$@"\n'
AAPT_STUB = r'''#!/usr/bin/env python3
import sys
kv = dict(x.split("=", 1) for x in open(sys.argv[3]).read().split() if "=" in x)
print("package: name='%s' versionCode='%s' versionName='%s' platformBuildVersionName='15'" % (kv["package"], kv["versionCode"], kv["versionName"]))
if kv.get("debuggable") == "yes": print("application-debuggable")
'''
APKSIGNER_STUB = r'''#!/usr/bin/env python3
import sys
kv = dict(x.split("=", 1) for x in open(sys.argv[-1]).read().split() if "=" in x)
print("Signer #1 certificate DN: " + ("CN=Android Debug, O=Android, C=US" if kv.get("signer") == "debug" else "CN=Zipper Release, O=Zipper"))
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
TEMPLATE_ENV = SERVING_ENV + [{"name": "OWNER_MFA_REQUIRED", "value": "false"},
                              {"name": "OWNER_MFA_ENCRYPTION_KEY", "valueFrom": {"secretKeyRef": {"name": "OWNER_MFA_ENCRYPTION_KEY", "key": "1"}}}]


def fresh_state():
    fns = {}
    names = WAVE_2A + WAVE_2B + EMAIL_FNS + ["fnOther%03d" % i for i in range(90)]
    for n in names:
        sec = []
        if n == "weeklyPayoutReportGenerator":
            sec = [{"key": "ZIPPER_ACCRUAL_KEY", "secret": "ZIPPER_ACCRUAL_KEY", "version": "1"},
                   {"key": "ZIPPER_SENDGRID_API_KEY", "secret": "ZIPPER_SENDGRID_API_KEY", "version": "1"}]
        elif n in EMAIL_FNS:
            sec = [{"key": "ZIPPER_SENDGRID_API_KEY", "secret": "ZIPPER_SENDGRID_API_KEY", "version": "1"}]
        fns[n] = {"name": "projects/zipper-83816/locations/asia-south1/functions/" + n, "status": "ACTIVE", "entryPoint": n,
                  "runtime": "nodejs22", "serviceAccountEmail": FN_SA, "updateTime": "2026-10-20T08:31:41Z", "versionId": "6",
                  "environmentVariables": dict(FN_ENV, FIREBASE_CONFIG="{}", GCLOUD_PROJECT=P), "secretEnvironmentVariables": sec,
                  "source": PROD_SRC}
    return {
        "service": {"traffic": [{"revisionName": SERVING, "percent": 100}], "tags": {}, "latest": TEMPLATE,
                    "template_env": TEMPLATE_ENV, "generation": 47},
        "revisions": {SERVING: {"digest": "sha256:" + "1" * 64, "env": SERVING_ENV},
                      TEMPLATE: {"digest": "sha256:" + "2" * 64, "env": TEMPLATE_ENV},
                      RETIRED: {"digest": "sha256:" + "3" * 64, "env": SERVING_ENV}},
        "functions": fns, "clock": 0,
        "secrets": {"ZIPPER_SENDGRID_API_KEY": {"versions": ["ENABLED"], "members": ["serviceAccount:" + FN_SA]},
                    "SENDGRID_API_KEY": {"versions": ["ENABLED"], "members": ["serviceAccount:" + BACKEND_SA]},
                    "OWNER_MFA_ENCRYPTION_KEY": {"versions": ["ENABLED"], "members": ["serviceAccount:" + BACKEND_SA]}},
        "project_roles": {"roles/editor": ["serviceAccount:" + FN_SA, "serviceAccount:" + BACKEND_SA],
                          "roles/firebasestorage.serviceAgent": ["serviceAccount:" + AGENT]},
        "rules": {"firestore": DEPLOYED_FS, "storage": DEPLOYED_ST},
        "hosting_version": OLD_CRM,
        "android": {"debug": {"versionCode": 19, "versionName": "1.2.5", "notes": "1.2.5", "mandatory": False,
                              "publishedAt": "2026-10-20T08:00:00+00:00", "abis": {"arm64-v8a": {"url": "u19", "sha256": "0" * 64, "sizeBytes": 1}},
                              "url": "u19", "sha256": "0" * 64, "sizeBytes": 1},
                    "release": {"versionCode": 3, "versionName": "1.0.3"}},
        "monitoring": {"policies": [], "channels": [], "uptime": []},
        "backend_state": {},
        "log_counts": {"accepted (": 1},
    }


T = Path(tempfile.mkdtemp(prefix="zrel-")).resolve()   # macOS: /var → /private/var, as the scripts see it
REPO, HOME, BIN = T / "repo", T / "home", T / "bin"
RELC = REPO / "release" / REL.name
STATE, LOG = T / "state.json", T / "calls.log"


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


# stubs
for name, body in [("gcloud", GCLOUD_STUB), ("firebase", FIREBASE_STUB), ("npm", NPM_STUB), ("node", NODE_STUB),
                   ("curl", CURL_STUB), ("sleep", SLEEP_STUB), ("date", DATE_STUB)] + \
                  ([] if shutil.which("shasum") else [("shasum", SHASUM_STUB)]):
    w(BIN / name, body, 0o755)
BT = HOME / "Library" / "Android" / "sdk" / "build-tools" / "35.0.0"
w(BT / "aapt2", AAPT_STUB, 0o755)
w(BT / "apksigner", APKSIGNER_STUB, 0o755)

# the repository: NOTPROD (the f1af30a stand-in: an ancestor of HEAD whose functions/ is NOT production), branch
# prod-live-20261030 = PROD (the production Functions tree; not an ancestor of HEAD), a TAG of the same base name on
# NOTPROD (the short name resolves to the tag; only refs/heads/… finds PROD), then the release commit (functions v2 +
# this folder, whose rel_common.sh names PROD / NOTPROD in place of 4e21b7f… / f1af30a…)
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
w(REPO / "firestore.indexes.json", '{"indexes": [], "fieldOverrides": []}\n')
w(REPO / "firebase.json", json.dumps({"firestore": {"rules": "firestore.rules"}, "storage": {"rules": "storage.rules"},
                                      "functions": [{"source": "functions", "codebase": "default"}],
                                      "hosting": [{"target": "production", "public": "zipper-crm/out"}]}, indent=1) + "\n")
w(REPO / ".firebaserc", '{"projects":{"default":"zipper-83816"}}\n')
w(REPO / "deploy-crm.command", DEPLOY_CRM, 0o755)
w(REPO / "zipper-app" / "app" / "build.gradle.kts", 'android {\n    defaultConfig {\n        versionCode = 20\n        versionName = "1.2.6"\n    }\n    buildTypes { create("prod") { } }\n}\n')
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
shutil.copytree(REL, RELC, ignore=shutil.ignore_patterns("production", "RELEASE.txt", "SCRIPTS.sha256", "scripts-mac-*", "__pycache__"))
rcs_copy = (RELC / "rel_common.sh").read_text(encoding="utf-8")
ok("the copy's rel_common.sh names 4e21b7f… and f1af30a… (pointed at PROD / NOTPROD of the throwaway repository)",
   REAL_PROD in rcs_copy and REAL_NOTPROD in rcs_copy)
(RELC / "rel_common.sh").write_text(rcs_copy.replace(REAL_PROD, PROD).replace(REAL_NOTPROD, NOTPROD), encoding="utf-8")
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


def run(script, stdin="", args=()):
    if LOG.exists():
        ALL_CALLS.append(LOG.read_text())
        LOG.unlink()
    p = subprocess.run(["/bin/bash", str(RELC / script), *args], input=stdin, text=True, env=ENV, capture_output=True, timeout=600)
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
ok("make-release-txt.sh (no argument) records BASE_COMMIT = refs/heads/prod-live-20261030 (not the same-named tag), BASE_REF, HEAD",
   rc == 0 and "BASE_COMMIT=%s\n" % PROD in rel and "BASE_REF=refs/heads/prod-live-20261030\n" in rel and "HEAD=%s\n" % HEAD in rel, o[-600:])
ok("make-release-txt.sh writes RELEASE.txt: HEAD, BASE_COMMIT, 4 TREE + 7 FILE lines, verified",
   rc == 0 and "HEAD=%s\n" % HEAD in rel and "BASE_COMMIT=%s\n" % PROD in rel and len(re.findall(r"^TREE ", rel, re.M)) == 4
   and len(re.findall(r"^FILE ", rel, re.M)) == 7 and "TREE functions/src " in rel and "TREE zipper-crm " in rel
   and "FILE zipper-app/app/build.gradle.kts " in rel, o[-600:])
ok("RELEASE.txt and production/ are git-ignored (the tree stays clean)", git("status", "--porcelain") == "", git("status", "--porcelain"))

# ── 00 preflight ──
rc, o = run("00-preflight-readonly.command")
ok("00 read-only preflight passes on the expected production state", rc == 0 and "RESULT: PASS" in o, o[-1500:])
MUTATING = r"add-iam|remove-iam|firebase deploy|run deploy|update-traffic| create |android_update_doc.py restore|--apply|POST"
ok("00 runs no mutating command", not re.search(MUTATING, calls()), re.findall(r".*(?:%s).*" % MUTATING, calls())[:3])
ok("00 shows no environment value, secret or unmasked address", not leaks(o), leaks(o))

# ── 10 grant ──
rc, o = run(C10, "NO\n")
ok("10 refuses without GRANT (exit 4), nothing changed", rc == 4 and "add-iam-policy-binding" not in calls(), o[-300:])
rc, o = run(C10, "GRANT\n")
ok("10 grants the backend identity on the SendGrid secret: PASS", rc == 0 and "RESULT: PASS" in o, o[-600:])
ok("10 ran exactly the reviewed command", "gcloud secrets add-iam-policy-binding ZIPPER_SENDGRID_API_KEY --project zipper-83816 --member=serviceAccount:239458555881-compute@developer.gserviceaccount.com --role=roles/secretmanager.secretAccessor --condition=None" in calls())
rc, o = run(C10, "")
ok("10 re-run: nothing to do, no prompt, PASS", rc == 0 and "ABOUT TO" not in o and "RESULT: PASS" in o, o[-300:])

# ── 11 backend no-traffic ──
rc, o = run(C11, "NO\n")
ok("11 refuses without DEPLOY (exit 4), no deploy", rc == 4 and "run deploy" not in calls(), o[-400:])
rc, o = run(C11, "DEPLOY\nEMAIL\nUNTAG\n")
c = calls()
ok("11 deploys at 0%, smoke-tests, sends one e-mail, untags: PASS", rc == 0 and "RESULT: PASS" in o, o[-2500:])
ok("11 ran the reviewed deploy (no traffic, tag, SendGrid secret + 3 settings)",
   "gcloud run deploy zipper-api --project zipper-83816 --region asia-south1 --source . --no-traffic --tag completion-%s --update-secrets SENDGRID_API_KEY=ZIPPER_SENDGRID_API_KEY:1 --update-env-vars EMAIL_PROVIDER=sendgrid,SENDGRID_FROM_EMAIL=no-reply@zipperlive.org,SENDGRID_FROM_NAME=ZIPPER Live" % HEAD[:7] in c)
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

# ── 30 / 39 Firestore hotfix-1 ──
rc, o = run(C30, "RELEASE\n")
ok("30 refuses without an emulator results folder", rc == 3 and "firebase deploy" not in calls(), o[-300:])
res = HF / "results-20261101T010000Z"


def hotfix_summary(fs_sha, st_sha):
    """SUMMARY.txt as run-hotfix1-rules-tests.command writes it: the header names each text, then its sha256."""
    return ("HOTFIX-1 rules tests  20261101T010000Z\nrepo:            %s\nfirestore rules: %s\n  sha256:        %s\n"
            "storage rules:   %s\n  sha256:        %s\n\n=== hotfix1:storage (storage,firestore) [must] ===\n"
            "hotfix1:storage exit=0 -> PASS\n\nHOTFIX1-RUN: PASS (every must-pass suite passed)\n"
            % (REPO, HF / "firestore.rules", fs_sha, HF / "storage.rules", st_sha))


w(res / "RESULT.txt", "PASS\n")
w(res / "SUMMARY.txt", hotfix_summary(sha(HOTFIX_FS), sha(HOTFIX_ST)))
os.utime(res / "RESULT.txt", (old - 600, old - 600))
rc, o = run(C30, "RELEASE\n")
ok("30 refuses results older than the rules text", rc == 3 and "older" in o and "firebase deploy" not in calls(), o[-300:])
os.utime(res / "RESULT.txt", None)
rc, o = run(C30, "NO\n")
ok("30 refuses without RELEASE (exit 4); the untracked results folder is tolerated", rc == 4 and "firebase deploy" not in calls() and "tolerated" in o, o[-400:])
rc, o = run(C30, "RELEASE\n")
ok("30 releases the hotfix-1 Firestore rules: PASS", rc == 0 and "RESULT: PASS" in o and st()["rules"]["firestore"] == HOTFIX_FS, o[-600:])
ev30 = newest("30-rules-hotfix1-")
rc, o = run(C30, "")
ok("30 re-run: already live, no prompt, no deploy", rc == 0 and "ABOUT TO" not in o and "firebase deploy" not in calls(), o[-300:])
rc, o = run(C39, "NO\n", (str(ev30),))
ok("39 refuses without ROLLBACK (exit 4)", rc == 4 and "firebase deploy" not in calls(), o[-300:])
rc, o = run(C39, "ROLLBACK\n", (str(ev30),))
ok("39 rollback re-releases the saved text with the reviewed command: PASS", rc == 0 and "RESULT: PASS" in o
   and "firebase deploy --only firestore:rules --project zipper-83816 --non-interactive" in calls() and st()["rules"]["firestore"] == DEPLOYED_FS, o[-600:])
run(C30, "RELEASE\n")

# ── 32 Storage hotfix-1 (step 2, right after 30), 49 on 32's evidence ──
SUMS, REL_SUMS = HF / "SHA256SUMS", "hotfix/rules-20261101/SHA256SUMS"
good_sums = SUMS.read_text()
git("update-index", "--assume-unchanged", REL_SUMS)   # a SHA256SUMS line naming another hash while the tree looks clean
w(SUMS, good_sums.replace(sha(HOTFIX_ST), "e" * 64))
rc, o = run(C32, "RELEASE\n")
ok("32 refuses a hotfix storage.rules that differs from its SHA256SUMS line (wrong sha), before any live read",
   rc == 3 and "SHA256SUMS" in o and "firebase deploy" not in calls() and "live_rules" not in calls(), o[-300:])
w(SUMS, good_sums)
git("update-index", "--no-assume-unchanged", REL_SUMS)
os.utime(res / "RESULT.txt", (old - 600, old - 600))
rc, o = run(C32, "RELEASE\n")
ok("32 refuses a stale results folder (older than the hotfix storage.rules)", rc == 3 and "older" in o and "firebase deploy" not in calls(), o[-300:])
w(res / "RESULT.txt", "FAIL\n")
rc, o = run(C32, "RELEASE\n")
ok("32 refuses a failed results folder (RESULT.txt FAIL)", rc == 3 and "not PASS" in o and "firebase deploy" not in calls(), o[-300:])
w(res / "RESULT.txt", "PASS\n")
w(res / "SUMMARY.txt", hotfix_summary(sha(HOTFIX_ST), "f" * 64))
rc, o = run(C32, "RELEASE\n")
ok("32 refuses a results folder whose SUMMARY.txt names another text on its storage sha256 line",
   rc == 3 and "storage text tested" in o and "firebase deploy" not in calls(), o[-300:])
w(res / "SUMMARY.txt", hotfix_summary(sha(HOTFIX_FS), sha(HOTFIX_ST)))
rc, o = run(C32, "NO\n")
ok("32 refuses without RELEASE (exit 4), Storage rules unchanged", rc == 4 and "firebase deploy" not in calls() and st()["rules"]["storage"] == DEPLOYED_ST, o[-300:])
rc, o = run(C32, "RELEASE\n")
ev32 = newest("32-storage-hotfix1-")
ok("32 releases the hotfix-1 Storage rules from a temp folder with the reviewed command: PASS", rc == 0 and "RESULT: PASS" in o
   and st()["rules"]["storage"] == HOTFIX_ST
   and "firebase deploy --only storage --project zipper-83816 --non-interactive [cwd=%s/deploy-workdir]" % ev32 in calls(), o[-600:])
sv32 = (ev32 or T) / "live-storage-before.rules"
ok("32 saved the live Storage text first, as 41 does (live-storage-before.rules + .sha256, the names 49 reads)",
   sv32.is_file() and sv32.read_text() == DEPLOYED_ST and Path(str(sv32) + ".sha256").is_file()
   and Path(str(sv32) + ".sha256").read_text().split() == [sha(DEPLOYED_ST), "live-storage-before.rules"])
wd32 = (ev32 or T) / "deploy-workdir"
ok("32 deploy folder: only the hotfix storage.rules and firebase.json {\"storage\":{\"rules\":\"storage.rules\"}}",
   wd32.is_dir() and sorted(x.name for x in wd32.iterdir()) == ["firebase.json", "storage.rules"]
   and (wd32 / "storage.rules").read_text() == HOTFIX_ST and json.loads((wd32 / "firebase.json").read_text()) == {"storage": {"rules": "storage.rules"}})
ok("32 changed no IAM binding and no Firestore rules", "iam-policy-binding" not in calls() and st()["rules"]["firestore"] == HOTFIX_FS)
rc, o = run(C32, "")
ok("32 re-run: already live, no prompt, no deploy", rc == 0 and "ABOUT TO" not in o and "firebase deploy" not in calls(), o[-300:])
rc, o = run(C49, "ROLLBACK\n", (str(ev30),))
ok("49 refuses an evidence folder that is not 32's or 41's (30's)", rc == 3 and "firebase deploy" not in calls(), o[-300:])
rc, o = run(C49, "NO\n", (str(ev32),))
ok("49 on 32's evidence refuses without ROLLBACK (exit 4)", rc == 4 and "firebase deploy" not in calls(), o[-300:])
rc, o = run(C49, "ROLLBACK\n", (str(ev32),))
ok("49 on 32's evidence re-releases the saved 20 Oct text; no IAM question (role not held): PASS", rc == 0 and "RESULT: PASS" in o
   and st()["rules"]["storage"] == DEPLOYED_ST and "evidence of 32" in o and "nothing to revert" in o
   and "firebase deploy --only storage --project zipper-83816 --non-interactive" in calls() and "remove-iam" not in calls(), o[-600:])
time.sleep(1.1)
run(C32, "RELEASE\n")

# ── 20 / 29 Functions wave 2a ──
WAVE_2A_ONLY = ",".join("functions:" + n for n in WAVE_2A)
rc, o = run(C20, "NO\n")
ok("20 refuses without DEPLOY2A (exit 4), after building and testing the exact tree", rc == 4 and "firebase deploy" not in calls() and "node --test on the exact tree: 3/3" in o, o[-800:])
rc, o = run(C20, "DEPLOY2A\n")
ok("20 deploys wave 2a only and verifies (SCOPE PASS, changed=5): PASS", rc == 0 and "RESULT: PASS" in o and "SCOPE PASS" in o and "changed=5" in o, o[-1500:])
ok("20 ran exactly the reviewed command", "firebase deploy --only %s --project zipper-83816 --non-interactive" % WAVE_2A_ONLY in calls())
ok("20 deployed the RELEASE tree (functions v2)", all(st()["functions"][n]["source"].startswith("// functions v2") for n in WAVE_2A))
ok("20 left no .env copy and no node_modules", not list((RELC / "production").glob("20-*/deploy/functions/.env")) and not list((RELC / "production").glob("20-*/deploy/functions/node_modules")))
ok("20 output shows no environment value", not leaks(o), leaks(o))
s = st(); s2 = json.loads(json.dumps(s)); s2["functions"]["releaseBeansForWeek"]["environmentVariables"]["API_BASE"] = "https://other.example"; put(s2)
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
ok("29 2a redeploys the production tree refs/heads/prod-live-20261030 (BASE_COMMIT) with the reviewed command: PASS",
   rc == 0 and "RESULT: PASS" in o and "= the production Functions tree refs/heads/prod-live-20261030" in o
   and "firebase deploy --only %s --project zipper-83816 --non-interactive" % WAVE_2A_ONLY in calls()
   and all(st()["functions"][n]["source"] == PROD_SRC for n in WAVE_2A), o[-1500:])
ok("29 removed its worktree", git("worktree", "list").count("\n") == 0, git("worktree", "list"))
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

# ── 31 Firestore RC2, 40 IAM, 41 Storage RC2, 49 rollback ──
rc2 = REPO / "tests" / "results-rc2-20261101T020000Z"
w(rc2 / "RESULT.txt", "PASS\n")
w(rc2 / "SUMMARY.txt", "firestore rules sha256: %s\nstorage rules sha256: %s\n" % (sha(RC2_FS), sha(RC2_ST)))
rc, o = run(C31, "NO\n", (str(rc2),))
ok("31 refuses without RELEASE (exit 4)", rc == 4 and "firebase deploy" not in calls(), o[-400:])
rc, o = run(C31, "RELEASE\n", (str(rc2),))
ok("31 releases RC2 Firestore rules + indexes with the reviewed command: PASS", rc == 0 and "RESULT: PASS" in o and st()["rules"]["firestore"] == RC2_FS
   and "firebase deploy --only firestore:rules,firestore:indexes --project zipper-83816 --non-interactive" in calls(), o[-600:])
rc, o = run(C41, "RELEASE\n")
ok("41 refuses while the Storage agent lacks the role (40 not run)", rc == 3 and "lacks" in o and "firebase deploy" not in calls(), o[-300:])
rc, o = run(C40, "NO\n")
ok("40 refuses without GRANT (exit 4)", rc == 4 and "add-iam-policy-binding" not in calls(), o[-300:])
rc, o = run(C40, "GRANT\n")
ok("40 grants the Storage agent role with the reviewed command: PASS", rc == 0 and "RESULT: PASS" in o and EXPECTED_MUT["MUT-STORAGE-IAM"][1] in calls(), o[-400:])
ok("40 shows no unmasked address (the policy output is discarded)", not leaks(o), leaks(o))
rc, o = run(C40, "")
ok("40 re-run: nothing to do, no prompt", rc == 0 and "ABOUT TO" not in o and "add-iam" not in calls(), o[-300:])
rc2.rename(REPO / "tests" / "hold")
rc, o = run(C41, "RELEASE\n")
ok("41 refuses without the RC2 emulator results folder", rc == 3 and "firebase deploy" not in calls(), o[-300:])
(REPO / "tests" / "hold").rename(rc2)
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
ok("41 refuses while the MFA CRM is not recorded live (50)", rc == 3 and "firebase deploy" not in calls(), o[-300:])
if crm.with_name("crm-hold").exists():
    crm.with_name("crm-hold").rename(crm)
rc, o = run(C41, "NO\n")
ok("41 refuses without RELEASE (exit 4)", rc == 4 and "firebase deploy" not in calls(), o[-300:])
rc, o = run(C41, "RELEASE\n")
ev41 = newest("41-storage-rules-")
ok("41 releases RC2 Storage rules from a temp folder with the reviewed command: PASS", rc == 0 and "RESULT: PASS" in o and st()["rules"]["storage"] == RC2_ST
   and "firebase deploy --only storage --project zipper-83816 --non-interactive [cwd=%s/deploy-workdir]" % ev41 in calls(), o[-600:])
ok("41 saved the live Storage text (hotfix-1, released by 32) before changing it", (ev41 / "live-storage-before.rules").read_text() == HOTFIX_ST)
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
ok("21 refuses before APK 20 is published with minSupportedVersionCode 20", rc == 3 and "firebase deploy" not in calls(), o[-300:])
APKD = REPO / "zipper-app" / "app" / "build" / "outputs" / "apk" / "prod"


def apks(code="20", dbg="no", signer="debug"):
    for abi in ("arm64-v8a", "armeabi-v7a"):
        w(APKD / ("app-%s-prod.apk" % abi), "FAKEAPK package=com.zipper.app versionCode=%s versionName=1.2.6 debuggable=%s signer=%s abi=%s\n" % (code, dbg, signer, abi))


apks(signer="release")
rc, o = run(C60, "PUBLISH\n")
ok("60 refuses an APK not signed with the debug certificate", rc == 3 and "--apply" not in calls(), o[-300:])
apks(dbg="yes")
rc, o = run(C60, "PUBLISH\n")
ok("60 refuses a debuggable APK", rc == 3 and "--apply" not in calls(), o[-300:])
apks(code="19")
rc, o = run(C60, "PUBLISH\n")
ok("60 refuses an APK whose versionCode is not 20", rc == 3 and "--apply" not in calls(), o[-300:])
apks()
before_doc = st()["android"]
rc, o = run(C60, "NO\n")
ok("60 refuses without PUBLISH (exit 4) after a clean dry run", rc == 4 and "--apply" not in calls() and "dry run" in o, o[-500:])
rc, o = run(C60, "PUBLISH\n")
ev60 = newest("60-publish-apk-")
d = st()["android"]["debug"]
ok("60 publishes APK 20 with minSupportedVersionCode 20 to the debug channel: PASS", rc == 0 and "RESULT: PASS" in o and d["versionCode"] == 20
   and d["minSupportedVersionCode"] == 20 and st()["android"]["release"] == before_doc["release"], o[-900:])
ok("60 ran publish_apk.py --apply on the staged prod APKs (app-<abi>-debug.apk copies)", re.search(r"-m scripts\.publish_apk --channel debug --apk-dir \S+/apk --min-supported 20 --notes .* --apply", calls()))
sv = ev60 / "android-update-before.json"
ok("60 saved the previous androidUpdate document (mode 600) for 61", sv.exists() and json.loads(sv.read_text()) == before_doc and (sv.stat().st_mode & 0o777) == 0o600)
rc, o = run(C60, "PUBLISH\n")
ok("60 re-run refuses: version 20 already published", rc == 3 and "--apply" not in calls(), o[-300:])
rc, o = run(C21, "NO\n")
ok("21 refuses without DEPLOY2B (exit 4)", rc == 4 and "firebase deploy" not in calls(), o[-300:])
rc, o = run(C21, "DEPLOY2B\n")
ok("21 deploys wave 2b only and verifies: PASS", rc == 0 and "RESULT: PASS" in o and "changed=8" in o
   and "firebase deploy --only %s --project zipper-83816 --non-interactive" % ",".join("functions:" + n for n in WAVE_2B) in calls(), o[-1200:])
rc, o = run(C61, "WITHDRAW\n", (str(ev60),))
ok("61 refuses while wave 2b is live (roll 2b back first)", rc == 3 and "wave 2b" in o and "restore" not in calls(), o[-300:])
time.sleep(1.1)
rc, o = run(C29, "ROLLBACK\n", ("2b",))
ok("29 2b rollback to the production tree with the reviewed command: PASS", rc == 0 and "RESULT: PASS" in o and all(st()["functions"][n]["source"] == PROD_SRC for n in WAVE_2B), o[-800:])
rc, o = run(C61, "NO\n", (str(ev60),))
ok("61 refuses without WITHDRAW (exit 4)", rc == 4 and "restore" not in calls(), o[-300:])
rc, o = run(C61, "WITHDRAW\n", (str(ev60),))
ok("61 restores exactly the saved debug record with the reviewed command: PASS", rc == 0 and "RESULT: PASS" in o
   and st()["android"] == before_doc and "android_update_doc.py restore %s debug" % sv in calls(), o[-600:])
time.sleep(1.1)
run(C60, "PUBLISH\n")
time.sleep(1.1)
run(C21, "DEPLOY2B\n")

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
rc, o = run(C10, "GRANT\n")
ok("an untracked file makes every script refuse (10: exit 3)", rc == 3 and "untracked" in o and "add-iam" not in calls(), o[-300:])
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
