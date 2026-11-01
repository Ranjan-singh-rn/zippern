"""Local test of the credential-rotation skeletons (release/rotation-prepared/rot-*.command) — no network, no credentials.

  1. STATIC: every gcloud/firebase invocation is tagged #RO or #MUT-<id>; each #MUT tag appears exactly once in the
     folder and is the reviewed command; forbidden commands appear nowhere in the scripts; #RO lines use read verbs only.
  2. FUNCTIONAL: every script runs against stub gcloud / firebase / npm / curl / date inside a THROWAWAY git
     repository that mirrors the Mac layout: the FINAL-PHASE-APPROVED gate, every typed word, dirty tree, HEAD not the
     released commit, a tampered script. No planted secret value and no unmasked e-mail address may reach the output
     or any evidence file.

Usage: python3 -I test_rotation_scripts.py <rotation-prepared folder>
"""
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROT_SRC = Path(sys.argv[1]).resolve()
results = []
OUTPUTS = []


def ok(name, cond, detail=""):
    results.append((bool(cond), name))
    print(("PASS  " if cond else "FAIL  ") + name + (f"  ({detail})" if detail and not cond else ""))


# ── 1. STATIC ────────────────────────────────────────────────────────────────
EXPECTED_MUT = {
    "MUT-R80-NEWREV": ("rot-80-backend-secret.command", 'gcloud run services update zipper-api --project zipper-83816 '
                       '--region asia-south1 --no-traffic --update-secrets "$ENV_NAME=$SECRET:$V"'),
    "MUT-R80-SHIFT": ("rot-80-backend-secret.command", 'gcloud run services update-traffic zipper-api --project '
                      'zipper-83816 --region asia-south1 --to-revisions "$NEW=100"'),
    "MUT-R80-BACK": ("rot-80-backend-secret.command", 'gcloud run services update-traffic zipper-api --project '
                     'zipper-83816 --region asia-south1 --to-revisions "$1=100"'),
    "MUT-R85-DEPLOY": ("rot-85-functions-redeploy.command", 'firebase deploy --only "$ONLY" --project zipper-83816 --non-interactive'),
    "MUT-R90-DISABLE": ("rot-90-disable-old-version.command", 'gcloud secrets versions disable "$VER" --secret "$SECRET" --project zipper-83816'),
    "MUT-R91-ENABLE": ("rot-91-enable-version.command", 'gcloud secrets versions enable "$VER" --secret "$SECRET" --project zipper-83816'),
}
FORBIDDEN = [r"--to-latest", r"versions\s+access", r"secrets\s+delete", r"versions\s+destroy", r"set-iam-policy",
             r"add-iam-policy-binding", r"remove-iam-policy-binding", r"functions:secrets", r"versions\s+add",
             r"secrets\s+create", r"--force\b", r"get-key-string", r"functions\s+delete", r"run\s+deploy",
             r"revisions\s+delete", r"services\s+delete", r"keys\s+create", r"--only\s+(hosting|firestore|storage)"]
# Code only (prose may name the file): nothing may read functions/.env except the copy into the deploy tree.
FORBIDDEN_CODE = [r"(^|[\s;&|(])(cat|less|more|head|tail|grep|sed|awk|source|\.)\s+[^|;&]*(functions/\.env|\$FN_ENV)"]
RO_PREFIXES = ["gcloud --version", "gcloud config get-value", "gcloud auth list", "gcloud secrets describe",
               "gcloud secrets versions list", "gcloud secrets get-iam-policy", "gcloud run services describe",
               "gcloud run revisions describe", "gcloud run revisions list", "gcloud functions describe",
               "gcloud functions list", "gcloud projects get-iam-policy", "gcloud services api-keys list",
               "gcloud iam service-accounts list", "gcloud iam service-accounts keys list", "gcloud logging read",
               "firebase --version"]
INVOKE = re.compile(r"(^|[\s;&|(`$])(gcloud|firebase)\s")
CALL = re.compile(r"\b(?:gcloud|firebase)\s+[^|;)&]*")
SCRIPTS = sorted(ROT_SRC.glob("rot-*.command"))
seen_mut = {}
for f in SCRIPTS + [ROT_SRC / "rot_common.sh", ROT_SRC / "rot_helpers.py"]:
    text = f.read_text(encoding="utf-8")
    for no, line in enumerate(text.splitlines(), 1):
        for pat in FORBIDDEN:
            if re.search(pat, line):
                ok(f"{f.name}:{no} has no forbidden command", False, pat)
        s = line.strip()
        if not s or s.startswith("#") or f.suffix == ".py":
            continue
        code = s.split("  #")[0] if "  #" in s else s
        for pat in FORBIDDEN_CODE:
            if re.search(pat, code):
                ok(f"{f.name}:{no} does not read functions/.env", False, code[:120])
        if not INVOKE.search(code) or re.search(r"(need_tools|command -v)\b", code):
            continue
        m = re.search(r"#(RO|MUT-[A-Z0-9-]+)\s*$", s)
        if not m:
            ok(f"{f.name}:{no} gcloud/firebase line is tagged", False, s[:120])
            continue
        if m.group(1) == "RO":
            bad = [c for c in CALL.findall(code) if not any(c.startswith(p) for p in RO_PREFIXES)]
            ok(f"{f.name}:{no} #RO line uses read verbs only", not bad, str(bad)[:160])
        else:
            tag = m.group(1)
            seen_mut.setdefault(tag, []).append(f.name)
            ok(f"{f.name}:{no} {tag} is the reviewed command", tag in EXPECTED_MUT and EXPECTED_MUT[tag][1] in code, code[:160])
