"""ZIPPER completion release 20261101 — read-only helpers for the production scripts in this folder.

Every subcommand reads JSON or text (from gcloud/firebase/git) on stdin or a file and prints ONLY metadata:
names, states, times, roles, service-account identities, hashes and same/different verdicts.
It never prints a secret value, an environment-variable value, a key, a token, or a person's address
(user:/group: members of IAM policies are masked; e-mail addresses are masked). Cloud Run revision and
Functions descriptions are piped in, never saved, because they carry environment-variable values.

Usage: python3 -I rel_helpers.py <subcommand> [args]   (see each function; python 3.8+)
"""
import hashlib
import json
import os
import re
import subprocess
import sys

USER_RE = re.compile(r"^(user|group|domain):.*$")
EMAIL_RE = re.compile(r"([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*@([A-Za-z0-9.-]+\.[A-Za-z]{2,})")
#: Set by the Firebase CLI / the platform, not by functions/.env.
PLATFORM_ENV = {"FIREBASE_CONFIG", "GCLOUD_PROJECT", "EVENTARC_CLOUD_EVENT_SOURCE", "LOG_EXECUTION_ID",
                "FUNCTION_SIGNATURE_TYPE", "FUNCTION_TARGET", "K_SERVICE", "K_REVISION", "PORT"}
#: Names functions/.env must not define (the SendGrid change owns them in code / Secret Manager).
RESERVED = ["ZIPPER_SENDGRID_API_KEY", "EMAIL_PROVIDER", "SENDGRID_FROM_EMAIL", "SENDGRID_FROM_NAME",
            "SENDGRID_REPLY_TO"]
#: File names that must never be part of a Cloud Run source upload.
FORBIDDEN_UPLOAD = re.compile(r"(^|/)(\.env($|\.)|serviceAccountKey|.*\.jks$|.*\.keystore$|.*\.pem$|.*\.p12$)")


def load(src):
    raw = sys.stdin.read() if src == "-" else open(src, encoding="utf-8").read()
    try:
        return json.loads(raw) if raw.strip() else None
    except ValueError:
        return "UNREADABLE"


def mask(member):
    return USER_RE.sub(lambda m: m.group(1) + ":<masked>", member)


def mask_text(s):
    """Every e-mail address in a string becomes x***@domain."""
    return EMAIL_RE.sub(lambda m: m.group(1) + "***@" + m.group(2), s or "")


def _hash(v):
    return hashlib.sha256(str(v).encode("utf-8")).hexdigest()


# ── Secret Manager / IAM ─────────────────────────────────────────────────────

def secret_meta(src):
    d = load(src)
    if not isinstance(d, dict):
        print("EXISTS no")
        return
    rep = d.get("replication") or {}
    if "automatic" in rep:
        r = "automatic"
    elif "userManaged" in rep:
        locs = sorted(x.get("location", "?") for x in (rep["userManaged"].get("replicas") or []))
        r = "user-managed:" + ",".join(locs)
    else:
        r = "unknown"
    labels = d.get("labels") or {}
    print("EXISTS yes")
    print("REPLICATION " + r)
    print("LABELS " + (",".join("%s=%s" % (k, v) for k, v in sorted(labels.items())) or "none"))
    print("CREATED " + str(d.get("createTime", "?")))


def versions(src):
    d = load(src)
    if not isinstance(d, list):
        print("VERSIONS unreadable" if d == "UNREADABLE" else "VERSIONS none")
        print("ENABLED 0")
        return
    enabled = 0
    for v in sorted(d, key=lambda v: int(str(v.get("name", "0")).split("/")[-1] or 0)):
        n = str(v.get("name", "?")).split("/")[-1]
        st = v.get("state", "?")
        enabled += st == "ENABLED"
        print("VERSION %s %s %s" % (n, st, v.get("createTime", "?")))
    print("ENABLED %d" % enabled)


def iam(src):
    d = load(src)
    if not isinstance(d, dict):
        print("POLICY unreadable" if d == "UNREADABLE" else "POLICY empty")
        return
    n = 0
    for b in d.get("bindings") or []:
        cond = " (conditional)" if b.get("condition") else ""
        for m in b.get("members") or []:
            n += 1
            print("BINDING %s %s%s" % (b.get("role"), mask(m), cond))
    print("BINDINGS %d" % n)


def project_sa_roles(src, *sas):
    """Project-level roles held by the given service accounts (other members not printed)."""
    d = load(src)
    if not isinstance(d, dict):
        print("PROJECT-POLICY unreadable")
        return
    for sa in sas:
        roles = sorted(b.get("role") for b in d.get("bindings") or []
                       if "serviceAccount:%s" % sa in (b.get("members") or []))
        print("PROJECT-ROLES %s %s" % (sa, ",".join(roles) or "none"))


# ── Cloud Functions ──────────────────────────────────────────────────────────

def _fn_fields(d):
    """Both shapes: the v1 API resource, and the v2-style one newer gcloud versions return."""
    sc = d.get("serviceConfig") or {}
    env = d.get("environmentVariables")
    if env is None:
        env = sc.get("environmentVariables") or {}
    sec = d.get("secretEnvironmentVariables")
    if sec is None:
        sec = sc.get("secretEnvironmentVariables") or []
    return {
        "name": str(d.get("name", "?")).split("/")[-1],
        "status": d.get("status") or d.get("state") or "?",
        "env": d.get("environment") or ("GEN_1" if "entryPoint" in d or "versionId" in d else "?"),
        "sa": d.get("serviceAccountEmail") or sc.get("serviceAccountEmail") or "?",
        "updated": d.get("updateTime", "?"),
        "version": str(d.get("versionId", sc.get("revision", "?"))),
        "runtime": d.get("runtime") or (d.get("buildConfig") or {}).get("runtime") or "?",
        "envvars": env if isinstance(env, dict) else {},
        "secrets": sec if isinstance(sec, list) else [],
    }


