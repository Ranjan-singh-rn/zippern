"""The local test copy's mailbox: what would have been emailed is written to a folder instead.

`email._local_mailbox_dir()` / `email._write_local_mailbox()` exist so the LOCAL test copy
(~/zipper-release/qa/local-stack.command, LOCAL_MAILBOX_DIR) can finish flows that wait for an
emailed code or link. What this checks:

  1. production ignores LOCAL_MAILBOX_DIR entirely — nothing is ever written there;
  2. development with it unset: off;
  3. development with it set: the folder is used;
  4. a written message is one 0600 JSON file holding to / kind / subject / text / html,
     with a file name that carries no address and no code.

Run:  python3 -m tests.test_local_mailbox
"""

from __future__ import annotations

import json
import os
import stat
import sys
import tempfile
from pathlib import Path

from app.config import settings
from app.services import email

failures: list[str] = []
checks = 0


def ok(label: str, cond: bool) -> None:
    global checks
    checks += 1
    if not cond:
        failures.append(label)


saved = (settings.environment, getattr(settings, "local_mailbox_dir", ""))
try:
    with tempfile.TemporaryDirectory() as tmp:
        box = str(Path(tmp) / "mailbox")

        settings.environment = "production"
        settings.local_mailbox_dir = box
        ok("1  production ignores LOCAL_MAILBOX_DIR", email._local_mailbox_dir() is None)

        settings.environment = "development"
        settings.local_mailbox_dir = ""
        ok("2  development, unset: off", email._local_mailbox_dir() is None)

        settings.local_mailbox_dir = box
        ok("3  development, set: the folder is used", email._local_mailbox_dir() == box)

        name = email._write_local_mailbox(
            box, "owner_mfa/code", "someone@zipper.test", "Your code", "<p>Code: <b>123456</b></p>",
        )
        path = Path(box) / name
        ok("4a one file was written", path.is_file() and len(list(Path(box).iterdir())) == 1)
        ok("4b the file name carries no address and no code",
           "zipper.test" not in name and "123456" not in name and name.endswith(".json"))
        ok("4c the file is private (0600)", stat.S_IMODE(os.stat(path).st_mode) == 0o600)
        body = json.loads(path.read_text(encoding="utf-8"))
        ok("4d to / kind / subject / html are kept",
           body.get("to") == "someone@zipper.test" and body.get("kind") == "owner_mfa/code"
           and body.get("subject") == "Your code" and "123456" in body.get("html", ""))
        ok("4e a text part is included", "123456" in body.get("text", ""))
finally:
    settings.environment, settings.local_mailbox_dir = saved

if failures:
    print(f"FAIL {len(failures)}/{checks}")
    for f in failures:
        print("  -", f)
    sys.exit(1)
print(f"PASS {checks}/{checks} local mailbox checks")
