"""ZIPPER credential rotation (FINAL PHASE, prepared) — read-only helpers for rot-*.command in this folder.

Every subcommand reads JSON (from gcloud) or git on stdin/a file and prints ONLY metadata: names, version numbers,
states, times, roles, service-account identities, hashes and same/different verdicts. It never prints a secret value,
an environment-variable value, a key, a token or a person's address (user:/group:/domain: members are masked; e-mail
addresses are masked). Function and revision descriptions are piped in, never saved, because they carry env values.
Self-contained on purpose (no import from ../completion-20261101). Usage: python3 -I rot_helpers.py <cmd> [args]
"""
import datetime
import hashlib
import json
import re
import subprocess
import sys

USER_RE = re.compile(r"^(user|group|domain):.*$")
EMAIL_RE = re.compile(r"([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*@([A-Za-z0-9.-]+\.[A-Za-z]{2,})")
PLATFORM_ENV = {"FIREBASE_CONFIG", "GCLOUD_PROJECT", "EVENTARC_CLOUD_EVENT_SOURCE", "LOG_EXECUTION_ID",
                "FUNCTION_SIGNATURE_TYPE", "FUNCTION_TARGET", "K_SERVICE", "K_REVISION", "PORT"}


def load(src):
    raw = sys.stdin.read() if src == "-" else open(src, encoding="utf-8").read()
    try:
        return json.loads(raw) if raw.strip() else None
    except ValueError:
        return "UNREADABLE"


def mask(member):
    return USER_RE.sub(lambda m: m.group(1) + ":<masked>", member)


def _hash(v):
    return hashlib.sha256(str(v).encode("utf-8")).hexdigest()


# ── Secret Manager / IAM ─────────────────────────────────────────────────────

def secret_meta(src):
    d = load(src)
    if not isinstance(d, dict):
        print("EXISTS no")
        return
    rep = d.get("replication") or {}
    print("EXISTS yes")
    print("REPLICATION " + ("automatic" if "automatic" in rep else "user-managed" if "userManaged" in rep else "unknown"))
    print("CREATED " + str(d.get("createTime", "?")))


def versions(src):
    """VERSION <n> <state> <created> per version, then ENABLED <count> and LATEST-ENABLED <n|none>."""
    d = load(src)
    if not isinstance(d, list):
        print("VERSIONS unreadable" if d == "UNREADABLE" else "VERSIONS none")
        print("ENABLED 0")
        print("LATEST-ENABLED none")
        return
    enabled = []
    for v in sorted(d, key=lambda v: int(str(v.get("name", "0")).split("/")[-1] or 0)):
        n = str(v.get("name", "?")).split("/")[-1]
        st = v.get("state", "?")
        if st == "ENABLED":
            enabled.append(int(n))
        print("VERSION %s %s %s" % (n, st, v.get("createTime", "?")))
    print("ENABLED %d" % len(enabled))
    print("LATEST-ENABLED %s" % (max(enabled) if enabled else "none"))


def iam(src):
    d = load(src)
    if not isinstance(d, dict):
        print("POLICY unreadable" if d == "UNREADABLE" else "POLICY empty")
        return
    n = 0
    for b in d.get("bindings") or []:
        for m in b.get("members") or []:
            n += 1
            print("BINDING %s %s%s" % (b.get("role"), mask(m), " (conditional)" if b.get("condition") else ""))
    print("BINDINGS %d" % n)


def human_roles(src):
    """Project policy → per role: how many people (user/group/domain, never named) and service accounts."""
    d = load(src)
    if not isinstance(d, dict):
        print("PROJECT-POLICY unreadable")
        return
    for b in sorted(d.get("bindings") or [], key=lambda b: b.get("role", "")):
        ms = b.get("members") or []
        people = sum(1 for m in ms if USER_RE.match(m))
        sas = sum(1 for m in ms if m.startswith("serviceAccount:"))
        if people:
            print("ROLE %s people=%d serviceAccounts=%d%s" % (b.get("role"), people, sas,
                                                              " (conditional)" if b.get("condition") else ""))