def parse_dotenv(path):
    """The subset of dotenv the Firebase CLI accepts: KEY=VALUE, quoted values, comments, `export`."""
    out = {}
    with open(path, encoding="utf-8") as f:
        for line in f:
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


def fn_describe(src, expect_name, env_file=None):
    d = load(src)
    if not isinstance(d, dict):
        print("FN %s unreadable" % expect_name)
        return
    f = _fn_fields(d)
    secrets = ",".join(sorted("%s:%s" % (s.get("key"), s.get("version", "?")) for s in f["secrets"])) or "none"
    user_env = sorted(k for k in f["envvars"] if k not in PLATFORM_ENV)
    print("FN %s status=%s gen=%s runtime=%s sa=%s updated=%s version=%s secrets=%s envnames=%s" % (
        f["name"], f["status"], f["env"], f["runtime"], f["sa"], f["updated"], f["version"], secrets,
        ",".join(user_env) or "none"))
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


def fn_list(src):
    d = load(src)
    if not isinstance(d, list):
        print("LIST unreadable")
        return
    for x in sorted(d, key=lambda x: str(x.get("name"))):
        f = _fn_fields(x)
        print("%s\t%s\t%s\t%s" % (f["name"], f["updated"], f["status"], f["env"]))


def env_names(path):
    dot = parse_dotenv(path)
    print("ENV-NAMES %d" % len(dot))
    for k in RESERVED:
        print("RESERVED %s %s" % (k, "PRESENT" if k in dot else "absent"))


def compare_lists(before, after, expected_csv):
    """Which functions changed (updateTime) between two fn-list files. A function that appears only after
    the deploy (new in this release) counts as changed; one that disappears is always unexpected.
    Every expected name is printed as UPDATED or NOT-UPDATED. SCOPE PASS: exactly the expected names changed;
    SCOPE PARTIAL: only expected names changed but not all of them (a deploy that stopped part-way);
    SCOPE FAIL: anything else changed or disappeared."""
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
        print("CHANGED %s %s -> %s" % (n, b.get(n, "-"), a.get(n, "-")))
    print("FUNCTIONS before=%d after=%d changed=%d" % (len(b), len(a), len(changed)))
    updated = expected & changed & set(a)
    for n in sorted(expected):
        print(("UPDATED %s" if n in updated else "NOT-UPDATED %s") % n)
    unexpected, gone = changed - expected, set(b) - set(a)
    for n in sorted(unexpected):
        print("CHANGED-BUT-NOT-EXPECTED %s" % n)
    for n in sorted(gone):
        print("DISAPPEARED %s" % n)
    print("WAVE updated=%d of %d" % (len(updated), len(expected)))
    if unexpected or gone:
        print("SCOPE FAIL")
    else:
        print("SCOPE " + ("PASS" if updated == expected else "PARTIAL"))


def fn_classify(exports_path, wave_2a, wave_2b, not_redeployed, region, default_region, default_region_names):
    """exports.txt (one `EXPORT name region` line per export of lib/index.js; other output of the module load is
    ignored) against the three lists: every exported name in exactly one list, every listed name exported, no name
    twice, and each function in the region the scripts describe it in (default_region for default_region_names, else
    region). Names and regions only."""
    lists = [("WAVE_2A", wave_2a.split()), ("WAVE_2B", wave_2b.split()), ("NOT_REDEPLOYED", not_redeployed.split())]
    exported = {}
    for line in open(exports_path, encoding="utf-8"):
        parts = line.split()
        if len(parts) >= 2 and parts[0] == "EXPORT":
            exported[parts[1]] = parts[2] if len(parts) > 2 else "?"
    where, problems = {}, 0
    for lst, names in lists:
        for n in names:
            where.setdefault(n, []).append(lst)
    print("EXPORTS %d (lib/index.js of the deploy tree)" % len(exported))
    print("LISTS %s (%d names)" % (" ".join("%s=%d" % (lst, len(names)) for lst, names in lists), len(where)))
    for n in sorted(where):
        if len(where[n]) > 1:
            problems += 1
            print("DUPLICATE %s in %s" % (n, ",".join(where[n])))
    for n in sorted(set(exported) - set(where)):
        problems += 1
        print("UNCLASSIFIED %s (exported, in no list)" % n)
    for n in sorted(set(where) - set(exported)):
        problems += 1
        print("NOT-EXPORTED %s (listed in %s)" % (n, ",".join(where[n])))
    dflt = set(default_region_names.split())
    for n in sorted(exported):
        want = default_region if n in dflt else region
        if exported[n] != want:
            problems += 1
            print("REGION %s code=%s scripts=%s" % (n, exported[n], want))
    print("CLASSIFY " + ("ok" if problems == 0 and exported else "FAIL"))


# ── Firestore indexes (33) ───────────────────────────────────────────────────

#: The automatic single-field indexes of a Firestore database (used if the live __default__ config is not listed).
AUTO_FIELD_INDEXES = {("COLLECTION", "ASCENDING", ""), ("COLLECTION", "DESCENDING", ""), ("COLLECTION", "", "CONTAINS")}


def _ix_fields(fields):
    """Composite-index fields as (path, order, arrayConfig, vector), with the trailing __name__ that Firestore always adds
    made explicit (direction of the last field; ASCENDING after a non-directional one): file and API then compare equal."""
    out = []
    for f in fields or []:
        vec = json.dumps(f.get("vectorConfig"), sort_keys=True) if f.get("vectorConfig") else ""
        out.append((str(f.get("fieldPath", "?")), f.get("order") or "", f.get("arrayConfig") or "", vec))
    if not out or out[-1][0] != "__name__":
        out.append(("__name__", out[-1][1] if out and out[-1][1] else "ASCENDING", "", ""))
    return tuple(out)


def _ix_parts(name):
    """…/collectionGroups/<C>/indexes/<id> or …/collectionGroups/<C>/fields/<F> -> (C, last segment)."""
    s = str(name or "")
    tail = s.split("/collectionGroups/", 1)[-1]
    return tail.split("/", 1)[0], tail.rsplit("/", 1)[-1]