for tag, (where, _) in EXPECTED_MUT.items():
    ok(f"{tag} appears exactly once, in {where}", seen_mut.get(tag) == [where], str(seen_mut.get(tag)))
ok("no unexpected mutation tag", set(seen_mut) <= set(EXPECTED_MUT), str(set(seen_mut) - set(EXPECTED_MUT)))
for f in SCRIPTS:
    first = [l for l in f.read_text(encoding="utf-8").splitlines() if l.strip() and not l.startswith("#")][:3]
    ok(f"{f.name}: the FINAL-PHASE-APPROVED gate is the first check", len(first) == 3 and "FINAL-PHASE-APPROVED" in first[2]
       and first[0] == "set -u" and first[1] == "umask 077", str(first)[:200])

# ── 2. FUNCTIONAL ────────────────────────────────────────────────────────────
SA = "239458555881-compute@developer.gserviceaccount.com"
FN_SA = "zipper-83816@appspot.gserviceaccount.com"
OPERATOR, MEMBER, ADMIN = "owner.person@example.com", "someone.else@example.com", "admin.person@example.com"
AGORA_OLD, AGORA_NEW = "FAKEAGORAOLDCERT00000000000000001", "FAKEAGORANEWCERT00000000000000002"
SG_OLD, PLAIN = "SG.FAKE-OLD-MAIL-KEY-000000001", "FAKE-PLAIN-ENV-VALUE-0000009"
PLANTED = [AGORA_OLD, AGORA_NEW, SG_OLD, PLAIN, "https://api.fake-internal.example"]
SG_FNS = ["requestEmailBindCode", "requestLoginEmailCode", "onAgencyApproved", "onAgencyRegistered", "onSellerRegistered",
          "onSellerApproved", "onAgencyResendEmail", "onSellerResendEmail", "weeklyPayoutReportGenerator"]


def env_text(agora, api="https://api.fake-internal.example"):
    return f"AGORA_APP_CERTIFICATE={agora}\nSG_MAIL_KEY={SG_OLD}\nSUPERADMIN_EMAIL={ADMIN}\nAPI_BASE={api}\n"


def dotenv(text):
    return dict(l.split("=", 1) for l in text.splitlines() if "=" in l)


def fresh_state():
    def ref(env, secret, key):
        return {"name": env, "valueFrom": {"secretKeyRef": {"name": secret, "key": key}}}
    env = [ref("JWT_SECRET", "JWT_SECRET", "latest"), ref("MONGO_URI", "MONGO_URI", "latest"),
           ref("OWNER_MFA_ENCRYPTION_KEY", "OWNER_MFA_ENCRYPTION_KEY", "1"),
           ref("SENDGRID_API_KEY", "ZIPPER_SENDGRID_API_KEY", "1"),
           ref("SERVICE_KEY_REPORTING", "SERVICE_KEY_REPORTING", "latest"),
           {"name": "MAIL_FROM_NAME", "value": PLAIN}, {"name": "EMAIL_PROVIDER", "value": "sendgrid"}]
    img = "asia-south1-docker.pkg.dev/zipper-83816/cloud-run-source-deploy/zipper-api@sha256:" + "a" * 64
    revs = {"zipper-api-00050-cmp": {"image": img, "env": env},
            "zipper-api-00046-siw": {"image": img.replace("a" * 64, "b" * 64),
                                     "env": [ref("SENDGRID_API_KEY", "SENDGRID_API_KEY", "latest")] + env[:2]}}
    secrets = {s: [{"n": 1, "state": "DISABLED"}, {"n": 2, "state": "ENABLED"}] for s in ("JWT_SECRET", "MONGO_URI")}
    for s in ("ZIPPER_SENDGRID_API_KEY", "SENDGRID_API_KEY", "SERVICE_KEY_WEEKLY_ACCRUAL", "SERVICE_KEY_REPORTING",
              "SERVICE_KEY_PARTNER_REGISTRATION", "ZIPPER_ACCRUAL_KEY", "ZIPPER_REPORTING_KEY",
              "ZIPPER_PARTNER_REGISTRATION_KEY", "OWNER_MFA_ENCRYPTION_KEY"):
        secrets[s] = [{"n": 1, "state": "ENABLED"}]
    fns = {}

    def fn(name, region, secs):
        fns[name] = {"name": f"projects/zipper-83816/locations/{region}/functions/{name}", "status": "ACTIVE",
                     "entryPoint": name, "runtime": "nodejs22", "serviceAccountEmail": FN_SA, "versionId": "5",
                     "updateTime": "2026-11-01T00:00:00Z",
                     "environmentVariables": dict(dotenv(env_text(AGORA_OLD)), FIREBASE_CONFIG="{}", GCLOUD_PROJECT="zipper-83816"),
                     "secretEnvironmentVariables": [{"key": s, "secret": s, "version": "1"} for s in secs]}
    for n in SG_FNS[:-1]:
        fn(n, "asia-south1", ["ZIPPER_SENDGRID_API_KEY"])
    fn("weeklyPayoutReportGenerator", "us-central1", ["ZIPPER_ACCRUAL_KEY", "ZIPPER_SENDGRID_API_KEY"])
    fn("scheduledAlertScan", "asia-south1", ["ZIPPER_REPORTING_KEY"])
    fn("registerAgencyPartner", "asia-south1", ["ZIPPER_PARTNER_REGISTRATION_KEY"])
    fn("generateAgoraToken", "asia-south1", [])
    fn("settleGift", "asia-south1", [])
    return {"secrets": secrets, "revisions": revs, "latest": "zipper-api-00050-cmp", "counter": 51,
            "traffic": [{"revisionName": "zipper-api-00050-cmp", "percent": 100}],
            "url": "https://zipper-api-stub-el.a.run.app", "functions": fns, "deploys": 0}


