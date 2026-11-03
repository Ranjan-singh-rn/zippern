"""ZIPPER Track B release — check rel_common.sh's Functions lists against the source. LOCAL ONLY, read-only.

    python3 -I release/trackb-20261104/tools/check-function-lists.py [exports.txt]

Run it after ANY change under functions/src (before committing / make-release-txt.sh). It answers:
  * which functions functions/src/index.ts exports (or, better, the `EXPORT name region` lines of a built lib/index.js
    enumerated the way check_exports does, if you pass that file);
  * for each one, whether a file of its module import closure differs between the tree production runs and the
    working tree — LIVE_FN_COMMIT (cf64145) for the completion wave 2a names, BASE (prod-live-20261030) for the
    completion wave 2b names and onHostInvitationWithdrawn; index.ts counts for the functions defined in it;
  * and compares that with WAVE_2A_CHANGED / WAVE_2A_NEW / WAVE_2B / NOT_REDEPLOYED / FN_BASE_LIVE / FN_BASE_PROD.
Exit 1 (and DANGER lines) when a NOT_REDEPLOYED function's code changed (it would silently keep old code), when an
export is in no list, or when a listed name is not exported. A changed-list name whose code did not change is only a
NOTE (redeploying identical code is harmless). Wave B membership is a judgement (client compatibility) — this tool
does not decide it; it only prints which wave-B names changed.
Reads git and the source; writes nothing; contacts nothing.
"""
import os
import re
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REL = os.path.dirname(HERE)
REPO = os.path.dirname(os.path.dirname(REL))
SRC = "functions/src"


def git(*args):
    return subprocess.run(["git", "-C", REPO, *args], capture_output=True, text=True, check=True).stdout


def lists():
    out = subprocess.run(["/bin/bash", "-c", '. ./rel_common.sh >/dev/null 2>&1; for v in WAVE_2A_CHANGED WAVE_2A_NEW '
                          'WAVE_2B NOT_REDEPLOYED FN_BASE_LIVE FN_BASE_PROD LIVE_FN_COMMIT PROD_FN_COMMIT; do '
                          'eval "printf \'%s=%s\\n\' $v \\"\\$$v\\""; done'],
                         cwd=REL, capture_output=True, text=True, env={"PATH": "/usr/bin:/bin", "HOME": "/nonexistent"}).stdout
    return {k: v.split() for k, v in (l.split("=", 1) for l in out.splitlines() if "=" in l)}


IMP = re.compile(r"""(?:import|export)\s+(?:[^'";]*?\s+from\s+)?['"](\.[^'"]+)['"]|require\(\s*['"](\.[^'"]+)['"]\s*\)""", re.S)


def work_files():
    out = []
    for root, _, fs in os.walk(os.path.join(REPO, SRC)):
        for f in fs:
            if f.endswith(".ts"):
                out.append(os.path.relpath(os.path.join(root, f), REPO))
    return set(out)


def graph(files):
    g = {}
    for f in files:
        text = open(os.path.join(REPO, f), encoding="utf-8").read()
        d = os.path.dirname(f)
        deps = set()
        for m in IMP.finditer(text):
            p = os.path.normpath(os.path.join(d, m.group(1) or m.group(2)))
            for cand in (p + ".ts", os.path.join(p, "index.ts")):
                if cand in files:
                    deps.add(cand)
        g[f] = deps
    return g


def closure(g, start):
    seen, st = set(), [start]
    while st:
        x = st.pop()
        if x in seen:
            continue
        seen.add(x)
        st.extend(g.get(x, ()))
    return seen


def export_map():
    idx = open(os.path.join(REPO, SRC, "index.ts"), encoding="utf-8").read()
    emap = {}
    for m in re.finditer(r"export\s*\{([^}]*)\}\s*from\s*['\"](\.[^'\"]+)['\"]", idx, re.S):
        body = re.sub(r"//[^\n]*", "", m.group(1))
        body = re.sub(r"/\*.*?\*/", "", body, flags=re.S)
        mod = os.path.normpath(os.path.join(SRC, m.group(2))) + ".ts"
        for n in body.split(","):
            n = n.strip().split(" as ")[-1].strip()
            if n:
                emap[n] = mod
    for m in re.finditer(r"^export const (\w+)", idx, re.M):
        emap.setdefault(m.group(1), SRC + "/index.ts")
    return emap


def changed_since(base):
    diff = set(git("diff", "--name-only", base, "--", SRC).split())
    untracked = set(git("ls-files", "--others", "--exclude-standard", "--", SRC).split())
    return diff | untracked


def main():
    L = lists()
    emap = export_map()
    if len(sys.argv) > 1:
        exports = [l.split()[1] for l in open(sys.argv[1], encoding="utf-8") if l.startswith("EXPORT ")]
        src = "lib/index.js enumeration (%s)" % sys.argv[1]
    else:
        exports = sorted(emap)
        src = "functions/src/index.ts (parsed; pass a built exports.txt for the exact list)"
    g = graph(work_files())
    ch_live, ch_prod = changed_since(L["LIVE_FN_COMMIT"][0]), changed_since(L["PROD_FN_COMMIT"][0])
    on_prod = set(L["FN_BASE_PROD"]) | {"onHostInvitationWithdrawn"}
    listed = {}
    for k in ("WAVE_2A_CHANGED", "WAVE_2A_NEW", "WAVE_2B", "NOT_REDEPLOYED"):
        for n in L[k]:
            listed.setdefault(n, []).append(k)
    danger = 0
    print("exports: %d from %s" % (len(exports), src))
    for n in sorted(set(exports) - set(listed)):
        danger += 1
        print("DANGER %s is exported but in no list (20/21 would refuse; classify it)" % n)
    for n in sorted(set(listed) - set(exports)):
        danger += 1
        print("DANGER %s is listed (%s) but not exported" % (n, ",".join(listed[n])))
    for n in sorted(set(exports)):
        mod = emap.get(n)
        if not mod:
            print("NOTE %s: its module could not be found in index.ts (closure not checked)" % n)
            continue
        cl = closure(g, mod)
        base_changes = cl & (ch_prod if n in on_prod else ch_live)
        where = ",".join(listed.get(n, ["-"]))
        if "NOT_REDEPLOYED" in where and base_changes:
            danger += 1
            print("DANGER %s is NOT_REDEPLOYED but its code changed: %s — move it to a wave (and a rollback base)"
                  % (n, " ".join(sorted(base_changes))))
        elif "WAVE_2A_CHANGED" in where and not base_changes:
            print("NOTE %s is in WAVE_2A_CHANGED but its closure is unchanged (redeploying identical code is harmless)" % n)
        elif "WAVE_2B" in where:
            print("WAVE-B %s: %s" % (n, "changed: " + " ".join(sorted(base_changes)) if base_changes else "unchanged"))
    print("RESULT: %s" % ("DANGER %d" % danger if danger else "ok"))
    sys.exit(1 if danger else 0)


if __name__ == "__main__":
    main()