def _fmt_ix(k):
    return "%s %s [%s]" % (k[0], k[1], ", ".join("%s %s" % (p, o or a or ("vector" if v else "?")) for p, o, a, v in k[2]))


def _fmt_cfg(c):
    return "%s %s" % (c[0], c[1] or c[2])


def _live_composite(src):
    """`gcloud firestore indexes composite list --format=json` -> {key: state}, or None if not a list."""
    d = load(src)
    if not isinstance(d, list):
        return None
    out = {}
    for x in d:
        out[(_ix_parts(x.get("name"))[0], x.get("queryScope") or "COLLECTION", _ix_fields(x.get("fields")))] = x.get("state", "?")
    return out


def _live_fields(src):
    """`gcloud firestore indexes fields list --format=json` -> (the __default__ configs {cfg: state} or None,
    {(collectionGroup, fieldPath): ({cfg: state}, ttl)} of the explicit overrides), or (None, None) if not a list."""
    d = load(src)
    if not isinstance(d, list):
        return None, None
    default, over = None, {}
    for x in d:
        cg, fp = _ix_parts(x.get("name"))
        ic = x.get("indexConfig") or {}
        cfgs = {}
        for ix in ic.get("indexes") or []:
            f = (ix.get("fields") or [{}])[0]
            cfgs[(ix.get("queryScope") or "COLLECTION", f.get("order") or "", f.get("arrayConfig") or "")] = ix.get("state", "?")
        ttl = bool(x.get("ttlConfig"))
        if cg == "__default__":
            default = cfgs
        elif not ic.get("usesAncestorConfig") or ttl:
            over[(cg, fp)] = (cfgs, ttl)
    return default, over


def _file_specs(spec):
    comp = [(str(i.get("collectionGroup", "?")), i.get("queryScope") or "COLLECTION", _ix_fields(i.get("fields")))
            for i in spec.get("indexes") or []]
    over = {}
    for o in spec.get("fieldOverrides") or []:
        cfgs = set((ix.get("queryScope") or "COLLECTION", ix.get("order") or "", ix.get("arrayConfig") or "")
                   for ix in o.get("indexes") or [])
        over[(str(o.get("collectionGroup", "?")), str(o.get("fieldPath", "?")))] = (cfgs, bool(o.get("ttl")))
    return comp, over


def indexes_check(spec_path, composite_src, fields_src):
    """Is firestore.indexes.json a SUPERSET of the live indexes? Every live composite index and every live field
    override must be in the file, and no field override of the file may drop a single-field index (or a TTL) that is
    live today — for a field without a live override, the automatic indexes of __default__. Prints what a deploy
    would create (TO-CREATE) and patch (TO-PATCH), and SUPERSET ok|FAIL. Index definitions only."""
    spec = load(spec_path)
    live_c = _live_composite(composite_src)
    default, live_o = _live_fields(fields_src)
    if not isinstance(spec, dict) or live_c is None or live_o is None:
        print("INDEXES unreadable (file %s, live composite %s, live fields %s)" % (
            "ok" if isinstance(spec, dict) else "unreadable", "ok" if live_c is not None else "unreadable",
            "ok" if live_o is not None else "unreadable"))
        print("SUPERSET FAIL")
        return
    file_c, file_o = _file_specs(spec)
    print("LIVE composite=%d field-overrides=%d   FILE composite=%d field-overrides=%d" % (
        len(live_c), len(live_o), len(set(file_c)), len(file_o)))
    problems = 0
    for k in sorted(set(live_c) - set(file_c)):
        problems += 1
        print("LIVE-NOT-IN-FILE index %s" % _fmt_ix(k))
    for k in sorted(set(live_o) - set(file_o)):
        problems += 1
        print("LIVE-NOT-IN-FILE field-override %s.%s" % k)
    auto = set(default) if default is not None else AUTO_FIELD_INDEXES
    patch = 0
    for k in sorted(file_o):
        fcfg, fttl = file_o[k]
        lcfg, lttl = (set(live_o[k][0]), live_o[k][1]) if k in live_o else (auto, False)
        for c in sorted(lcfg - fcfg):
            problems += 1
            print("WOULD-REMOVE field-override %s.%s %s%s" % (k[0], k[1], _fmt_cfg(c), "" if k in live_o else " (automatic index)"))
        if lttl and not fttl:
            problems += 1
            print("WOULD-REMOVE ttl %s.%s" % k)
        if k not in live_o or fcfg != lcfg or fttl != lttl:
            patch += 1
            print("TO-PATCH field-override %s.%s adds: %s%s" % (k[0], k[1], ", ".join(_fmt_cfg(c) for c in sorted(fcfg - lcfg)) or "-",
                                                             "; ttl: %s" % ("on" if fttl else "off") if fttl != lttl else ""))
    new = sorted(set(file_c) - set(live_c))
    for k in new:
        print("TO-CREATE index %s" % _fmt_ix(k))
    print("CHANGES %d (create %d composite, patch %d field overrides)" % (len(new) + patch, len(new), patch))
    print("SUPERSET " + ("ok" if problems == 0 else "FAIL"))