GCLOUD_STUB = r'''#!/usr/bin/env python3
import json, os, sys
st = os.environ["STUB_STATE"]; S = json.load(open(st))
open(os.environ["STUB_LOG"], "a").write("gcloud " + " ".join(sys.argv[1:]) + "\n")
a = sys.argv[1:]
SA = "%(SA)s"
def out(o): print(json.dumps(o)); sys.exit(0)
def fail(m, rc=1): sys.stderr.write(m + "\n"); sys.exit(rc)
def save(): json.dump(S, open(st, "w"))
def opt(k):
    for i, x in enumerate(a):
        if x == k: return a[i + 1]
        if x.startswith(k + "="): return x.split("=", 1)[1]
def rev(name):
    r = S["revisions"][name]
    return {"metadata": {"name": name}, "spec": {"serviceAccountName": SA, "containers": [{"image": r["image"], "env": r["env"]}]},
            "status": {"imageDigest": r["image"], "conditions": [{"type": "Ready", "status": "True"}, {"type": "Active", "status": "True"}]}}
def service():
    t = S["revisions"][S["latest"]]
    return {"metadata": {"name": "zipper-api"},
            "status": {"url": S["url"], "latestCreatedRevisionName": S["latest"], "latestReadyRevisionName": S["latest"], "traffic": S["traffic"]},
            "spec": {"traffic": S["traffic"], "template": {"spec": {"serviceAccountName": SA, "containers": [{"image": t["image"], "env": t["env"]}]}}}}
if a[:1] == ["--version"]: print("Google Cloud SDK 999.0.0 (stub)"); sys.exit(0)
if a[:3] == ["config", "get-value", "project"]: print("zipper-83816"); sys.exit(0)
if a[:2] == ["auth", "list"]: print("%(OPERATOR)s"); sys.exit(0)
if a[:2] == ["secrets", "describe"]:
    if a[2] not in S["secrets"]: fail("NOT_FOUND")
    out({"name": "projects/1/secrets/" + a[2], "replication": {"automatic": {}}, "createTime": "2026-08-01T00:00:00Z"})
if a[:3] == ["secrets", "versions", "list"]:
    out([{"name": "projects/1/secrets/%%s/versions/%%d" %% (a[3], v["n"]), "state": v["state"], "createTime": "2026-10-0%%dT00:00:00Z" %% min(v["n"], 9)} for v in S["secrets"].get(a[3], [])])
if a[:2] == ["secrets", "get-iam-policy"]:
    out({"bindings": [{"role": "roles/secretmanager.secretAccessor", "members": ["serviceAccount:" + SA, "user:%(MEMBER)s"]}]})
if a[:3] in (["secrets", "versions", "disable"], ["secrets", "versions", "enable"]):
    for v in S["secrets"][opt("--secret")]:
        if str(v["n"]) == a[3]: v["state"] = "DISABLED" if a[2] == "disable" else "ENABLED"
    save(); sys.exit(0)
if a[:3] == ["run", "services", "describe"]: out(service())
if a[:3] == ["run", "revisions", "describe"]:
    if a[3] not in S["revisions"]: fail("NOT_FOUND")
    out(rev(a[3]))
if a[:3] == ["run", "revisions", "list"]: out([rev(n) for n in sorted(S["revisions"])])
if a[:3] == ["run", "services", "update"]:
    e, _, sv = opt("--update-secrets").partition("=")
    s, _, k = sv.partition(":")
    name = "zipper-api-%%05d-rot" %% S["counter"]; S["counter"] += 1
    base = S["revisions"][S["latest"]]
    env = [x for x in base["env"] if x["name"] != e] + [{"name": e, "valueFrom": {"secretKeyRef": {"name": s, "key": k}}}]
    S["revisions"][name] = {"image": base["image"], "env": env}; S["latest"] = name
    if "--no-traffic" not in a: S["traffic"] = [{"revisionName": name, "percent": 100}]
    save(); sys.exit(0)
if a[:3] == ["run", "services", "update-traffic"]:
    r, _, pct = opt("--to-revisions").partition("=")
    S["traffic"] = [{"revisionName": r, "percent": int(pct)}]; save(); sys.exit(0)
if a[:2] == ["functions", "list"]: out(list(S["functions"].values()))
if a[:2] == ["functions", "describe"]:
    f = S["functions"].get(a[2])
    if not f or "/locations/%%s/" %% opt("--region") not in f["name"]: fail("NOT_FOUND")
    out(f)
if a[:2] == ["projects", "get-iam-policy"]:
    out({"bindings": [{"role": "roles/owner", "members": ["user:%(MEMBER)s", "user:%(OPERATOR)s"]},
                      {"role": "roles/editor", "members": ["serviceAccount:" + SA]}]})
if a[:3] == ["services", "api-keys", "list"]:
    out([{"name": "projects/1/locations/global/keys/k1", "displayName": "Android key (auto created by Firebase)",
          "restrictions": {"androidKeyRestrictions": {"allowedApplications": [{"packageName": "com.zipper.app"}]}}},
         {"name": "projects/1/locations/global/keys/k2", "displayName": "Browser key (auto created by Firebase)"}])
if a[:3] == ["iam", "service-accounts", "list"]: print(SA); print("firebase-adminsdk-x@zipper-83816.iam.gserviceaccount.com"); sys.exit(0)
if a[:4] == ["iam", "service-accounts", "keys", "list"]:
    out([{"name": "projects/p/serviceAccounts/x/keys/abcdef0123456789", "validAfterTime": "2026-01-01T00:00:00Z",
          "validBeforeTime": "9999-12-31T23:59:59Z"}] if "adminsdk" in opt("--iam-account") else [])
if a[:2] == ["logging", "read"]: sys.exit(0)
fail("stub: unexpected gcloud call: " + " ".join(a), 9)
''' % {"SA": SA, "OPERATOR": OPERATOR, "MEMBER": MEMBER}

