"""Local isolation: outside production, nothing leaves this machine.

`backend/.env` on the owner's machine pointed a `development` process at the
production MongoDB, the production Firebase project and the production service-
account key, so every local run worked on live data and `mongo.connect()` ran
`ensure_indexes()` — DDL — against it. `app/core/isolation.py` is the rule that
stops it. These checks pin the rule and, more importantly, pin WHERE it runs:
before a Mongo client, a Firebase credential or an email exists.

No database, no emulator, no network: the client constructors are replaced by
recorders, so "refused" is proven by the recorder never having been called.

    python3 -m tests.test_local_isolation
"""

from __future__ import annotations

import ast
import asyncio
import contextlib
import os
import sys
import tempfile
import types
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from tests.harness import install_stubs  # noqa: E402

install_stubs()

from app.config import settings  # noqa: E402
from app.core import isolation as iso  # noqa: E402
from app.core.isolation import IsolationError  # noqa: E402

checks = 0
failures = 0


def ok(claim, cond):
    global checks, failures
    checks += 1
    if not cond:
        failures += 1
        print(f"  FAIL  {claim}")


def raises(fn, exc=Exception):
    try:
        fn()
    except exc as e:  # noqa: PERF203
        return e
    return None


@contextlib.contextmanager
def env(**changes):
    """Set (str) or unset (None) process environment variables, then restore."""
    saved = {k: os.environ.get(k) for k in changes}
    try:
        for k, v in changes.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        yield
    finally:
        for k, v in saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v


#: Every variable these checks read from the process. Cleared for each scenario,
#: so the verification runner's own guard variables cannot make a check pass.
CLEAN = dict(
    K_SERVICE=None,
    ZIPPER_ALLOW_PRODUCTION_ACCESS=None,
    FIRESTORE_EMULATOR_HOST=None,
    FIREBASE_AUTH_EMULATOR_HOST=None,
    STORAGE_EMULATOR_HOST=None,
    GOOGLE_CLOUD_PROJECT=None,
    GCLOUD_PROJECT=None,
)

# A connection string shaped like production's: SRV, credentials, a cluster
# name. Nothing below may ever echo any part of it.
SECRET_USER = "fakeuserleaktest"
SECRET_PASS = "fakepassleaktest"   # obviously not a credential: a canary string
SECRET_HOST = "cluster0.leaktest.example.net"
PROD_URI = f"mongodb+srv://{SECRET_USER}:{SECRET_PASS}@{SECRET_HOST}/?retryWrites=true"
LOCAL_URI = "mongodb://127.0.0.1:27017/?directConnection=true"


def local_settings(**over):
    base = dict(
        environment="development",
        mongo_uri=LOCAL_URI,
        mongo_db="zipper_dev",
        firebase_project_id="demo-zipper",
        firebase_storage_bucket="demo-zipper.appspot.com",
        firestore_emulator_host="127.0.0.1:8080",
        firebase_auth_emulator_host="127.0.0.1:9099",
        storage_emulator_host="http://127.0.0.1:9199",
        sendgrid_api_key="",
    )
    base.update(over)
    return types.SimpleNamespace(**base)


def leaks(text: str) -> bool:
    return any(s in text for s in (SECRET_USER, SECRET_PASS, SECRET_HOST, "leaktest"))


# ══════════════════════════════════════════════════════════════════════════════
print("\n1. What counts as this machine")

for h in ("localhost", "LOCALHOST", "127.0.0.1", "127.9.9.9", "::1", "[::1]", "localhost."):
    ok(f"{h!r} is loopback", iso.is_loopback_host(h))
for h in ("", "0.0.0.0", "10.0.0.5", "192.168.1.2", "mongo", SECRET_HOST,
          "localhost.example.com", "127.0.0.1.nip.io", "::", "fe80::1"):
    ok(f"{h!r} is NOT loopback", not iso.is_loopback_host(h))

ok("host_of host:port", iso.host_of("127.0.0.1:8080") == "127.0.0.1")
ok("host_of [::1]:port", iso.host_of("[::1]:9099") == "::1")
ok("host_of url", iso.host_of("http://127.0.0.1:9199") == "127.0.0.1")
ok("host_of remote url", iso.host_of("https://storage.googleapis.com") == "storage.googleapis.com")
ok("host_of empty", iso.host_of("") == "")