def api_keys(src):
    """`gcloud services api-keys list` → display name and which restrictions are set (no key string is listed)."""
    d = load(src)
    if not isinstance(d, list):
        print("APIKEYS unreadable")
        return
    for k in d:
        r = k.get("restrictions") or {}
        app = [x.replace("KeyRestrictions", "") for x in ("androidKeyRestrictions", "browserKeyRestrictions",
                                                           "iosKeyRestrictions", "serverKeyRestrictions") if r.get(x)]
        apis = len(r.get("apiTargets") or [])
        print("APIKEY %s app=%s apis=%s" % (str(k.get("displayName") or "?").replace(" ", "_"),
                                            ",".join(app) or "NONE", apis or "NONE"))
    print("APIKEYS %d" % len(d))


def sa_keys(src, sa):
    """User-managed keys of one service account: key id prefix (8) and times only."""
    d = load(src)
    for k in d if isinstance(d, list) else []:
        print("SAKEY %s %s… created=%s expires=%s disabled=%s" % (
            sa, str(k.get("name", "?")).split("/")[-1][:8], k.get("validAfterTime", "?"),
            k.get("validBeforeTime", "?"), k.get("disabled", False)))


# ── Cloud Functions ──────────────────────────────────────────────────────────

def _fn_fields(d):
    sc = d.get("serviceConfig") or {}
    env = d.get("environmentVariables")
    if env is None:
        env = sc.get("environmentVariables") or {}
    sec = d.get("secretEnvironmentVariables")
    if sec is None:
        sec = sc.get("secretEnvironmentVariables") or []
    name = str(d.get("name", "?"))
    region = name.split("/locations/")[1].split("/")[0] if "/locations/" in name else "?"
    return {"name": name.split("/")[-1], "region": region, "status": d.get("status") or d.get("state") or "?",
            "updated": d.get("updateTime", "?"), "version": str(d.get("versionId", sc.get("revision", "?"))),
            "envvars": env if isinstance(env, dict) else {}, "secrets": sec if isinstance(sec, list) else []}


def _secrets_csv(f):
    return ",".join(sorted("%s:%s" % (s.get("key"), s.get("version", "?")) for s in f["secrets"])) or "none"


def parse_dotenv(path):
    """The subset of dotenv the Firebase CLI accepts. Values stay in memory; only hashes are compared."""
    out = {}
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            s = line.strip()
            if not s or s.startswith("#"):
                continue
            if s.startswith("export "):
                s = s[7:].lstrip()
            if "=" not in s:
                continue
            k, v = s.split("=", 1)
            k, v = k.strip(), v.strip()
            if len(v) >= 2 and v[0] == v[-1] and v[0] in "\"'":
                q, v = v[0], v[1:-1]
                if q == '"':
                    v = v.replace("\\n", "\n").replace('\\"', '"').replace("\\\\", "\\")
            elif " #" in v:
                v = v.split(" #", 1)[0].rstrip()
            out[k] = v
    return out


def fn_index(src):
    """`gcloud functions list --format=json` → IDX <name> <region> secrets=<KEY:VERSION,…> envnames=<NAME,…>."""
    d = load(src)
    if not isinstance(d, list):
        print("INDEX unreadable")
        return
    for x in sorted(d, key=lambda x: str(x.get("name"))):
        f = _fn_fields(x)
        names = sorted(k for k in f["envvars"] if k not in PLATFORM_ENV)
        print("IDX %s %s secrets=%s envnames=%s" % (f["name"], f["region"], _secrets_csv(f), ",".join(names) or "none"))


def fn_list(src):
    d = load(src)
    if not isinstance(d, list):
        print("LIST unreadable")
        return
    for x in sorted(d, key=lambda x: str(x.get("name"))):
        f = _fn_fields(x)
        print("%s\t%s\t%s" % (f["name"], f["updated"], f["status"]))