FIREBASE_STUB = r'''#!/usr/bin/env python3
import json, os, sys
st = os.environ["STUB_STATE"]; S = json.load(open(st))
open(os.environ["STUB_LOG"], "a").write("firebase " + " ".join(sys.argv[1:]) + "\n")
a = sys.argv[1:]
if a[:1] == ["--version"]: print("15.17.0"); sys.exit(0)
if a[:1] == ["deploy"]:
    assert os.path.isfile("firebase.json") and os.path.isfile("functions/.env") and os.path.isdir("functions/lib"), "bad deploy dir"
    env = dict(l.strip().split("=", 1) for l in open("functions/.env") if "=" in l)
    S["deploys"] += 1
    for item in a[a.index("--only") + 1].split(","):
        f = S["functions"][item.split(":", 1)[1]]
        f["versionId"] = str(int(f["versionId"]) + 1); f["updateTime"] = "2026-11-0%dT00:00:%02dZ" % (min(S["deploys"], 9), S["deploys"])
        for s in f["secretEnvironmentVariables"]:
            s["version"] = str(max(v["n"] for v in S["secrets"][s["secret"]] if v["state"] == "ENABLED"))
        f["environmentVariables"] = dict(env, FIREBASE_CONFIG="{}", GCLOUD_PROJECT="zipper-83816")
    json.dump(S, open(st, "w")); print("Deploy complete!"); sys.exit(0)
sys.exit(9)
'''
NPM_STUB = '#!/bin/bash\necho "npm $*" >> "$STUB_LOG"\ncase "$1" in --version) echo 10.9.9;; ci) mkdir -p node_modules;; run) [ "$2" = build ] && mkdir -p lib;; esac\nexit 0\n'
CURL_STUB = r'''#!/usr/bin/env python3
import os, sys
open(os.environ["STUB_LOG"], "a").write("curl " + " ".join(sys.argv[1:]) + "\n")
a = sys.argv[1:]
if "-o" in a: open(a[a.index("-o") + 1], "w").write('{"status":"ok"}')
sys.stdout.write("200")
'''
# Deterministic clock for the Sunday guard (Wednesday 12:00 UTC); everything else is the real date.
DATE_STUB = '#!/bin/bash\ncase "$*" in "-u +%u") echo 3; exit 0;; "-u +%H%M") echo 1200; exit 0;; esac\nexec /bin/date "$@"\n'
SHASUM_STUB = '#!/bin/bash\nshift 2\nexec sha256sum "$@"\n'

t = Path(tempfile.mkdtemp(prefix="rotprep-"))
REPO = t / "repo"
ROT = REPO / "release" / "rotation-prepared"
COMP = REPO / "release" / "completion-20261101"
ROT.mkdir(parents=True)
COMP.mkdir(parents=True)
for name in ["rot_common.sh", "rot_helpers.py", ".gitignore"] + [p.name for p in SCRIPTS]:
    shutil.copy2(ROT_SRC / name, ROT / name)
(COMP / "README.txt").write_text("stand-in for the completion release folder\n")
(REPO / "functions" / "src").mkdir(parents=True)
(REPO / "functions" / "package.json").write_text('{"name": "functions", "scripts": {"build": "tsc"}}\n')
(REPO / "functions" / "package-lock.json").write_text('{"lockfileVersion": 3}\n')
(REPO / "functions" / "src" / "index.ts").write_text("export const x = 1\n")
(REPO / "firebase.json").write_text(json.dumps({"functions": {"source": "functions"}, "hosting": [{"target": "production"}]}))
(REPO / ".gitignore").write_text(".env\nnode_modules/\nlib/\n")
ENV_FILE = REPO / "functions" / ".env"
ENV_FILE.write_text(env_text(AGORA_OLD))
SHA = "shasum -a 256" if shutil.which("shasum") else "sha256sum"
subprocess.run(f"cd '{ROT}' && {SHA} rot_common.sh rot_helpers.py rot-*.command > SCRIPTS.sha256", shell=True, check=True)
GIT = ["git", "-C", str(REPO), "-c", "user.name=fixture", "-c", "user.email=fixture@localhost.invalid", "-c", "commit.gpgsign=false"]
subprocess.run(["git", "-c", "init.defaultBranch=main", "init", "-q", str(REPO)], check=True)
with open(REPO / ".git" / "info" / "exclude", "a") as fh:   # what the completion folder's own .gitignore will do
    fh.write("release/completion-20261101/RELEASE.txt\nrelease/completion-20261101/production/\n")