scheme, hosts = iso.mongo_hosts(PROD_URI)
ok("mongo_hosts reads the scheme", scheme == "mongodb+srv")
ok("mongo_hosts cuts the credentials off", hosts == [SECRET_HOST])
scheme, hosts = iso.mongo_hosts("mongodb://a:b@127.0.0.1:27017,remote.example:27018/db?replicaSet=rs0")
ok("mongo_hosts reads every seed", hosts == ["127.0.0.1", "remote.example"])

# ══════════════════════════════════════════════════════════════════════════════
print("2. MongoDB outside production: this machine only")

E = {}
ok("a local replica-set URI is allowed", iso.mongo_problems(local_settings(), E) == [])
ok("localhost is allowed", iso.mongo_problems(local_settings(mongo_uri="mongodb://localhost:27017/?replicaSet=rs0"), E) == [])
ok("IPv6 loopback is allowed", iso.mongo_problems(local_settings(mongo_uri="mongodb://[::1]:27017/"), E) == [])
ok("a unix socket is allowed", iso.mongo_problems(local_settings(mongo_uri="mongodb://%2Ftmp%2Fmongodb-27017.sock"), E) == [])

p = iso.mongo_problems(local_settings(mongo_uri=PROD_URI), E)
ok("mongodb+srv:// is refused", len(p) == 1 and "mongodb+srv" in p[0])
ok("…and the refusal echoes no user, password or host", not leaks(" ".join(p)))

p = iso.mongo_problems(local_settings(mongo_uri=f"mongodb://{SECRET_USER}:{SECRET_PASS}@{SECRET_HOST}:27017/"), E)
ok("a remote mongodb:// host is refused", len(p) == 1 and "not on this machine" in p[0])
ok("…without echoing it", not leaks(" ".join(p)))

p = iso.mongo_problems(local_settings(mongo_uri="mongodb://127.0.0.1:27017,10.1.2.3:27017/?replicaSet=rs0"), E)
ok("one remote seed among local ones is enough to refuse", len(p) == 1 and "1 host" in p[0])
ok("an empty URI is refused", iso.mongo_problems(local_settings(mongo_uri=""), E) != [])
ok("a non-mongodb URI is refused", iso.mongo_problems(local_settings(mongo_uri="postgres://127.0.0.1/x"), E) != [])
ok("'test' is a non-production environment too",
   iso.mongo_problems(local_settings(environment="test", mongo_uri=PROD_URI), E) != [])
ok("so is a misspelled one (fails closed)",
   iso.mongo_problems(local_settings(environment="prodution", mongo_uri=PROD_URI), E) != [])

# ══════════════════════════════════════════════════════════════════════════════
print("3. Firebase outside production: a demo project and the emulators only")

ok("the template configuration is allowed", iso.firebase_problems(local_settings(), {}) == [])

p = iso.firebase_problems(local_settings(firebase_project_id="zipper-83816"), {})
ok("a real project id is refused", any("demo-" in x for x in p))
ok("an empty project id is refused", iso.firebase_problems(local_settings(firebase_project_id=""), {}) != [])

for var, field in iso.EMULATOR_VARS:
    p = iso.firebase_problems(local_settings(**{field: ""}), {})
    ok(f"missing {var} is refused", any(var in x and "not set" in x for x in p))
    p = iso.firebase_problems(local_settings(**{field: "emulators.example.com:8080"}), {})
    ok(f"{var} on another machine is refused", any(var in x and "this machine" in x for x in p))

p = iso.firebase_problems(local_settings(firestore_emulator_host="", firebase_auth_emulator_host="",
                                         storage_emulator_host=""),
                          {"FIRESTORE_EMULATOR_HOST": "127.0.0.1:8080",
                           "FIREBASE_AUTH_EMULATOR_HOST": "127.0.0.1:9099",
                           "STORAGE_EMULATOR_HOST": "http://127.0.0.1:9199"})
ok("emulator hosts may come from the process environment (firebase emulators:exec)", p == [])

p = iso.firebase_problems(local_settings(), {"GCLOUD_PROJECT": "zipper-83816"})
ok("GCLOUD_PROJECT naming another project is refused", any("GCLOUD_PROJECT" in x for x in p))
ok("GOOGLE_CLOUD_PROJECT equal to the demo project is fine",
   iso.firebase_problems(local_settings(), {"GOOGLE_CLOUD_PROJECT": "demo-zipper"}) == [])