def indexes_ready(spec_path, composite_src, fields_src, before_composite="", before_fields=""):
    """Build state of every index of the file (composite indexes and each field-override index: READY, CREATING, …,
    ABSENT) and, given the lists read before the deploy, whether every index live then is live now (KEPT-ALL)."""
    spec = load(spec_path)
    live_c = _live_composite(composite_src)
    _, live_o = _live_fields(fields_src)
    if not isinstance(spec, dict) or live_c is None or live_o is None:
        print("INDEXES unreadable")
        print("INDEXES-READY no")
        return
    file_c, file_o = _file_specs(spec)
    total = ready = 0
    for k in sorted(set(file_c)):
        total += 1
        if live_c.get(k) == "READY":
            ready += 1
        else:
            print("BUILDING index %s state=%s" % (_fmt_ix(k), live_c.get(k, "ABSENT")))
    for k in sorted(file_o):
        now = (live_o.get(k) or ({}, False))[0]
        for c in sorted(file_o[k][0]):
            total += 1
            if now.get(c) == "READY":
                ready += 1
            else:
                print("BUILDING field-override %s.%s %s state=%s" % (k[0], k[1], _fmt_cfg(c), now.get(c, "ABSENT")))
    print("READY-COUNT %d of %d" % (ready, total))
    if before_composite:
        bc = _live_composite(before_composite) or {}
        _, bo = _live_fields(before_fields)
        gone = 0
        for k in sorted(set(bc) - set(live_c)):
            gone += 1
            print("GONE index %s" % _fmt_ix(k))
        for k in sorted(bo or {}):
            now_cfg, now_ttl = live_o.get(k) or ({}, False)
            for c in sorted(set(bo[k][0]) - set(now_cfg)):
                gone += 1
                print("GONE field-override %s.%s %s" % (k[0], k[1], _fmt_cfg(c)))
            if bo[k][1] and not now_ttl:
                gone += 1
                print("GONE ttl %s.%s" % k)
        print("KEPT-ALL " + ("yes" if gone == 0 else "no"))
    print("INDEXES-READY " + ("yes" if ready == total else "no"))


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
    """`gcloud run services describe --format=json` → names, split, tags, template identity, env NAMES."""
    d = load(src)
    if not isinstance(d, dict):
        print("SERVICE unreadable")
        return
    md, st, sp = d.get("metadata") or {}, d.get("status") or {}, d.get("spec") or {}
    print("SERVICE name=%s generation=%s observed=%s" % (md.get("name", "?"), md.get("generation", "?"),
                                                        st.get("observedGeneration", "?")))
    print("URL %s" % st.get("url", "?"))
    print("LATEST created=%s ready=%s" % (st.get("latestCreatedRevisionName", "?"), st.get("latestReadyRevisionName", "?")))
    print("TRAFFIC status %s" % _split(st.get("traffic")))
    print("TRAFFIC spec %s" % _split(sp.get("traffic")))
    tags = sorted("%s=%s" % (t.get("tag"), t.get("revisionName")) for t in sp.get("traffic") or [] if t.get("tag"))
    print("TAGS %s" % (",".join(tags) or "none"))
    for t in st.get("traffic") or []:
        if t.get("tag"):
            print("TAG-URL %s %s" % (t.get("tag"), t.get("url", "?")))
    tmpl = (sp.get("template") or {}).get("spec") or {}
    cont = (tmpl.get("containers") or [{}])[0]
    print("TEMPLATE sa=%s image=%s" % (tmpl.get("serviceAccountName", "?"), cont.get("image", "?")))
    ann = ((sp.get("template") or {}).get("metadata") or {}).get("annotations") or {}
    print("TEMPLATE-ANNOTATIONS %s" % (",".join(sorted(k for k in ann)) or "none"))
    for line in _env_lines(cont):
        print("ENV " + line)


def run_revision(src, *expect):
    """`gcloud run revisions describe --format=json` → identity, conditions, env NAMES, and for each
    NAME=VALUE argument a `VALUE NAME expected|DIFFERENT|absent` verdict (the value itself is never printed)."""
    d = load(src)
    if not isinstance(d, dict):
        print("REV unreadable")
        return
    md, st, sp = d.get("metadata") or {}, d.get("status") or {}, d.get("spec") or {}
    conds = {c.get("type"): c.get("status") for c in st.get("conditions") or []}
    cont = (sp.get("containers") or [{}])[0]
    print("REV name=%s created=%s digest=%s ready=%s active=%s resources=%s healthy=%s sa=%s" % (
        md.get("name", "?"), md.get("creationTimestamp", "?"), str(st.get("imageDigest", "?")).split("@")[-1],
        conds.get("Ready", "?"), conds.get("Active", "?"), conds.get("ResourcesAvailable", "?"),
        conds.get("ContainerHealthy", "?"), sp.get("serviceAccountName", "?")))
    print("IMAGE %s" % cont.get("image", "?"))
    for line in _env_lines(cont):
        print("ENV " + line)
    values = {e.get("name"): e.get("value") for e in cont.get("env") or [] if "value" in e}
    for pair in expect:
        name, _, want = pair.partition("=")
        if name not in values:
            print("VALUE %s absent" % name)
        else:
            print("VALUE %s %s" % (name, "expected" if _hash(values[name]) == _hash(want) else "DIFFERENT"))


def env_diff(file_a, file_b):
    """ENV lines of two run-service/run-revision outputs: lines only in A (-) and only in B (+)."""
    def lines(p):
        return set(l.rstrip("\n") for l in open(p, encoding="utf-8") if l.startswith("ENV "))
    a, b = lines(file_a), lines(file_b)
    for l in sorted(a - b):
        print("- " + l)
    for l in sorted(b - a):
        print("+ " + l)
    print("DIFF %d" % (len(a - b) + len(b - a)))


def traffic_split(part, src="-"):
    d = load(src)
    if not isinstance(d, dict):
        print("unreadable")
        return
    print(_split((d.get(part) or {}).get("traffic")))


def rev_cond(src="-"):
    d = load(src)
    if not isinstance(d, dict):
        print("unreadable")
        return
    c = {x.get("type"): x.get("status") for x in (d.get("status") or {}).get("conditions") or []}
    print("ok" if c.get("Active") == "True" and c.get("ResourcesAvailable") == "True" and c.get("Ready") == "True"
          else "Ready=%s Active=%s ResourcesAvailable=%s" % (c.get("Ready"), c.get("Active"), c.get("ResourcesAvailable")))