subprocess.run(GIT + ["add", "-A"], check=True)
subprocess.run(GIT + ["commit", "-q", "-m", "fixture"], check=True)
HEAD = subprocess.run(["git", "-C", str(REPO), "rev-parse", "HEAD"], capture_output=True, text=True, check=True).stdout.strip()
TREE = subprocess.run(["python3", "-I", str(ROT / "rot_helpers.py"), "tree-sha", str(REPO), "HEAD", "functions"],
                      capture_output=True, text=True, check=True).stdout.strip()
RELEASE = f"HEAD={HEAD}\nBASE_COMMIT={HEAD}\n{TREE}\nFILE firestore.rules 0\n"
(COMP / "RELEASE.txt").write_text(RELEASE)
BIN = t / "bin"
BIN.mkdir()
stubs = [("gcloud", GCLOUD_STUB), ("firebase", FIREBASE_STUB), ("npm", NPM_STUB), ("curl", CURL_STUB), ("date", DATE_STUB)]
if not shutil.which("shasum"):
    stubs.append(("shasum", SHASUM_STUB))
for name, body in stubs:
    (BIN / name).write_text(body)
    (BIN / name).chmod(0o755)
STATE, LOG = t / "state.json", t / "calls.log"


def save(st):
    STATE.write_text(json.dumps(st))


def load():
    return json.loads(STATE.read_text())


def calls():
    return LOG.read_text() if LOG.exists() else ""


def clear():
    LOG.unlink() if LOG.exists() else None


def run(script, *args, stdin="", extra=None):
    env = {"PATH": f"{BIN}:/usr/bin:/bin", "HOME": str(t / "home"), "CLOUDSDK_CONFIG": str(t / "no-gcloud-config"),
           "STUB_STATE": str(STATE), "STUB_LOG": str(LOG), "LANG": "C.UTF-8", "TZ": "UTC"}
    env.update(extra or {})
    p = subprocess.run(["/bin/bash", str(ROT / script), *args], input=stdin, text=True, env=env, capture_output=True, timeout=900)
    OUTPUTS.append(p.stdout + p.stderr)
    return p.returncode, p.stdout + p.stderr


def serving():
    st = load()
    return st["traffic"][0]["revisionName"] if len(st["traffic"]) == 1 else None


def maps(rev, env_name):
    for e in load()["revisions"][rev]["env"]:
        if e["name"] == env_name and "valueFrom" in e:
            r = e["valueFrom"]["secretKeyRef"]
            return "%s:%s" % (r["name"], r["key"])


def add_version(secret):
    st = load()
    st["secrets"][secret].append({"n": max(v["n"] for v in st["secrets"][secret]) + 1, "state": "ENABLED"})
    save(st)


def clean_tree():
    return subprocess.run(["git", "-C", str(REPO), "status", "--porcelain", "--untracked-files=normal"],
                          capture_output=True, text=True).stdout == ""


MUT_RE = re.compile(r"run services update |update-traffic|versions (disable|enable)|firebase deploy")
save(fresh_state())

# The stubs must be what the scripts run (rot_common.sh appends the usual SDK folders at the END of PATH).
probe = ROT / "_probe.sh"
probe.write_text('. "$(dirname "$0")/rot_common.sh"\nfor x in gcloud firebase npm curl date; do command -v $x; done\n')
_, where = run("_probe.sh")
probe.unlink()
ok("inside the scripts gcloud/firebase/npm/curl/date are the stubs", len(where.split()) == 5 and all(w.startswith(str(BIN) + "/") for w in where.split()), where)
if len(where.split()) != 5 or not all(w.startswith(str(BIN) + "/") for w in where.split()):
    print("ABORT: a real tool would run inside the scripts; nothing else is run.")
    sys.exit(2)

# ── the gate: nothing runs without FINAL-PHASE-APPROVED ──
GATE_ARGS = {"rot-00-inventory-readonly.command": [], "rot-80-backend-secret.command": ["JWT_SECRET", "pin"],
             "rot-85-functions-redeploy.command": ["ZIPPER_SENDGRID_API_KEY"],
             "rot-90-disable-old-version.command": ["JWT_SECRET", "1"], "rot-91-enable-version.command": ["JWT_SECRET", "1"]}
ok("every rot-*.command is covered by the gate test", set(GATE_ARGS) == {p.name for p in SCRIPTS}, str({p.name for p in SCRIPTS}))
for s, args in GATE_ARGS.items():
    clear()
    rc, o = run(s, *args, stdin="PIN\nSHIFT\nNEWREV\nREDEPLOY\nDISABLE\nENABLE\nBACK\n")
    ok(f"{s} refuses without FINAL-PHASE-APPROVED (exit 2, no tool called)", rc == 2 and "REFUSING: final phase not approved" in o and calls() == "", f"rc={rc} {o[-200:]} calls={calls()[:200]}")
(ROT / "FINAL-PHASE-APPROVED").write_text("approved for this local test\n")
ok("FINAL-PHASE-APPROVED and production/ do not dirty the tree (.gitignore)", clean_tree())