p = iso.firebase_problems(local_settings(firebase_storage_bucket="zipper-83816.firebasestorage.app"), {})
ok("the production bucket is refused under a demo project", any("FIREBASE_STORAGE_BUCKET" in x for x in p))

# ══════════════════════════════════════════════════════════════════════════════
print("4. Production: unchanged on Cloud Run, confirmed anywhere else")

prod = local_settings(environment="production", mongo_uri=PROD_URI,
                      firebase_project_id="zipper-83816",
                      firebase_storage_bucket="zipper-83816.firebasestorage.app",
                      firestore_emulator_host="", firebase_auth_emulator_host="",
                      storage_emulator_host="")
ok("on Cloud Run (K_SERVICE) MongoDB is allowed", iso.mongo_problems(prod, {"K_SERVICE": "zipper-api"}) == [])
ok("on Cloud Run Firebase is allowed", iso.firebase_problems(prod, {"K_SERVICE": "zipper-api"}) == [])
p = iso.mongo_problems(prod, {})
ok("off Cloud Run, production is refused without confirmation", len(p) == 1 and "Cloud Run" in p[0])
ok("…and the refusal names the confirming variable", iso.PRODUCTION_ACK_ENV in p[0])
ok("…and echoes no secret", not leaks(p[0]))
ok("a confirmation for another project is refused",
   iso.mongo_problems(prod, {iso.PRODUCTION_ACK_ENV: "some-other-project"}) != [])
ok("an empty confirmation is refused", iso.mongo_problems(prod, {iso.PRODUCTION_ACK_ENV: ""}) != [])
ok("the matching confirmation allows that one deliberate run",
   iso.mongo_problems(prod, {iso.PRODUCTION_ACK_ENV: "zipper-83816"}) == []
   and iso.firebase_problems(prod, {iso.PRODUCTION_ACK_ENV: "zipper-83816"}) == [])
ok("production with no FIREBASE_PROJECT_ID cannot be confirmed",
   iso.mongo_problems(local_settings(environment="production", firebase_project_id=""),
                      {iso.PRODUCTION_ACK_ENV: ""}) != [])
ok("'prod' is production too", iso.is_production(local_settings(environment="prod")))

# ══════════════════════════════════════════════════════════════════════════════
print("5. Email: no key survives outside production")

s = local_settings(sendgrid_api_key="SG.realLookingKey.000")
ok("a development key is dropped", iso.disable_outbound_email_outside_production(s) is True
   and s.sendgrid_api_key == "")
s = local_settings(environment="test", sendgrid_api_key="SG.x")
ok("a test-environment key is dropped", iso.disable_outbound_email_outside_production(s) and s.sendgrid_api_key == "")
s = local_settings(environment="production", sendgrid_api_key="SG.prod")
ok("production keeps its key", iso.disable_outbound_email_outside_production(s) is False
   and s.sendgrid_api_key == "SG.prod")
ok("get_settings() applies the policy when settings load",
   "isolation.disable_outbound_email_outside_production(s)" in (ROOT / "app" / "config.py").read_text())

# ══════════════════════════════════════════════════════════════════════════════
print("6. Which settings file is read")

import app.config as config_module  # noqa: E402

_env_file = getattr(config_module, "_env_file", lambda: None)
with tempfile.TemporaryDirectory() as tmp:
    here = os.getcwd()
    try:
        os.chdir(tmp)
        with env(ZIPPER_ENV_FILE=None):
            ok("no .env.local → .env, as before", _env_file() == ".env")
            Path(tmp, ".env.local").write_text("ENVIRONMENT=development\n")
            ok(".env.local present → .env.local ONLY (never merged with .env)",
               _env_file() == ".env.local")
        with env(ZIPPER_ENV_FILE=".env"):
            ok("ZIPPER_ENV_FILE names the file explicitly", _env_file() == ".env")
    finally:
        os.chdir(here)
ok("the selection is a single file, not a tuple that would overlay .env",
   "env_file=_env_file()" in (ROOT / "app" / "config.py").read_text())

# ══════════════════════════════════════════════════════════════════════════════
print("7. mongo.connect(): refused BEFORE a client exists, so no ensure_indexes()")

from app.db import mongo  # noqa: E402

made: list = []
indexed: list = []


class _Admin:
    async def command(self, *_a, **_k):
        return {"ok": 1}