def hosting_live(src="-"):
    """`firebase hosting:channel:list --json` → the live channel's version id and release time only."""
    d = load(src)
    if not isinstance(d, dict):
        print("HOSTING-LIVE unreadable")
        return
    chans = (d.get("result") or {}).get("channels") or []
    for c in chans:
        name = str(c.get("name", ""))
        if name.endswith("/channels/live"):
            rel = c.get("release") or {}
            ver = str((rel.get("version") or {}).get("name", "?")).split("/")[-1]
            site = name.split("/sites/")[-1].split("/")[0]
            print("HOSTING-LIVE site=%s version=%s released=%s" % (site, ver, rel.get("releaseTime", "?")))
            return
    print("HOSTING-LIVE site=? version=none released=?")


# ── git trees and RELEASE.txt ────────────────────────────────────────────────

def _git(repo, *args):
    return subprocess.run(["git", "-C", repo, *args], capture_output=True, text=True, check=True).stdout


def tree_entries(repo, commit, path):
    """[(path, sha256 of blob content)] for every file under `path` at `commit` (read-only git)."""
    out = _git(repo, "ls-tree", "-r", "-z", commit, "--", path)
    entries = []
    for rec in out.split("\0"):
        if not rec:
            continue
        meta, _, name = rec.partition("\t")
        mode, typ, oid = meta.split()
        if typ == "blob":
            entries.append((name, oid, mode))
    if not entries:
        return []
    p = subprocess.run(["git", "-C", repo, "cat-file", "--batch"], input="".join(o + "\n" for _, o, _ in entries).encode(),
                       capture_output=True, check=True)
    data, pos, hashes = p.stdout, 0, {}
    while pos < len(data):
        nl = data.index(b"\n", pos)
        header = data[pos:nl].decode()
        oid, _typ, size = header.split()
        size = int(size)
        body = data[nl + 1:nl + 1 + size]
        hashes[oid] = hashlib.sha256(body).hexdigest()
        pos = nl + 1 + size + 1
    return [(name, hashes[oid] if mode != "120000" else "symlink:" + hashes[oid]) for name, oid, mode in entries]


def tree_sha(repo, commit, path):
    entries = tree_entries(repo, commit, path)
    h = hashlib.sha256()
    for name, digest in sorted(entries):
        h.update(("%s  %s\n" % (digest, name)).encode("utf-8"))
    print("TREE %s %s %d" % (path, h.hexdigest(), len(entries)))


def tree_list(repo, commit, path):
    for name, digest in sorted(tree_entries(repo, commit, path)):
        print("%s  %s" % (digest, name))


def file_sha(repo, commit, path):
    entries = tree_entries(repo, commit, path)
    if len(entries) != 1:
        print("FILE %s missing" % path)
        return
    print("FILE %s %s" % (path, entries[0][1]))


#: What RELEASE.txt records (make-release-txt.sh). `functions` is the whole folder as committed (20/21 compare the
#: unpacked deploy tree with it); `functions/src` is listed on its own for review. Build output and dependencies are
#: never part of a tree hash, even if someone committed them.
RELEASE_TREES = ["backend", "functions", "functions/src", "zipper-crm"]
RELEASE_FILES = ["firestore.rules", "storage.rules", "firestore.indexes.json", "zipper-app/app/build.gradle.kts",
                 "firebase.json", ".firebaserc", "deploy-crm.command"]
RELEASE_EXCLUDE = re.compile(r"(^|/)(node_modules|\.next)/|^zipper-crm/out/")


def release_entries(repo, commit, path):
    return [(n, d) for n, d in tree_entries(repo, commit, path) if not RELEASE_EXCLUDE.search(n)]


def _digest(entries):
    h = hashlib.sha256()
    for name, digest in sorted(entries):
        h.update(("%s  %s\n" % (digest, name)).encode("utf-8"))
    return h.hexdigest()


def release_txt(repo, commit, base, base_ref=""):
    """The RELEASE.txt text for `commit` (HEAD) with BASE_COMMIT `base` (both resolved to full ids) and, for the record,
    the full ref BASE_COMMIT was resolved from (`none` for an explicit commit id that is not the production branch)."""
    head = _git(repo, "rev-parse", "--verify", commit + "^{commit}").strip()
    base_full = _git(repo, "rev-parse", "--verify", base + "^{commit}").strip()
    print("# ZIPPER completion release 20261101 - written by make-release-txt.sh; require_release recomputes every line")
    print("HEAD=%s" % head)
    print("BASE_COMMIT=%s" % base_full)
    if base_ref:
        print("BASE_REF=%s" % base_ref)
    for p in RELEASE_TREES:
        e = release_entries(repo, head, p)
        if not e:
            raise SystemExit("RELEASE-TXT refused: no committed file under %s" % p)
        print("TREE %s %s %d" % (p, _digest(e), len(e)))
    for p in RELEASE_FILES:
        e = tree_entries(repo, head, p)
        if len(e) != 1 or e[0][0] != p:
            raise SystemExit("RELEASE-TXT refused: %s is not a committed file" % p)
        print("FILE %s %s" % (p, e[0][1]))


def release_check(release_txt, repo):
    """Recompute every TREE/FILE line of RELEASE.txt at the current HEAD; verify HEAD and BASE_COMMIT exist."""
    head = _git(repo, "rev-parse", "HEAD").strip()
    want = ""
    base = ""
    problems = 0
    seen = set()
    for line in open(release_txt, encoding="utf-8"):
        line = line.rstrip("\n")
        if line.startswith(("TREE ", "FILE ")):
            seen.add(line.split()[1])
        if line.startswith("HEAD="):
            want = line[5:]
        elif line.startswith("BASE_COMMIT="):
            base = line[12:]
        elif line.startswith("TREE "):
            _, path, sha, n = line.split()
            entries = release_entries(repo, "HEAD", path)
            ok = _digest(entries) == sha and len(entries) == int(n)
            problems += not ok
            print("TREE %s %s" % (path, "ok" if ok else "MISMATCH"))
        elif line.startswith("FILE "):
            _, path, sha = line.split()
            entries = tree_entries(repo, "HEAD", path)
            ok = len(entries) == 1 and entries[0][0] == path and entries[0][1] == sha
            problems += not ok
            print("FILE %s %s" % (path, "ok" if ok else "MISMATCH"))
    for p in RELEASE_TREES + RELEASE_FILES:
        if p not in seen:
            problems += 1
            print("MISSING-LINE %s (regenerate RELEASE.txt with make-release-txt.sh)" % p)
    ok_head = bool(want) and head == want
    problems += not ok_head
    print("HEAD %s %s" % (head[:12], "ok" if ok_head else "MISMATCH (RELEASE.txt has %s)" % (want[:12] or "nothing")))
    if base:
        try:
            _git(repo, "cat-file", "-e", base + "^{commit}")
            print("BASE_COMMIT %s ok" % base[:12])
        except subprocess.CalledProcessError:
            problems += 1
            print("BASE_COMMIT %s MISSING" % base[:12])
    else:
        problems += 1
        print("BASE_COMMIT absent")
    print("RELEASE " + ("ok" if problems == 0 else "MISMATCH"))