# ── 00 inventory ──
clear()
rc, o = run("rot-00-inventory-readonly.command")
ok("00 runs read-only and passes", rc == 0 and "RESULT: PASS" in o, o[-600:])
ok("00 called no mutating command", not MUT_RE.search(calls()), calls()[-300:])
ok("00 lists versions, pins and .env-name counts", "JWT_SECRET: exists=yes enabled=1 latest-enabled=2" in o
   and "ZIPPER_SENDGRID_API_KEY:1 x9" in o and ".env name AGORA_APP_CERTIFICATE set on 13 function(s)" in o
   and "APIKEY Browser_key_(auto_created_by_Firebase) app=NONE apis=NONE" in o and "ROLE roles/owner people=2" in o, o[-1500:])

# ── 80 backend: pin, switch, back ──
clear()
rc, o = run("rot-80-backend-secret.command", "JWT_SECRET", "pin", stdin="NOPE\n")
ok("80 pin stops without PIN (exit 4), no revision created", rc == 4 and "run services update" not in calls(), o[-300:])
clear()
rc, o = run("rot-80-backend-secret.command", "JWT_SECRET", "pin", stdin="PIN\nSHIFT\n")
c, new = calls(), serving()
ok("80 pin: PIN + SHIFT -> PASS", rc == 0 and "RESULT: PASS" in o, o[-900:])
ok("80 pin ran exactly the reviewed commands", "run services update zipper-api --project zipper-83816 --region asia-south1 --no-traffic --update-secrets JWT_SECRET=JWT_SECRET:2" in c
   and f"run services update-traffic zipper-api --project zipper-83816 --region asia-south1 --to-revisions {new}=100" in c, c[-600:])
ok("80 pin: the serving revision maps JWT_SECRET:2 (the value it had)", maps(new, "JWT_SECRET") == "JWT_SECRET:2" and new != "zipper-api-00050-cmp")
PINNED = new
clear()
rc, o = run("rot-80-backend-secret.command", "JWT_SECRET", "pin", stdin="")
ok("80 pin re-run: already pinned, nothing changed", rc == 0 and "already pinned" in o and not MUT_RE.search(calls()), o[-300:])
clear()
rc, o = run("rot-80-backend-secret.command", "JWT_SECRET", "switch", stdin="NEWREV\n")
ok("80 switch refuses without a newer ENABLED version", rc == 3 and "no ENABLED version" in o and not MUT_RE.search(calls()), o[-300:])
add_version("JWT_SECRET")
clear()
rc, o = run("rot-80-backend-secret.command", "JWT_SECRET", "switch", stdin="NEWREV\nSHIFT\n")
ok("80 JWT switch needs SIGNOUT, not SHIFT (exit 4; revision at 0%, traffic unchanged)", rc == 4 and "update-traffic" not in calls() and serving() == PINNED, o[-300:])
clear()
rc, o = run("rot-80-backend-secret.command", "JWT_SECRET", "switch", stdin="NEWREV\nSIGNOUT\n")
ok("80 JWT switch: NEWREV + SIGNOUT -> PASS, serving maps JWT_SECRET:3", rc == 0 and "RESULT: PASS" in o and maps(serving(), "JWT_SECRET") == "JWT_SECRET:3", o[-900:])
ok("80 switch kept every other reference (MONGO_URI:latest, OWNER_MFA_ENCRYPTION_KEY:1)", maps(serving(), "MONGO_URI") == "MONGO_URI:latest"
   and maps(serving(), "OWNER_MFA_ENCRYPTION_KEY") == "OWNER_MFA_ENCRYPTION_KEY:1")
clear()
rc, o = run("rot-80-backend-secret.command", "JWT_SECRET", "back", stdin="NO\n")
ok("80 back stops without BACK (exit 4)", rc == 4 and "update-traffic" not in calls(), o[-300:])
clear()
rc, o = run("rot-80-backend-secret.command", "JWT_SECRET", "back", stdin="BACK\n")
ok("80 back: BACK -> 100% on the pinned revision (reviewed line)", rc == 0 and serving() == PINNED
   and f"--to-revisions {PINNED}=100" in calls(), o[-500:])
clear()
rc, o = run("rot-90-disable-old-version.command", "JWT_SECRET", "2", stdin="DISABLE\n")
ok("90 refuses a version the serving revision maps", rc == 3 and "with traffic" in o and "versions disable" not in calls(), o[-300:])
rc, o = run("rot-80-backend-secret.command", "JWT_SECRET", "switch", stdin="NEWREV\nSIGNOUT\n")
ok("80 JWT switch again -> PASS", rc == 0 and maps(serving(), "JWT_SECRET") == "JWT_SECRET:3", o[-500:])
clear()
rc, o = run("rot-90-disable-old-version.command", "JWT_SECRET", "2", stdin="DISABLE\n")
ok("90 refuses inside the rollback window", rc == 3 and "rollback window" in o and "versions disable" not in calls(), o[-300:])
clear()
rc, o = run("rot-90-disable-old-version.command", "JWT_SECRET", "2", stdin="NO\n", extra={"ROT_WINDOW_DAYS": "0"})
ok("90 stops without DISABLE (exit 4)", rc == 4 and "versions disable" not in calls(), o[-300:])
clear()
rc, o = run("rot-90-disable-old-version.command", "JWT_SECRET", "2", stdin="DISABLE\n", extra={"ROT_WINDOW_DAYS": "0"})
st = load()
ok("90 DISABLE -> version 2 DISABLED, 0% revisions that map it listed", rc == 0 and "RESULT: PASS" in o and "would not start afterwards" in o
   and [v["state"] for v in st["secrets"]["JWT_SECRET"] if v["n"] == 2] == ["DISABLED"]
   and "secrets versions disable 2 --secret JWT_SECRET --project zipper-83816" in calls(), o[-600:])