class RecordingMotor:
    def __init__(self, uri, **kw):
        made.append(uri)
        self.admin = _Admin()


async def _record_indexes():
    indexed.append(True)


_saved_motor, _saved_indexes = mongo.AsyncIOMotorClient, mongo.ensure_indexes
mongo.AsyncIOMotorClient = RecordingMotor
mongo.ensure_indexes = _record_indexes
_saved = {k: getattr(settings, k, None) for k in ("environment", "mongo_uri", "firebase_project_id")}
try:
    with env(**CLEAN):
        settings.environment, settings.mongo_uri = "development", PROD_URI
        e = raises(lambda: asyncio.run(mongo.connect()), IsolationError)
        ok("development + a production-shaped URI is refused", e is not None)
        ok("…before any client was constructed", made == [])
        ok("…so ensure_indexes() never ran", indexed == [])
        ok("…and the error echoes no part of the URI", e is not None and not leaks(str(e)))

        settings.environment, settings.mongo_uri = "production", PROD_URI
        settings.firebase_project_id = "zipper-83816"
        ok("production off Cloud Run, unconfirmed, is refused",
           raises(lambda: asyncio.run(mongo.connect()), IsolationError) is not None and made == [])

        settings.environment, settings.mongo_uri = "development", LOCAL_URI
        asyncio.run(mongo.connect())
        ok("a local URI connects, to exactly that URI", made == [LOCAL_URI])
        ok("…and then ensure_indexes() runs, locally", indexed == [True])

    made.clear(), indexed.clear()
    with env(**{**CLEAN, "K_SERVICE": "zipper-api"}):
        settings.environment, settings.mongo_uri = "production", PROD_URI
        asyncio.run(mongo.connect())
        ok("on Cloud Run production connects exactly as before", made == [PROD_URI] and indexed == [True])
finally:
    mongo.AsyncIOMotorClient, mongo.ensure_indexes = _saved_motor, _saved_indexes
    mongo._client = None
    for k, v in _saved.items():
        setattr(settings, k, v)

# ══════════════════════════════════════════════════════════════════════════════
print("8. The email recorder's own MongoClient carries the same refusal")

from app.services import email as email_service  # noqa: E402

sync_made: list = []


class RecordingSyncClient:
    def __init__(self, uri, **kw):
        sync_made.append(uri)

    def __getitem__(self, _name):
        raise AssertionError("must never be reached in this check")


_pymongo = sys.modules["pymongo"]
_saved_mc = _pymongo.MongoClient
_pymongo.MongoClient = RecordingSyncClient
_saved = {k: getattr(settings, k, None) for k in ("environment", "mongo_uri")}
try:
    with env(**CLEAN):
        email_service._sync_client = None
        settings.environment, settings.mongo_uri = "development", PROD_URI
        e = raises(lambda: email_service._record_blocking({"kind": "staff_invitation", "to": "a@b.c"}),
                   email_service.DeliveryNotRecorded)
        ok("development + a remote URI: the delivery is NOT recorded (so not sent)", e is not None)
        ok("…and no sync client was constructed", sync_made == [])
        ok("…and the message echoes no part of the URI", e is not None and not leaks(str(e)))
finally:
    _pymongo.MongoClient = _saved_mc
    email_service._sync_client = None
    for k, v in _saved.items():
        setattr(settings, k, v)

# ══════════════════════════════════════════════════════════════════════════════
print("9. firebase.init(): refused BEFORE any credential is read")

from app.db import firebase  # noqa: E402

calls: list = []


class AnonymousCredentials:  # stands in for google.auth.credentials.AnonymousCredentials
    pass


google = sys.modules["google"]
auth_pkg = types.ModuleType("google.auth")
creds_mod = types.ModuleType("google.auth.credentials")
creds_mod.AnonymousCredentials = AnonymousCredentials
auth_pkg.credentials = creds_mod
sys.modules["google.auth"], sys.modules["google.auth.credentials"] = auth_pkg, creds_mod
google.auth = auth_pkg

_saved_fb = (firebase.credentials.Certificate, firebase.credentials.ApplicationDefault,
             firebase.firebase_admin.initialize_app, firebase.firestore.client)
firebase.credentials.Certificate = lambda path: calls.append(("Certificate", path)) or "CERT"
firebase.credentials.ApplicationDefault = lambda: calls.append(("ApplicationDefault",)) or "ADC"
firebase.firebase_admin.initialize_app = lambda cred, opts=None: calls.append(("initialize_app", cred, opts)) or "APP"
firebase.firestore.client = lambda: calls.append(("firestore.client",)) or "FS"