def fn_describe(src, expect_name, env_file=None):
    """FN line (names/versions only); with a dotenv: ENV <fn> <NAME> same|DIFFERENT|only-deployed|only-in-.env."""
    d = load(src)
    if not isinstance(d, dict):
        print("FN %s unreadable" % expect_name)
        return
    f = _fn_fields(d)
    user_env = sorted(k for k in f["envvars"] if k not in PLATFORM_ENV)
    print("FN %s status=%s version=%s updated=%s secrets=%s envnames=%d" % (
        f["name"], f["status"], f["version"], f["updated"], _secrets_csv(f), len(user_env)))
    if env_file:
        dot = parse_dotenv(env_file)
        for k in sorted(set(user_env) | set(dot)):
            if k in PLATFORM_ENV:
                continue
            if k not in dot:
                verdict = "only-deployed"
            elif k not in f["envvars"]:
                verdict = "only-in-.env"
            else:
                verdict = "same" if _hash(f["envvars"][k]) == _hash(dot[k]) else "DIFFERENT"
            print("ENV %s %s %s" % (f["name"], k, verdict))


def compare_lists(before, after, expected_csv):
    def read(p):
        out = {}
        for line in open(p, encoding="utf-8"):
            parts = line.rstrip("\n").split("\t")
            if len(parts) >= 2:
                out[parts[0]] = parts[1]
        return out
    b, a = read(before), read(after)
    expected = set(x for x in expected_csv.split(",") if x)
    changed = {n for n in set(a) | set(b) if a.get(n) != b.get(n)}
    for n in sorted(changed):
        print("CHANGED %s" % n)
    print("FUNCTIONS before=%d after=%d changed=%d" % (len(b), len(a), len(changed)))
    print("SCOPE " + ("PASS" if changed == expected and set(b) <= set(a) else "FAIL"))


# ── Cloud Run ────────────────────────────────────────────────────────────────

def _env_lines(container):
    out = []
    for e in sorted(container.get("env") or [], key=lambda e: e.get("name", "")):
        ref = (e.get("valueFrom") or {}).get("secretKeyRef")
        out.append("%s %s" % (e.get("name"), ("<- secret %s:%s" % (ref.get("name"), ref.get("key"))) if ref else "(plain)"))
    return out


def _split(rows):
    rows = [t for t in rows or [] if t.get("percent")]
    if any(t.get("latestRevision") for t in rows):
        return "LATEST-TARGET-PRESENT"
    return ",".join(sorted("%s=%s" % (t.get("revisionName"), t.get("percent")) for t in rows))


def run_service(src):
    d = load(src)
    if not isinstance(d, dict):
        print("SERVICE unreadable")
        return
    md, st, sp = d.get("metadata") or {}, d.get("status") or {}, d.get("spec") or {}
    print("SERVICE name=%s" % md.get("name", "?"))
    print("URL %s" % st.get("url", "?"))
    print("LATEST created=%s ready=%s" % (st.get("latestCreatedRevisionName", "?"), st.get("latestReadyRevisionName", "?")))
    print("TRAFFIC status %s" % _split(st.get("traffic")))
    print("TRAFFIC spec %s" % _split(sp.get("traffic")))
    tmpl = (sp.get("template") or {}).get("spec") or {}
    cont = (tmpl.get("containers") or [{}])[0]
    print("TEMPLATE sa=%s image=%s" % (tmpl.get("serviceAccountName", "?"), cont.get("image", "?")))
    for line in _env_lines(cont):
        print("ENV " + line)


def run_revision(src):
    d = load(src)
    if not isinstance(d, dict):
        print("REV unreadable")
        return
    md, st, sp = d.get("metadata") or {}, d.get("status") or {}, d.get("spec") or {}
    conds = {c.get("type"): c.get("status") for c in st.get("conditions") or []}
    cont = (sp.get("containers") or [{}])[0]
    print("REV name=%s ready=%s active=%s sa=%s" % (md.get("name", "?"), conds.get("Ready", "?"),
                                                   conds.get("Active", "?"), sp.get("serviceAccountName", "?")))
    print("IMAGE %s" % cont.get("image", "?"))
    for line in _env_lines(cont):
        print("ENV " + line)