clear()
rc, o = run("rot-91-enable-version.command", "JWT_SECRET", "2", stdin="NO\n")
ok("91 stops without ENABLE (exit 4)", rc == 4 and "versions enable" not in calls(), o[-300:])
rc, o = run("rot-91-enable-version.command", "JWT_SECRET", "2", stdin="ENABLE\n")
ok("91 ENABLE -> version 2 ENABLED", rc == 0 and [v["state"] for v in load()["secrets"]["JWT_SECRET"] if v["n"] == 2] == ["ENABLED"], o[-400:])
clear()
rc, o = run("rot-90-disable-old-version.command", "JWT_SECRET", "3", stdin="DISABLE\n", extra={"ROT_WINDOW_DAYS": "0"})
ok("90 refuses to retire the newest version while the template/serving revision use the secret", rc == 3 and "RETIRING" in o
   and "maps JWT_SECRET (any version)" in o and "versions disable" not in calls(), o[-300:])
clear()
rc, o = run("rot-90-disable-old-version.command", "SENDGRID_API_KEY", "1", stdin="DISABLE\n")
ok("90 retires the old SENDGRID_API_KEY (used only by BASE at 0%, listed): DISABLE -> PASS", rc == 0 and "RESULT: PASS" in o
   and "would not start afterwards: zipper-api-00046-siw SENDGRID_API_KEY" in o
   and [v["state"] for v in load()["secrets"]["SENDGRID_API_KEY"]] == ["DISABLED"], o[-600:])
clear()
rc, o = run("rot-80-backend-secret.command", "OWNER_MFA_ENCRYPTION_KEY", "pin", stdin="")
ok("80 pin of an already pinned secret changes nothing", rc == 0 and "already pinned" in o and not MUT_RE.search(calls()), o[-300:])
add_version("OWNER_MFA_ENCRYPTION_KEY")
clear()
rc, o = run("rot-80-backend-secret.command", "OWNER_MFA_ENCRYPTION_KEY", "switch", stdin="NEWREV\nSHIFT\n")
ok("80 MFA-key switch needs REENROL (exit 4)", rc == 4 and "update-traffic" not in calls(), o[-300:])
rc, o = run("rot-80-backend-secret.command", "OWNER_MFA_ENCRYPTION_KEY", "switch", stdin="NEWREV\nREENROL\n")
ok("80 MFA-key switch: NEWREV + REENROL -> PASS", rc == 0 and maps(serving(), "OWNER_MFA_ENCRYPTION_KEY") == "OWNER_MFA_ENCRYPTION_KEY:2", o[-500:])
rc, o = run("rot-80-backend-secret.command", "BOGUS_NAME", "pin")
ok("80 refuses an unknown variable (usage, exit 2)", rc == 2, o[-200:])
CUR = serving()
st = load()
st["revisions"]["zipper-api-00099-drf"] = {"image": st["revisions"][CUR]["image"],
                                           "env": st["revisions"][CUR]["env"] + [{"name": "EXTRA_DRIFT", "value": "x"}]}
st["latest"] = "zipper-api-00099-drf"
save(st)
clear()
rc, o = run("rot-80-backend-secret.command", "MONGO_URI", "pin", stdin="PIN\nSHIFT\n")
ok("80 refuses when the template differs from the serving revision by another name", rc == 3 and "differs from" in o and not MUT_RE.search(calls()), o[-300:])
st = load(); del st["revisions"]["zipper-api-00099-drf"]; st["latest"] = CUR; save(st)

# ── 85 functions ──
clear()
rc, o = run("rot-85-functions-redeploy.command", "ZIPPER_SENDGRID_API_KEY", stdin="REDEPLOY\n")
ok("85 with no newer version: nothing to do", rc == 0 and "nothing to do" in o and "firebase deploy" not in calls(), o[-300:])
add_version("ZIPPER_SENDGRID_API_KEY")
clear()
rc, o = run("rot-85-functions-redeploy.command", "ZIPPER_SENDGRID_API_KEY", stdin="NO\n")
ok("85 stops without REDEPLOY (exit 4), after npm ci + build, no deploy", rc == 4 and "firebase deploy" not in calls() and "npm ci" in calls(), o[-400:])
clear()
rc, o = run("rot-85-functions-redeploy.command", "ZIPPER_SENDGRID_API_KEY", stdin="REDEPLOY\n")
c = calls()
ok("85 SendGrid: REDEPLOY -> PASS, exactly the 9 functions changed", rc == 0 and "RESULT: PASS" in o and "changed=9" in o and "SCOPE PASS" in o, o[-1200:])
ok("85 ran exactly the reviewed deploy once", c.count("firebase deploy") == 1 and
   "firebase deploy --only " + ",".join("functions:" + n for n in sorted(SG_FNS)) + " --project zipper-83816 --non-interactive" in c, c[-500:])