def upload_check(upload_list, tracked_list):
    """Every file gcloud would upload must be in the committed tree (list of `sha  path` lines) and
    carry no forbidden name."""
    tracked = {}
    for line in open(tracked_list, encoding="utf-8"):
        line = line.rstrip("\n")
        if "  " in line:
            sha, name = line.split("  ", 1)
            tracked[name] = sha
    n, bad, forb = 0, [], []
    for line in open(upload_list, encoding="utf-8"):
        f = line.strip()
        if not f:
            continue
        n += 1
        if f not in tracked:
            bad.append(f)
        if FORBIDDEN_UPLOAD.search(f):
            forb.append(f)
    for f in bad[:20]:
        print("NOT-COMMITTED %s" % f)
    for f in forb[:20]:
        print("FORBIDDEN %s" % f)
    print("UPLOAD files=%d not-committed=%d forbidden=%d %s" % (n, len(bad), len(forb), "ok" if not bad and not forb else "FAIL"))


# ── Android / APK ────────────────────────────────────────────────────────────

def apk_badging(aapt_out, expect_code, expect_name):
    txt = open(aapt_out, encoding="utf-8", errors="replace").read()
    code = re.search(r"versionCode='(\d+)'", txt)
    name = re.search(r"versionName='([^']*)'", txt)
    pkg = re.search(r"package: name='([^']*)'", txt)
    dbg = "application-debuggable" in txt
    print("APK package=%s versionCode=%s versionName=%s debuggable=%s" % (
        pkg.group(1) if pkg else "?", code.group(1) if code else "?", name.group(1) if name else "?", "yes" if dbg else "no"))
    ok = code is not None and code.group(1) == str(expect_code) and name is not None and name.group(1) == expect_name \
        and not dbg and pkg is not None and pkg.group(1) == "com.zipper.app"
    print("APK-CHECK " + ("ok" if ok else "FAIL"))


CERT_LINE_RE = re.compile(r"^APK \S+ SCHEMES (\S+) CERTS (\d+) SHA256 (\S+) CN (.*)$")


def apk_cert_check(cert_out, apksigner_rc, fleet_sha256):
    """Who signed ONE APK, decided without apksigner's text output (under build-tools 37.0.0 no pattern found a signer
    in it): the line of tools/apk_cert.py (the certificates in the APK Signing Block) and the exit code of `apksigner
    verify` (signature validity). ok = apksigner exit 0, exactly one distinct certificate, CN=Android Debug, SHA-256 =
    fleet_sha256 (FLEET_CERT_SHA256 of rel_common.sh, the key that signed APK 19). Public certificate data only."""
    lines = [l.rstrip("\n") for l in open(cert_out, encoding="utf-8", errors="replace") if l.startswith("APK ")]
    m = CERT_LINE_RE.match(lines[0]) if len(lines) == 1 else None
    fleet = str(fleet_sha256).strip().lower()
    problems = []
    if not re.fullmatch(r"[0-9a-f]{64}", fleet):
        problems.append("FLEET_CERT_SHA256 in rel_common.sh is not a SHA-256")
    if str(apksigner_rc) != "0":
        problems.append("apksigner verify exit %s (the signature does not verify, or apksigner could not run: Java on PATH?)"
                        % apksigner_rc)
    if m is None:
        problems.append("no signing certificate read (tools/apk_cert.py: %s)" % (" / ".join(lines)[:300] or "no output"))
    else:
        schemes, n, sha, cn = m.group(1), int(m.group(2)), m.group(3).lower(), m.group(4)
        print("SIGNER schemes=%s certificates=%d sha256=%s CN=%s" % (schemes, n, sha, cn))
        if n != 1:
            problems.append("%d distinct signing certificates (exactly 1 expected)" % n)
        if cn != "Android Debug":
            problems.append("CN=%s, not Android Debug" % cn)
        if sha != fleet:
            problems.append("certificate SHA-256 %s is not the fleet's %s" % (sha, fleet))
    print("SIGNER-CHECK " + ("ok" if not problems else "FAIL: " + "; ".join(problems)))


def android_doc_check(doc_json, channel, min_code):
    """appConfig/androidUpdate (as saved by tools/android_update_doc.py): published code of a channel."""
    d = load(doc_json)
    ch = (d or {}).get(channel) if isinstance(d, dict) else None
    if not isinstance(ch, dict):
        print("ANDROID %s absent" % channel)
        print("ANDROID-CHECK FAIL")
        return
    code = int(ch.get("versionCode") or 0)
    mins = int(ch.get("minSupportedVersionCode") or 0)
    print("ANDROID %s versionCode=%s versionName=%s minSupportedVersionCode=%s mandatory=%s publishedAt=%s abis=%s" % (
        channel, code, ch.get("versionName", "?"), mins, ch.get("mandatory", "?"), ch.get("publishedAt", "?"),
        ",".join(sorted((ch.get("abis") or {}).keys())) or "none"))
    print("ANDROID-CHECK " + ("ok" if code >= int(min_code) and mins >= int(min_code) else "FAIL"))