_fields = ("environment", "firebase_project_id", "firebase_storage_bucket", "firebase_credentials_path",
           "firestore_emulator_host", "firebase_auth_emulator_host", "storage_emulator_host")
_saved = {k: getattr(settings, k, None) for k in _fields}


def reset_fb():
    firebase._app = None
    firebase._fs = None
    calls.clear()


try:
    # The shape of the old backend/.env: development, real project, a key path.
    with env(**CLEAN):
        reset_fb()
        settings.environment = "development"
        settings.firebase_project_id = "zipper-83816"
        settings.firebase_storage_bucket = "zipper-83816.firebasestorage.app"
        settings.firebase_credentials_path = __file__  # an EXISTING file: the key would load
        settings.firestore_emulator_host = settings.firebase_auth_emulator_host = ""
        settings.storage_emulator_host = ""
        e = raises(firebase.init, IsolationError)
        ok("development + the real project + a key file is refused", e is not None)
        ok("…before the key was read or ADC was asked", calls == [])
        ok("…and no app exists afterwards", firebase._app is None)

        # Demo project but one emulator missing: still refused.
        reset_fb()
        settings.firebase_project_id = "demo-zipper"
        settings.firebase_storage_bucket = "demo-zipper.appspot.com"
        settings.firestore_emulator_host = "127.0.0.1:8080"
        settings.firebase_auth_emulator_host = "127.0.0.1:9099"
        ok("a missing Storage emulator still refuses", raises(firebase.init, IsolationError) is not None and calls == [])

        # Fully local: anonymous credentials, the demo project, emulators exported.
        reset_fb()
        settings.storage_emulator_host = "http://127.0.0.1:9199"
        firebase.init()
        kinds = [c[0] for c in calls]
        ok("the local configuration initialises", "initialize_app" in kinds)
        ok("…without the service-account key", "Certificate" not in kinds)
        ok("…and without Application Default Credentials", "ApplicationDefault" not in kinds)
        init_call = next(c for c in calls if c[0] == "initialize_app")
        ok("…with anonymous credentials", isinstance(init_call[1], AnonymousCredentials))
        ok("…naming the demo project explicitly", init_call[2].get("projectId") == "demo-zipper")
        ok("…and the demo bucket", init_call[2].get("storageBucket") == "demo-zipper.appspot.com")
        ok("…and the SDKs can now see the emulator hosts",
           os.environ.get("FIRESTORE_EMULATOR_HOST") == "127.0.0.1:8080"
           and os.environ.get("FIREBASE_AUTH_EMULATOR_HOST") == "127.0.0.1:9099"
           and os.environ.get("STORAGE_EMULATOR_HOST") == "http://127.0.0.1:9199")

    with env(**CLEAN):
        reset_fb()
        settings.environment = "production"
        settings.firebase_project_id = "zipper-83816"
        settings.firebase_storage_bucket = "zipper-83816.firebasestorage.app"
        settings.firestore_emulator_host = settings.firebase_auth_emulator_host = ""
        settings.storage_emulator_host = ""
        ok("production off Cloud Run, unconfirmed, is refused before any credential",
           raises(firebase.init, IsolationError) is not None and calls == [])

    with env(**{**CLEAN, "K_SERVICE": "zipper-api"}):
        reset_fb()
        settings.firebase_credentials_path = "/nonexistent/key.json"
        firebase.init()
        kinds = [c[0] for c in calls]
        ok("on Cloud Run production initialises exactly as before (ADC, real project options)",
           kinds[:2] == ["ApplicationDefault", "initialize_app"]
           and calls[1][2] == {"storageBucket": "zipper-83816.firebasestorage.app"})
finally:
    (firebase.credentials.Certificate, firebase.credentials.ApplicationDefault,
     firebase.firebase_admin.initialize_app, firebase.firestore.client) = _saved_fb
    reset_fb()
    for k, v in _saved.items():
        setattr(settings, k, v)

# ══════════════════════════════════════════════════════════════════════════════
print("10. Startup checks everything at once, before Firebase or Mongo")

