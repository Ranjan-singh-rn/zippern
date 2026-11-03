"""The local test copy's viewing links: `verification._emulator_view_url` never acts outside it.

`_sign` asks `_emulator_view_url` first, so this pins that the local branch is inert unless the
backend is NOT in production AND the Storage emulator is configured — production goes straight to
the real signer, and so does any non-production backend that talks to real Storage. (The positive
path needs the Storage emulator; it is exercised by the local copy, not here.)

Run:  python3 -m tests.test_local_emulator_links
"""

from __future__ import annotations

import os
import sys

from app.config import settings
from app.services import verification

failures: list[str] = []
checks = 0


def ok(label: str, cond: bool) -> None:
    global checks
    checks += 1
    if not cond:
        failures.append(label)


class Boom(Exception):
    pass


def _no_storage(*_a, **_k):  # any Storage access in these cases is a failure
    raise Boom("Storage was touched")


saved_env = os.environ.get("STORAGE_EMULATOR_HOST")
saved = (settings.environment, settings.storage_emulator_host)
import firebase_admin.storage as fb_storage  # noqa: E402

saved_bucket = fb_storage.bucket
fb_storage.bucket = _no_storage  # type: ignore[assignment]
try:
    settings.environment = "production"
    settings.storage_emulator_host = "http://127.0.0.1:9199"
    os.environ["STORAGE_EMULATOR_HOST"] = "http://127.0.0.1:9199"
    try:
        ok("1  production: no local link, Storage untouched", verification._emulator_view_url("kyc/a/b.jpg") is None)
    except Boom:
        ok("1  production: no local link, Storage untouched", False)

    settings.environment = "development"
    settings.storage_emulator_host = ""
    os.environ.pop("STORAGE_EMULATOR_HOST", None)
    try:
        ok("2  development without the Storage emulator: no local link", verification._emulator_view_url("kyc/a/b.jpg") is None)
    except Boom:
        ok("2  development without the Storage emulator: no local link", False)

    settings.environment = "production"
    settings.storage_emulator_host = "http://127.0.0.1:9199"
    url, err = verification._sign("")
    ok("3  an empty path still answers (None, '')", url is None and err == "")

    # 4 — submitted-document links: an emulator link counts only in the local copy.
    from types import SimpleNamespace

    from app.core import isolation

    dev = SimpleNamespace(environment="development", storage_emulator_host="http://127.0.0.1:9199")
    prod = SimpleNamespace(environment="production", storage_emulator_host="http://127.0.0.1:9199")
    bare = SimpleNamespace(environment="development", storage_emulator_host="")
    android = "http://10.0.2.2:9199/v0/b/demo-zipper.appspot.com/o/kyc%2Fapplicants%2Fu%2Fdoc1.jpg?alt=media&token=t"
    ok("4a local copy: the Android emulator's link is accepted", isolation.is_local_emulator_media_url(dev, android, {}))
    ok("4b local copy: a 127.0.0.1 link is accepted",
       isolation.is_local_emulator_media_url(dev, "http://127.0.0.1:9199/v0/b/b/o/a.jpg", {}))
    ok("4c production: refused", not isolation.is_local_emulator_media_url(prod, android, {}))
    ok("4d no Storage emulator: refused", not isolation.is_local_emulator_media_url(bare, android, {}))
    ok("4e another host: refused", not isolation.is_local_emulator_media_url(dev, "http://evil.example/v0/b/x/o/y", {}))
    ok("4f a LAN host: refused", not isolation.is_local_emulator_media_url(dev, "http://192.168.1.5:9199/v0/b/x/o/y", {}))
    ok("4g not an object path: refused", not isolation.is_local_emulator_media_url(dev, "http://127.0.0.1:9199/x", {}))
    ok("4h unparseable: refused", not isolation.is_local_emulator_media_url(dev, "http://[::1", {}))
finally:
    fb_storage.bucket = saved_bucket  # type: ignore[assignment]
    settings.environment, settings.storage_emulator_host = saved
    if saved_env is None:
        os.environ.pop("STORAGE_EMULATOR_HOST", None)
    else:
        os.environ["STORAGE_EMULATOR_HOST"] = saved_env

if failures:
    print(f"FAIL {len(failures)}/{checks}")
    for f in failures:
        print("  -", f)
    sys.exit(1)
print(f"PASS {checks}/{checks} local emulator link checks")