# ── Canary monitor aggregation (counts only) ─────────────────────────────────

def agg_requests(new, base, src="-"):
    from urllib.parse import urlsplit
    rows = load(src)
    if not isinstance(rows, list):
        print(json.dumps({"error": "not readable"}))
        return
    agg = {r: {"n": 0, "x5": 0, "auth": 0, "auth4": 0, "lat": []} for r in (new, base)}
    for r in rows:
        rev = ((r.get("resource") or {}).get("labels") or {}).get("revision_name")
        if rev not in agg:
            continue
        h = r.get("httpRequest") or {}
        s = int(h.get("status") or 0)
        a = agg[rev]
        a["n"] += 1
        a["x5"] += s >= 500
        if urlsplit(h.get("requestUrl") or "").path in ("/api/auth/signin", "/api/auth/refresh"):
            a["auth"] += 1
            a["auth4"] += 400 <= s < 500
        try:
            a["lat"].append(float(str(h.get("latency") or "").rstrip("s")))
        except ValueError:
            pass
    print(json.dumps({"rows": len(rows), "agg": agg}))


MODULE_RE = re.compile(r"owner_mfa|app\.core\.deps|core/deps\.py|app\.services\.staff|services/staff\.py|"
                       r"app\.services\.money|services/money\.py|app\.services\.email|services/email\.py|observer")


def agg_errors(new, base, src="-"):
    rows = load(src)
    if not isinstance(rows, list):
        print(json.dumps({"error": "not readable"}))
        return
    agg = {r: {"err": 0, "err_mod": 0} for r in (new, base)}
    for e in rows:
        rev = ((e.get("resource") or {}).get("labels") or {}).get("revision_name")
        if rev in agg:
            agg[rev]["err"] += 1
            text = (e.get("textPayload") or "") + " " + str((e.get("jsonPayload") or {}).get("message") or "")
            agg[rev]["err_mod"] += bool(MODULE_RE.search(text))
    print(json.dumps({"rows": len(rows), "agg": agg}))


def monitor_verdict(new, base, req_path, err_path):
    env = lambda k, d: float(os.environ.get(k, d))
    MIN_REQ, RATE_X, MIN_5XX = env("MIN_REQ", 200), env("RATE_X", 2.0), env("MIN_5XX", 3)
    AUTH_X, AUTH_MIN, LAT_X = env("AUTH_X", 2.0), env("AUTH_MIN", 5), env("LAT_X", 1.5)
    req, err = json.load(open(req_path)), json.load(open(err_path))
    if "error" in req or "error" in err:
        print("   logs not readable — RESULT: WAIT (re-run)")
        return

    def p95(l):
        l = sorted(l)
        return l[int(0.95 * (len(l) - 1))] if l else None
    rate = lambda x, n: x / n if n else 0.0
    for rev in (new, base):
        a, e = req["agg"][rev], err["agg"][rev]
        print("   %-24s %s requests %6d | 5xx %4d (%.2f%%) | signin/refresh %5d, 4xx %4d | p95 %s | ERROR %d (watched modules %d)" % (
            rev, "NEW " if rev == new else "BASE", a["n"], a["x5"], 100 * rate(a["x5"], a["n"]), a["auth"], a["auth4"],
            ("%.3fs" % p95(a["lat"])) if a["lat"] else "n/a", e["err"], e["err_mod"]))
    N, B, NE = req["agg"][new], req["agg"][base], err["agg"][new]
    stops = []
    if NE["err_mod"]:
        stops.append("ERROR entries from watched modules on NEW: %d" % NE["err_mod"])
    if N["n"] >= MIN_REQ and N["x5"] >= MIN_5XX and rate(N["x5"], N["n"]) > RATE_X * max(rate(B["x5"], B["n"]), 1e-9):
        stops.append("5xx rate on NEW %.2f%% > %.1fx BASE %.2f%%" % (100 * rate(N["x5"], N["n"]), RATE_X, 100 * rate(B["x5"], B["n"])))
    if N["auth4"] >= AUTH_MIN and rate(N["auth4"], N["auth"]) > AUTH_X * max(rate(B["auth4"], B["auth"]), 1e-9):
        stops.append("signin/refresh 4xx rate on NEW %.1f%% > %.1fx BASE %.1f%%" % (100 * rate(N["auth4"], N["auth"]), AUTH_X, 100 * rate(B["auth4"], B["auth"])))
    pn, pb = p95(N["lat"]), p95(B["lat"])
    if pn is not None and pb and len(N["lat"]) >= 50 and len(B["lat"]) >= 50 and pn > LAT_X * pb:
        stops.append("p95 latency on NEW %.3fs > %.1fx BASE %.3fs" % (pn, LAT_X, pb))
    partial = []
    if req["rows"] >= 50000:
        print("   NOTE: request-log limit reached; counts are a lower bound")
        partial.append("request")
    if err.get("rows", 0) >= 5000:
        print("   NOTE: error-log limit reached; older ERROR entries were not read")
        partial.append("error")
    if stops:
        print("RESULT: STOP — " + "; ".join(stops) + ". Pin traffic back (19-rollback-backend.command) and review.")
    elif N["n"] < MIN_REQ:
        print("RESULT: WAIT — only %d requests on NEW (need %d before a rate is judged). No stop condition so far." % (N["n"], MIN_REQ))
    elif partial:
        print("RESULT: WAIT — the %s log read hit its limit, so part of the window was not checked. Use a shorter window." % " and ".join(partial))
    else:
        print("RESULT: CONTINUE — no stop condition met over %d requests on NEW." % N["n"])


# ── Monitoring policies (70) ─────────────────────────────────────────────────