main_src = (ROOT / "app" / "main.py").read_text()
# Statement lines only — the comments around them mention the same names.
_stmt = {line.strip(): i for i, line in enumerate(main_src.splitlines())}
i_iso = _stmt.get("isolation.assert_local_isolation(settings)", -1)
i_fb = _stmt.get("firebase.init()", -1)
i_mongo = _stmt.get("await mongo.connect()", -1)
ok("the lifespan calls assert_local_isolation", i_iso != -1)
ok("…before firebase.init() and mongo.connect()", -1 < i_iso < i_fb < i_mongo)

old_env_shape = local_settings(mongo_uri=PROD_URI, firebase_project_id="zipper-83816",
                               firebase_storage_bucket="zipper-83816.firebasestorage.app",
                               firestore_emulator_host="", firebase_auth_emulator_host="",
                               storage_emulator_host="")
e = raises(lambda: iso.assert_local_isolation(old_env_shape, {}), IsolationError)
ok("the old backend/.env shape is refused at startup", e is not None)
ok("…naming MongoDB and Firebase problems in one message",
   e is not None and "MONGO_URI" in str(e) and "FIREBASE_PROJECT_ID" in str(e))
ok("…without echoing a secret", e is not None and not leaks(str(e)))

# ══════════════════════════════════════════════════════════════════════════════
print("11. The shipped template is local, and passes the checks")

template = (ROOT / ".env.example").read_text()
values = {}
for line in template.splitlines():
    line = line.strip()
    if line and not line.startswith("#") and "=" in line:
        k, v = line.split("=", 1)
        values[k.strip().lower()] = v.strip()
tmpl = types.SimpleNamespace(**values)
ok(".env.example passes every isolation check", iso.mongo_problems(tmpl, {}) == []
   and iso.firebase_problems(tmpl, {}) == [])
ok(".env.example names no production project", "zipper-83816" not in template)
ok(".env.example names no key file", "serviceAccountKey" not in template)
ok(".env.example has no remote MongoDB", "mongodb+srv" not in template)
ok(".env.example uses a dedicated development database", values.get("mongo_db") == "zipper_dev")
ok(".env.example leaves SendGrid empty", values.get("sendgrid_api_key", "x") == "")

# ══════════════════════════════════════════════════════════════════════════════
print("12. Every client constructor in app/ sits behind a check")

#: (file, function) → the client constructors it may contain. Anything not in
#: this table is a new way out of the process and fails here until it is
#: guarded and listed. SendGrid is governed by the key policy (section 5).
ALLOWED = {
    ("app/db/mongo.py", "connect"): {"AsyncIOMotorClient"},
    ("app/services/email.py", "_record_blocking"): {"MongoClient"},
    ("app/db/firebase.py", "init"): {"Certificate", "ApplicationDefault", "initialize_app"},
    ("app/db/firebase.py", "_init_local_emulators"): {"initialize_app", "AnonymousCredentials"},
    ("app/services/email.py", "_send_via_provider"): {"SendGridAPIClient"},
}
GUARDS = {
    ("app/db/mongo.py", "connect"): "assert_mongo_allowed",
    ("app/services/email.py", "_record_blocking"): "assert_mongo_allowed",
    ("app/db/firebase.py", "init"): "assert_firebase_allowed",
}
CONSTRUCTORS = {"AsyncIOMotorClient", "MongoClient", "initialize_app", "Certificate",
                "ApplicationDefault", "SendGridAPIClient", "AnonymousCredentials",
                "Client", "AsyncClient"}
found: dict = {}
for path in sorted((ROOT / "app").rglob("*.py")):
    rel = path.relative_to(ROOT).as_posix()
    tree = ast.parse(path.read_text(), filename=rel)
    for fn in [n for n in ast.walk(tree) if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef))]:
        for call in [n for n in ast.walk(fn) if isinstance(n, ast.Call)]:
            f = call.func
            name = f.attr if isinstance(f, ast.Attribute) else getattr(f, "id", "")
            if name in CONSTRUCTORS:
                found.setdefault((rel, fn.name), set()).add(name)
unexpected = {k: v for k, v in found.items() if not v <= ALLOWED.get(k, set())}
ok("no client is constructed anywhere else in app/", not unexpected)
if unexpected:
    print("        unexpected:", unexpected)