ok("85: all 9 now pin ZIPPER_SENDGRID_API_KEY:2", all(s["version"] == "2" for n in SG_FNS for s in load()["functions"][n]["secretEnvironmentVariables"] if s["key"] == "ZIPPER_SENDGRID_API_KEY"))
ok("85 left no .env copy and no node_modules behind", not list(ROT.glob("production/r85-*/deploy/functions/.env")) and not list(ROT.glob("production/r85-*/deploy/functions/node_modules")))
rc, o = run("rot-80-backend-secret.command", "SENDGRID_API_KEY", "switch", stdin="NEWREV\nSHIFT\n")
ok("80 SENDGRID_API_KEY switch -> backend maps ZIPPER_SENDGRID_API_KEY:2", rc == 0 and maps(serving(), "SENDGRID_API_KEY") == "ZIPPER_SENDGRID_API_KEY:2", o[-500:])
add_version("ZIPPER_REPORTING_KEY")
ENV_FILE.write_text(env_text(AGORA_OLD, api="https://api.other-fake.example"))
clear()
rc, o = run("rot-85-functions-redeploy.command", "ZIPPER_REPORTING_KEY", stdin="REDEPLOY\n")
ok("85 refuses when functions/.env differs from the deployed environment (value not shown)", rc == 3 and "firebase deploy" not in calls()
   and "API_BASE DIFFERENT" in o and "other-fake" not in o, o[-500:])
ENV_FILE.write_text(env_text(AGORA_OLD))
clear()
rc, o = run("rot-85-functions-redeploy.command", "AGORA", stdin="REDEPLOY\n")
ok("85 AGORA refuses before wave 2b evidence exists", rc == 3 and "wave 2b" in o and "firebase deploy" not in calls(), o[-300:])
ev = COMP / "production" / "21-functions-2b-20261101T000000Z"
ev.mkdir(parents=True)
(ev / "SUMMARY.txt").write_text("RESULT: PASS\n")
rc, o = run("rot-85-functions-redeploy.command", "AGORA", stdin="REDEPLOY\n")
ok("85 AGORA refuses while functions/.env still holds the deployed certificate", rc == 3 and "equals what" in o, o[-300:])
ENV_FILE.write_text(env_text(AGORA_NEW))
clear()
rc, o = run("rot-85-functions-redeploy.command", "AGORA", stdin="NO\n")
ok("85 AGORA stops without REDEPLOY (exit 4)", rc == 4 and "firebase deploy" not in calls(), o[-300:])
clear()
rc, o = run("rot-85-functions-redeploy.command", "AGORA", stdin="REDEPLOY\n")
ok("85 AGORA: only generateAgoraToken redeployed with the new certificate", rc == 0 and "changed=1" in o
   and "firebase deploy --only functions:generateAgoraToken --project zipper-83816 --non-interactive" in calls()
   and load()["functions"]["generateAgoraToken"]["environmentVariables"]["AGORA_APP_CERTIFICATE"] == AGORA_NEW
   and load()["functions"]["settleGift"]["environmentVariables"]["AGORA_APP_CERTIFICATE"] == AGORA_OLD, o[-900:])
ENV_FILE.write_text(env_text(AGORA_OLD))

# ── refusals common to every script ──
(REPO / "stray.txt").write_text("x\n")
rc, o = run("rot-00-inventory-readonly.command")
ok("dirty tree: refused (exit 3)", rc == 3 and "working tree" in o, o[-300:])
(REPO / "stray.txt").unlink()
(COMP / "RELEASE.txt").write_text(RELEASE.replace(HEAD, "0" * 40))
rc, o = run("rot-80-backend-secret.command", "MONGO_URI", "pin", stdin="PIN\nSHIFT\n")
ok("HEAD is not the released commit: refused (exit 3)", rc == 3 and "not the released commit" in o, o[-300:])
(COMP / "RELEASE.txt").write_text(RELEASE)
orig = (ROT / "rot-91-enable-version.command").read_text()
(ROT / "rot-91-enable-version.command").write_text(orig + "\n# tampered\n")
rc, o = run("rot-00-inventory-readonly.command")
ok("a file that no longer matches SCRIPTS.sha256: every script refuses (exit 2)", rc == 2 and "REFUSING TO RUN" in o, o[-200:])
(ROT / "rot-91-enable-version.command").write_text(orig)
rc, o = run("rot-00-inventory-readonly.command")
ok("restored: 00 passes again", rc == 0 and "RESULT: PASS" in o, o[-300:])

# ── never a value, never an address ──
EMAIL = re.compile(r"([A-Za-z0-9._%+*-]+)@([A-Za-z0-9.-]+\.[A-Za-z]{2,})")


def unmasked(text):
    return sorted({m.group(0) for m in EMAIL.finditer(text)
                   if not (m.group(2).endswith("gserviceaccount.com") or re.fullmatch(r".\*\*\*", m.group(1)))})


evidence = "".join(p.read_text(errors="replace") for p in ROT.glob("production/**/*") if p.is_file())
alltext = "".join(OUTPUTS) + evidence
ok("no planted secret/env value in any output or evidence file", not [v for v in PLANTED if v in alltext], str([v for v in PLANTED if v in alltext]))
ok("no unmasked e-mail address in any output or evidence file", not unmasked(alltext), str(unmasked(alltext))[:300])

shutil.rmtree(t, ignore_errors=True)
bad = [r for r in results if not r[0]]
print(f"\nbash: {subprocess.run(['/bin/bash', '--version'], capture_output=True, text=True).stdout.splitlines()[0]}")
print(f"{len(results) - len(bad)}/{len(results)} PASS")
sys.exit(1 if bad else 0)