def rev_refs(src, secret, *versions):
    """`gcloud run revisions list --format=json` → REF <revision> <env> for each revision mapping secret:<one of versions>."""
    d = load(src)
    n = 0
    for r in d if isinstance(d, list) else []:
        cont = ((r.get("spec") or {}).get("containers") or [{}])[0]
        for e in cont.get("env") or []:
            ref = (e.get("valueFrom") or {}).get("secretKeyRef") or {}
            if ref.get("name") == secret and str(ref.get("key")) in versions:
                n += 1
                print("REF %s %s" % ((r.get("metadata") or {}).get("name", "?"), e.get("name")))
    print("REFS %d" % n)


def traffic_split(part, src="-"):
    d = load(src)
    print(_split(((d or {}).get(part) or {}).get("traffic")) if isinstance(d, dict) else "unreadable")


def rev_cond(src="-"):
    d = load(src)
    c = {x.get("type"): x.get("status") for x in ((d or {}).get("status") or {}).get("conditions") or []} \
        if isinstance(d, dict) else {}
    print("ok" if c.get("Ready") == "True" and c.get("Active") == "True" else
          "Ready=%s Active=%s" % (c.get("Ready"), c.get("Active")))


# ── git tree hash (same algorithm as ../completion-20261101/rel_helpers.py tree-sha) ───────────────

def tree_sha(repo, commit, path):
    out = subprocess.run(["git", "-C", repo, "ls-tree", "-r", "-z", commit, "--", path],
                         capture_output=True, text=True, check=True).stdout
    entries = []
    for rec in out.split("\0"):
        if rec:
            meta, _, name = rec.partition("\t")
            mode, typ, oid = meta.split()
            if typ == "blob":
                entries.append((name, oid, mode))
    hashes = {}
    if entries:
        p = subprocess.run(["git", "-C", repo, "cat-file", "--batch"], input="".join(o + "\n" for _, o, _ in entries).encode(),
                           capture_output=True, check=True)
        data, pos = p.stdout, 0
        while pos < len(data):
            nl = data.index(b"\n", pos)
            oid, _typ, size = data[pos:nl].decode().split()
            body = data[nl + 1:nl + 1 + int(size)]
            hashes[oid] = hashlib.sha256(body).hexdigest()
            pos = nl + 1 + int(size) + 1
    h = hashlib.sha256()
    for name, digest in sorted((n, hashes[o] if m != "120000" else "symlink:" + hashes[o]) for n, o, m in entries):
        h.update(("%s  %s\n" % (digest, name)).encode("utf-8"))
    print("TREE %s %s %d" % (path, h.hexdigest(), len(entries)))


def age_days(stamp):
    """Whole days since a UTC stamp YYYYmmddTHHMMSSZ (as used in evidence folder names)."""
    t = datetime.datetime.strptime(stamp, "%Y%m%dT%H%M%SZ").replace(tzinfo=datetime.timezone.utc)
    print(int((datetime.datetime.now(datetime.timezone.utc) - t).total_seconds() // 86400))


if __name__ == "__main__":
    cmd, args = sys.argv[1], sys.argv[2:]
    {
        "secret-meta": secret_meta, "versions": versions, "iam": iam, "human-roles": human_roles,
        "api-keys": api_keys, "sa-keys": sa_keys, "fn-index": fn_index, "fn-list": fn_list,
        "fn-describe": fn_describe, "compare-lists": compare_lists, "run-service": run_service,
        "run-revision": run_revision, "rev-refs": rev_refs, "traffic-split": traffic_split, "rev-cond": rev_cond,
        "tree-sha": tree_sha, "age-days": age_days,
    }[cmd](*args)