for (rel, fname), guard in GUARDS.items():
    tree = ast.parse((ROOT / rel).read_text())
    fn = next(n for n in ast.walk(tree)
              if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)) and n.name == fname)
    guard_line = min((n.lineno for n in ast.walk(fn) if isinstance(n, ast.Call)
                      and isinstance(n.func, ast.Attribute) and n.func.attr == guard), default=None)
    ctor_line = min((n.lineno for n in ast.walk(fn) if isinstance(n, ast.Call)
                     and (getattr(n.func, "attr", None) or getattr(n.func, "id", None)) in CONSTRUCTORS),
                    default=None)
    ok(f"{rel}:{fname} calls {guard} before its first client",
       guard_line is not None and (ctor_line is None or guard_line < ctor_line))

# Scripts reach MongoDB and Firebase through `mongo.connect()` / `firebase.init()`
# and so inherit the checks above. These are the only scripts that open a
# connection of their own; a new one fails here until it is reviewed and listed.
SCRIPT_NETWORK = {
    # → the Auth emulator outside production; decided by signin_url() (section 13)
    "scripts/signin.py": {"httpx.post"},
    # → public download URLs of the PREVIOUS project's bucket (read-only probes)
    "scripts/migrate_assets.py": {"urlopen"},
    # → Google's Rules API, read-only, with the key file: production verifiers
    #   that are run on purpose (LOCAL_DEVELOPMENT.md, "Deliberate production operations")
    "scripts/verify_deployed_storage_rules.py": {"urlopen", "from_service_account_file"},
}
script_found: dict = {}
for path in sorted((ROOT / "scripts").glob("*.py")):
    rel = path.relative_to(ROOT).as_posix()
    for node in ast.walk(ast.parse(path.read_text(), filename=rel)):
        if not isinstance(node, ast.Call):
            continue
        f = node.func
        name = f.attr if isinstance(f, ast.Attribute) else getattr(f, "id", "")
        owner = getattr(getattr(f, "value", None), "id", "")
        label = f"{owner}.{name}" if owner in {"httpx", "requests"} else name
        if label in {"urlopen", "httpx.post", "httpx.get", "httpx.Client", "requests.get",
                     "requests.post", "requests.Session", "MongoClient", "AsyncIOMotorClient",
                     "initialize_app", "from_service_account_file", "Certificate"}:
            script_found.setdefault(rel, set()).add(label)
unexpected = {k: v for k, v in script_found.items() if not v <= SCRIPT_NETWORK.get(k, set())}
ok("no other script opens a connection of its own", not unexpected)
if unexpected:
    print("        unexpected:", unexpected)

# ══════════════════════════════════════════════════════════════════════════════
print("13. scripts/signin.py: the Auth emulator only, outside production")

sys.modules.setdefault("httpx", types.SimpleNamespace(post=lambda *a, **k: None, HTTPError=Exception))
from scripts import signin  # noqa: E402

_signin_url = getattr(signin, "signin_url", None)
ok("signin.py decides its destination in signin_url()", _signin_url is not None)
_saved = {k: getattr(settings, k, None) for k in ("environment", "firebase_auth_emulator_host", "firebase_project_id")}
try:
    if _signin_url is not None:
        with env(**CLEAN):
            settings.environment, settings.firebase_auth_emulator_host = "development", ""
            ok("no emulator → refuses rather than signing in to the real project",
               raises(_signin_url, SystemExit) is not None)
            settings.firebase_auth_emulator_host = "127.0.0.1:9099"
            url = _signin_url()
            ok("with the emulator → the emulator URL on this machine",
               url.startswith("http://127.0.0.1:9099/identitytoolkit.googleapis.com/"))
            settings.firebase_auth_emulator_host = "auth.example.com:9099"
            ok("an emulator host on another machine is refused", raises(_signin_url, SystemExit) is not None)
            settings.environment, settings.firebase_project_id = "production", "zipper-83816"
            ok("production mode off Cloud Run is refused without confirmation",
               raises(_signin_url, SystemExit) is not None)
finally:
    for k, v in _saved.items():
        setattr(settings, k, v)

# ── Result ──────────────────────────────────────────────────────────────────
if failures:
    print(f"\n{failures} of {checks} checks FAILED.\n")
    sys.exit(1)
print(f"\nAll {checks} local-isolation checks passed.")
print("  · outside production: MongoDB on this machine, Firebase emulators, demo project")
print("  · refusals happen before any client, credential or connection exists")
print("  · no email key survives outside production")
print("  · production on Cloud Run is unchanged; elsewhere it must be confirmed\n")
