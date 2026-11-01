"""P2 (MFA release): every third-party package the Owner-MFA service imports is one
production installs.

`app/services/owner_mfa.py` seals TOTP secrets with `cryptography.fernet` and talks
to Firestore through `firebase_admin`. Both imports sit inside functions, so a
missing package does not stop the API from starting. It surfaces later, as a 500
on the first enrolment or binding.

`cryptography` has no line of its own in `requirements.txt`. It arrives only
through python-jose's `[cryptography]` extra. Dropping that extra, or swapping
JOSE libraries, would break Owner MFA in production while every other test still
passes on a machine that happens to have `cryptography` installed. (The bare
Python 3.12 run of 25 Oct showed the opposite case: `tests.test_p1_owner_mfa`
could not even start without it.)

This check reads source and `requirements.txt` only. It imports no third-party
package, so it gives the same answer in every environment.

Run:  python3 -m tests.test_p2_mfa_dependencies
"""

from __future__ import annotations

import ast
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

checks = 0
failures: list[str] = []


def ok(label: str, cond: bool) -> None:
    global checks
    checks += 1
    if not cond:
        failures.append(label)


def requirements(path: Path) -> dict[str, set[str]]:
    """{distribution name (lower case, '_' -> '-'): extras} for every requirement line."""
    out: dict[str, set[str]] = {}
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.split("#", 1)[0].strip()
        if not line or line.startswith("-"):
            continue
        m = re.match(r"^([A-Za-z0-9][A-Za-z0-9._-]*)\s*(?:\[([^\]]*)\])?", line)
        if m:
            name = m.group(1).lower().replace("_", "-")
            out[name] = {e.strip().lower() for e in (m.group(2) or "").split(",") if e.strip()}
    return out


def third_party_imports(path: Path) -> set[str]:
    """Top-level names of every non-stdlib, non-`app` module imported anywhere in the file."""
    found: set[str] = set()
    for node in ast.walk(ast.parse(path.read_text(encoding="utf-8"))):
        if isinstance(node, ast.Import):
            names = [a.name for a in node.names]
        elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
            names = [node.module]
        else:
            continue
        for n in names:
            top = n.split(".", 1)[0]
            if top != "app" and top not in sys.stdlib_module_names and top != "__future__":
                found.add(top)
    return found


REQ = requirements(ROOT / "requirements.txt")

#: import name -> the requirement lines that install it in production. A new
#: third-party import in owner_mfa must be added here AND to requirements.txt.
PROVIDED_BY = {
    "cryptography": lambda r: "cryptography" in r or "cryptography" in r.get("python-jose", set()),
    "firebase_admin": lambda r: "firebase-admin" in r,
}

imports = third_party_imports(ROOT / "app" / "services" / "owner_mfa.py")

ok("owner_mfa imports cryptography (Fernet seals the TOTP secrets)", "cryptography" in imports)
ok("requirements.txt installs cryptography, directly or through python-jose[cryptography]",
   PROVIDED_BY["cryptography"](REQ))
ok("requirements.txt installs firebase-admin (owner_mfa's Firestore bindings)", PROVIDED_BY["firebase_admin"](REQ))
for name in sorted(imports - set(PROVIDED_BY)):
    ok(f"owner_mfa's third-party import '{name}' is declared in requirements.txt (add it to PROVIDED_BY)", False)

if failures:
    print(f"{len(failures)} of {checks} MFA dependency checks FAILED:")
    for f in failures:
        print("  ✗", f)
    sys.exit(1)
print(f"All {checks} MFA dependency checks passed.")