def policy_json(kind, channel_name, check_id=""):
    common = {"combiner": "OR", "enabled": True, "notificationChannels": [channel_name],
              "alertStrategy": {"notificationRateLimit": {"period": "300s"}, "autoClose": "1800s"}}
    if kind == "backend-5xx":
        pol = dict(common, displayName="ZIPPER backend 5xx (log)", conditions=[{
            "displayName": "zipper-api answered 5xx",
            "conditionMatchedLog": {"filter": 'resource.type="cloud_run_revision" AND resource.labels.service_name="zipper-api" AND httpRequest.status>=500'}}])
    elif kind == "functions-errors":
        pol = dict(common, displayName="ZIPPER functions errors (log)", conditions=[{
            "displayName": "a Cloud Function logged ERROR",
            "conditionMatchedLog": {"filter": '(resource.type="cloud_function" OR (resource.type="cloud_run_revision" AND resource.labels.service_name!="zipper-api")) AND severity>=ERROR'}}])
    elif kind == "uptime":
        pol = {"combiner": "OR", "enabled": True, "notificationChannels": [channel_name],
               "displayName": "ZIPPER api health uptime failed",
               "conditions": [{"displayName": "uptime check zipper-api-health failed",
                               "conditionThreshold": {
                                   "filter": 'metric.type="monitoring.googleapis.com/uptime_check/check_passed" AND resource.type="uptime_url" AND metric.labels.check_id="%s"' % check_id,
                                   "aggregations": [{"alignmentPeriod": "300s", "perSeriesAligner": "ALIGN_NEXT_OLDER",
                                                     "crossSeriesReducer": "REDUCE_COUNT_FALSE", "groupByFields": ["resource.label.*"]}],
                                   "comparison": "COMPARISON_GT", "thresholdValue": 1, "duration": "300s",
                                   "trigger": {"count": 1}}}]}
    else:
        raise SystemExit("unknown policy kind")
    print(json.dumps(pol, indent=1))


def first_name(src="-"):
    """The `name` of the first object in a JSON list (or of a single object)."""
    d = load(src)
    if isinstance(d, list):
        d = d[0] if d else None
    print(str((d or {}).get("name", "")) if isinstance(d, dict) else "")


def mask_file(path):
    for line in open(path, encoding="utf-8", errors="replace"):
        sys.stdout.write(mask_text(line))


def android_doc_equal(a_json, b_json, channel):
    """Is the <channel> map of two saved androidUpdate documents identical? Prints differing KEY names only."""
    a, b = load(a_json), load(b_json)
    ca = (a or {}).get(channel) if isinstance(a, dict) else None
    cb = (b or {}).get(channel) if isinstance(b, dict) else None
    if ca == cb:
        print("EQUAL yes")
        return
    ca, cb = ca if isinstance(ca, dict) else {}, cb if isinstance(cb, dict) else {}
    for k in sorted(set(ca) | set(cb)):
        if ca.get(k) != cb.get(k):
            print("DIFFERS %s" % k)
    print("EQUAL no")


def android_doc_abis(doc_json, channel):
    d = load(doc_json)
    ch = (d or {}).get(channel) if isinstance(d, dict) else None
    for abi, e in sorted(((ch or {}).get("abis") or {}).items()):
        print("ABI %s sha256=%s size=%s" % (abi, (e or {}).get("sha256", "?"), (e or {}).get("sizeBytes", "?")))


def mtime_after(path, epoch):
    print("yes" if os.path.getmtime(path) > int(epoch) else "no")


def _rows(src):
    d = load(src)
    return d if isinstance(d, list) else []


def mon_channels(src="-"):
    """Notification channels, TAB-separated: CHANNEL name type displayName enabled masked-address."""
    for c in _rows(src):
        print("CHANNEL\t%s\t%s\t%s\t%s\t%s" % (c.get("name", "?"), c.get("type", "?"), c.get("displayName", ""),
                                               c.get("enabled", True), mask_text((c.get("labels") or {}).get("email_address", "-"))))


def mon_uptime(src="-"):
    """Uptime checks, TAB-separated: UPTIME name displayName host path period."""
    for u in _rows(src):
        lab = (u.get("monitoredResource") or {}).get("labels") or {}
        print("UPTIME\t%s\t%s\t%s\t%s\t%s" % (u.get("name", "?"), u.get("displayName", ""), lab.get("host", "?"),
                                              (u.get("httpCheck") or {}).get("path", "?"), u.get("period", "?")))


def mon_policies(src="-"):
    """Alert policies, TAB-separated: POLICY name displayName enabled channels(csv)."""
    for p in _rows(src):
        print("POLICY\t%s\t%s\t%s\t%s" % (p.get("name", "?"), p.get("displayName", ""), p.get("enabled", True),
                                          ",".join(p.get("notificationChannels") or []) or "none"))


if __name__ == "__main__":
    cmd, args = sys.argv[1], sys.argv[2:]
    {
        "secret-meta": secret_meta, "versions": versions, "iam": iam, "project-sa-roles": project_sa_roles,
        "fn-describe": fn_describe, "fn-list": fn_list, "env-names": env_names, "compare-lists": compare_lists,
        "fn-classify": fn_classify, "indexes-check": indexes_check, "indexes-ready": indexes_ready,
        "run-service": run_service, "run-revision": run_revision, "env-diff": env_diff, "traffic-split": traffic_split,
        "rev-cond": rev_cond, "hosting-live": hosting_live, "tree-sha": tree_sha, "tree-list": tree_list,
        "file-sha": file_sha, "release-check": release_check, "upload-check": upload_check,
        "apk-badging": apk_badging, "apk-cert-check": apk_cert_check, "android-doc-check": android_doc_check,
        "agg-requests": agg_requests, "agg-errors": agg_errors, "monitor-verdict": monitor_verdict,
        "policy-json": policy_json, "first-name": first_name, "mask-file": mask_file,
        "release-txt": release_txt, "android-doc-equal": android_doc_equal, "android-doc-abis": android_doc_abis,
        "mtime-after": mtime_after, "mon-channels": mon_channels, "mon-uptime": mon_uptime, "mon-policies": mon_policies,
    }[cmd](*args)
