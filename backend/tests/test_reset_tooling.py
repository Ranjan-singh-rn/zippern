"""scripts/reset — backup, plan, execute, seed, postcheck: unit tests against fakes.

    cd backend && python3 -B -m tests.test_reset_tooling

No network, no credentials, no SDK: the adapters are in-memory. What is pinned:
  * the classification table covers every top-level collection in
    firestore.rules (and every subcollection declared under a DELETE parent),
    every Mongo collection the backend names, and is free of overlaps;
  * the manifest freeze: a document created after manifest_time is skipped by
    execute and reported — never deleted;
  * refusals: target mismatch, stale backup, unverified backup, dry-run backup,
    unknown collection / subcollection / prefix / _id type, demo- project,
    wrong typed project, wrong sha prefix, missing canary, table change;
  * execute is idempotent (a re-run deletes nothing new, completes failures);
  * seed validation (two observers, bad phone, placeholder address, duplicate);
  * backup dry-run prints no connection string; verify parses a real-shaped
    mongodump archive; a verify failure is recorded and refused;
  * no module performs an unbounded delete (source scan).
"""

from __future__ import annotations

import gzip
import io
import json
import os
import re
import struct
import subprocess
import sys
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from scripts.reset import backup as B  # noqa: E402
from scripts.reset import classification as T  # noqa: E402
from scripts.reset import common as C  # noqa: E402
from scripts.reset import execute as X  # noqa: E402
from scripts.reset import plan as P  # noqa: E402
from scripts.reset import postcheck as PC  # noqa: E402
from scripts.reset import seed as S  # noqa: E402

checks = 0
failures: list[str] = []


def ok(claim: str, cond: bool, detail: str = "") -> None:
    global checks
    checks += 1
    if not cond:
        failures.append(f"{claim} {detail}".strip())


def refused(claim: str, fn, needle: str = "") -> None:
    global checks
    checks += 1
    try:
        fn()
    except C.Refused as exc:
        if needle and needle.lower() not in str(exc).lower():
            failures.append(f"{claim}: refused, but not for the expected reason: {exc}")
        return
    failures.append(f"{claim}: was NOT refused")


NOW = datetime(2026, 11, 1, 10, 0, 0, tzinfo=timezone.utc)
T0 = NOW - timedelta(minutes=10)        # before the manifest
LATER = NOW + timedelta(minutes=5)      # after the manifest
TARGET = C.Target(project="real-project-1", bucket="real-project-1.appspot.com", mongo_db="zipper")
TMP = Path(tempfile.mkdtemp(prefix="reset-tooling-"))


# ══════════════════════════════════════════════════════════════════════════════
#  Fakes (the adapter interfaces of scripts/reset/adapters.py)
# ══════════════════════════════════════════════════════════════════════════════

class FakeFirestore:
    def __init__(self, project: str, docs: dict[str, dict] | None = None) -> None:
        self._project = project
        self.docs: dict[str, dict] = dict(docs or {})   # "users/u1" → fields (incl. _create_time)
        self.deleted: list[str] = []
        self.fail_paths: set[str] = set()

    def project(self) -> str:
        return self._project

    @staticmethod
    def _is_child(path: str, coll: str) -> bool:
        return path.startswith(coll + "/") and path.count("/") == coll.count("/") + 1

    def list_collections(self) -> list[str]:
        return sorted({p.split("/", 1)[0] for p in self.docs})

    def list_docs(self, collection_path: str) -> list[tuple[str, dict]]:
        return sorted((p.rsplit("/", 1)[1], dict(f)) for p, f in self.docs.items()
                      if self._is_child(p, collection_path))

    def list_doc_ids(self, collection_path: str) -> list[str]:
        """Like Firestore's ListDocuments with show_missing: ids of existing docs AND of
        phantom parents that exist only through a deeper path."""
        depth = collection_path.count("/") + 1
        return sorted({p.split("/")[depth] for p in self.docs
                       if p.startswith(collection_path + "/") and p.count("/") >= depth})

    def list_subcollections(self, doc_path: str) -> list[str]:
        return sorted({p[len(doc_path) + 1:].split("/", 1)[0] for p in self.docs
                       if p.startswith(doc_path + "/") and p.count("/") >= doc_path.count("/") + 2})

    def get_doc(self, doc_path: str) -> dict | None:
        if doc_path in self.fail_paths:
            raise RuntimeError("simulated read failure")
        f = self.docs.get(doc_path)
        return dict(f) if f is not None else None

    def count(self, collection_path: str) -> int:
        return len(self.list_docs(collection_path))

    def delete_docs(self, doc_paths: list[str]) -> None:
        for p in doc_paths:
            if p in self.fail_paths:
                raise RuntimeError("simulated delete failure")
        for p in doc_paths:
            self.docs.pop(p, None)
            self.deleted.append(p)

    def set_doc(self, doc_path: str, data: dict, merge: bool = True) -> None:
        cur = self.docs.get(doc_path, {}) if merge else {}
        self.docs[doc_path] = {**cur, **data, "_create_time": cur.get("_create_time", NOW)}


class OID:
    """Stands in for bson.ObjectId: 24 hex chars + a generation time."""
    def __init__(self, hexid: str, generation_time: datetime) -> None:
        self.hexid, self.generation_time = hexid, generation_time

    def __str__(self) -> str:
        return self.hexid

    def __eq__(self, other: Any) -> bool:
        return isinstance(other, OID) and other.hexid == self.hexid

    def __hash__(self) -> int:
        return hash(self.hexid)


OID.__name__ = "ObjectId"


class FakeMongo:
    def __init__(self, db: str, colls: dict[str, list[dict]] | None = None, hosts=("cluster0.example.invalid",)) -> None:
        self._db, self._hosts = db, list(hosts)
        self.colls: dict[str, list[dict]] = {k: [dict(d) for d in v] for k, v in (colls or {}).items()}
        self.deleted: list[tuple[str, Any]] = []
        self.fail_ids: set[str] = set()

    def db_name(self) -> str:
        return self._db

    def hosts(self) -> list[str]:
        return list(self._hosts)

    def list_collections(self) -> list[str]:
        return sorted(self.colls)

    def find_ids(self, collection: str) -> list[dict]:
        return [dict(d) for d in self.colls.get(collection, [])]

    @staticmethod
    def _match(doc: dict, id_spec: dict) -> bool:
        v = doc.get("_id")
        if id_spec["t"] == "oid":
            return isinstance(v, OID) and v.hexid == id_spec["v"]
        if id_spec["t"] == "str":
            return isinstance(v, str) and v == id_spec["v"]
        return isinstance(v, int) and not isinstance(v, bool) and v == id_spec["v"]

    def find_one(self, collection: str, id_spec: dict) -> dict | None:
        return next((dict(d) for d in self.colls.get(collection, []) if self._match(d, id_spec)), None)

    def count(self, collection: str) -> int:
        return len(self.colls.get(collection, []))

    def delete_one(self, collection: str, id_spec: dict) -> int:
        if str(id_spec["v"]) in self.fail_ids:
            raise RuntimeError("simulated mongo failure")
        before = len(self.colls.get(collection, []))
        self.colls[collection] = [d for d in self.colls.get(collection, []) if not self._match(d, id_spec)]
        n = before - len(self.colls[collection])
        if n:
            self.deleted.append((collection, id_spec["v"]))
        return n

    def upsert(self, collection: str, filter_: dict, set_fields: dict, set_on_insert: dict) -> None:
        rows = self.colls.setdefault(collection, [])
        for d in rows:
            if all(d.get(k) == v for k, v in filter_.items()):
                d.update(set_fields)
                return
        rows.append({"_id": f"new{len(rows)}", **set_on_insert, **set_fields})


class FakeStorage:
    def __init__(self, bucket: str, objects: list[dict] | None = None, exists: bool = True) -> None:
        self._bucket, self._exists = bucket, exists
        self.objects: dict[str, dict] = {o["name"]: dict(o) for o in (objects or [])}
        self.deleted: list[str] = []

    def bucket_name(self) -> str:
        return self._bucket

    def bucket_exists(self) -> bool:
        return self._exists

    def list_objects(self) -> list[dict]:
        return [dict(o) for o in self.objects.values()]

    def get_object(self, name: str) -> dict | None:
        o = self.objects.get(name)
        return dict(o) if o else None

    def delete_object(self, name: str, generation: Any = None) -> None:
        self.objects.pop(name, None)
        self.deleted.append(name)


class FakeAuth:
    def __init__(self, users: list[dict] | None = None) -> None:
        self.users: dict[str, dict] = {u["uid"]: dict(u) for u in (users or [])}
        self.deleted: list[str] = []
        self.fail_uids: set[str] = set()
        self.created: list[dict] = []
        self.updates: list[tuple[str, dict]] = []
        self.reset_links: list[str] = []

    def list_users(self) -> list[dict]:
        return [dict(u) for u in self.users.values()]

    def get_user(self, uid: str) -> dict | None:
        u = self.users.get(uid)
        return dict(u) if u else None

    def get_user_by_email(self, email: str) -> dict | None:
        return next((dict(u) for u in self.users.values() if u.get("email") == email), None)

    def get_user_by_phone(self, phone: str) -> dict | None:
        return next((dict(u) for u in self.users.values() if u.get("phone") == phone), None)

    def delete_users(self, uids: list[str]) -> list[tuple[str, str]]:
        errors = []
        for uid in uids:
            if uid in self.fail_uids:
                errors.append((uid, "simulated auth failure"))
                continue
            self.users.pop(uid, None)
            self.deleted.append(uid)
        return errors

    def create_user(self, *, email, phone, display_name, email_verified, password) -> str:
        uid = f"uid-{len(self.users) + 1}"
        self.users[uid] = {"uid": uid, "email": email, "phone": phone, "created": NOW, "providers": ["password"],
                           "email_verified": email_verified}
        self.created.append({"uid": uid, "password": password})
        return uid

    def update_user(self, uid: str, **fields: Any) -> None:
        self.updates.append((uid, fields))
        self.users[uid].update({"phone": fields.get("phone_number", self.users[uid].get("phone"))})

    def generate_password_reset_link(self, email: str) -> str:
        self.reset_links.append(email)
        return "https://example.invalid/reset?oob=FAKE"


def world(*, extra_fs: dict | None = None, extra_mongo: dict | None = None, extra_storage: list | None = None,
          extra_auth: list | None = None):
    fs = FakeFirestore(TARGET.project, {
        "users/u1": {"name": "a", "_create_time": T0},
        "users/u2": {"name": "b", "_create_time": T0},
        "users/u1/fcmTokens/t1": {"_create_time": T0},
        "users/u1/diamondTransactions/d1": {"_create_time": T0},
        "crmUsers/o1": {"role": "superadmin", "_create_time": T0},
        "agencies/a1": {"_create_time": T0},
        "agencies/a1/agencyHosts/u2": {"_create_time": T0},
        "appConfig/economy": {"beanToDiamondRate": 10, "_create_time": T0},
        "appConfig/androidUpdate": {"_create_time": T0},
        "gifts/g1": {"_create_time": T0},
        "levelConfig/host": {"_create_time": T0},
        "levelConfig/host/levels/1": {"_create_time": T0},
        **(extra_fs or {}),
    })
    mongo = FakeMongo(TARGET.mongo_db, {
        "staff": [{"_id": OID("a" * 24, T0), "uid": "o1", "role": "owner", "created_at": T0},
                  {"_id": OID("b" * 24, T0), "uid": "observer:x", "role": "observer", "created_at": T0}],
        "ledger": [{"_id": OID("c" * 24, T0), "at": T0}],
        "audit": [{"_id": "aud1", "at": T0}],
        "balances": [{"_id": 7, "holder_id": "u1"}],
        "rates": [{"_id": "r1"}],
        "ops_canary": [{"_id": "target", "firebase_project_id": TARGET.project}],
        "scheduled_runs": [{"_id": "s1"}, {"_id": "s2"}],
        **(extra_mongo or {}),
    })
    storage = FakeStorage(TARGET.bucket, [
        {"name": "kyc/a1/u2/id.jpg", "size": 10, "md5": "m1", "updated": T0, "time_created": T0, "generation": 1},
        {"name": "profileMedia/u1/p.jpg", "size": 20, "md5": "m2", "updated": T0, "time_created": T0, "generation": 1},
        {"name": "appBuilds/app-1.apk", "size": 30, "md5": "m3", "updated": T0, "time_created": T0, "generation": 1},
        {"name": "contentAssets/x.png", "size": 30, "md5": "m4", "updated": T0, "time_created": T0, "generation": 1},
        *(extra_storage or []),
    ])
    auth = FakeAuth([
        {"uid": "o1", "email": "o1@real.example.invalid", "phone": "+10000000001", "created": T0, "providers": ["password"]},
        {"uid": "u1", "email": None, "phone": "+10000000002", "created": T0, "providers": ["phone"]},
        {"uid": "u2", "email": None, "phone": "+10000000003", "created": T0, "providers": ["phone"]},
        *(extra_auth or []),
    ])
    return fs, mongo, storage, auth


def backup_manifest(path: Path, *, finished: datetime = NOW - timedelta(minutes=20), mode: str = "executed",
                    verified: bool = True, target: C.Target = TARGET) -> Path:
    data = {"kind": C.BACKUP_MANIFEST_KIND, "version": 1, "mode": mode, "target": target.as_dict(),
            "backup_bucket": "backups-bucket", "run_stamp": C.stamp(finished), "started": C.iso(finished - timedelta(minutes=3)),
            "finished": C.iso(finished), "firestore_export": {"uri": "gs://backups-bucket/zipper-backups/firestore/x/"},
            "mongo_dump": {"path": str(path.parent / "mongo.archive.gz")}, "storage": {}, "artifacts": {},
            "verify": {"passed": True, "checked_at": C.iso(finished + timedelta(minutes=2))} if verified else None}
    C.write_json(path, data)
    return path


# ══════════════════════════════════════════════════════════════════════════════
print("1. The table covers every name the system uses, and has no overlaps")

RULES = ROOT.parent / "firestore.rules"
tops = T.rules_top_level_collections(RULES)
ok("rules parser finds the known collections", {"users", "crmUsers", "appConfig", "giftIdempotency"} <= set(tops), str(tops))
ok("rules parser skips wildcard first segments", not any(t.startswith("{") for t in tops))
unclassified = [t for t in tops if T.classify_firestore(t) == T.UNKNOWN]
ok(f"every top-level rules collection is classified ({len(tops)} found)", not unclassified, str(unclassified))
subs = T.rules_subcollections(RULES)
ok("rules parser finds users subcollections", {"fcmTokens", "weeklyEarnings"} <= subs.get("users", set()), str(subs.get("users")))
missing_subs = [(p, s) for p, ss in subs.items() if T.classify_firestore(p) == T.DELETE
                for s in ss if T.classify_subcollection(p, s) != T.DELETE]
ok("every rules subcollection under a DELETE parent is in FIRESTORE_SUBCOLLECTIONS", not missing_subs, str(missing_subs))
ok("a subcollection under a KEEP parent is never walked (levelConfig/levels is KEEP by parent)",
   T.classify_firestore("levelConfig") == T.KEEP)

mongo_src = (ROOT / "app" / "db" / "mongo.py").read_text()
c_names = re.findall(r'^\s{4}[A-Z_]+\s*=\s*"([a-z_]+)"', mongo_src, re.M)
ok("found the C.* collection constants", len(c_names) >= 25, str(len(c_names)))
service_literals = {"role_appeals", "role_appeal_locks", "transfer_requests", "transfer_locks", "money_freezes",
                    "host_application_locks", "partner_role_claims", "agency_hosts", "ops_canary", "owner_mfa"}
unclassified_mongo = [n for n in set(c_names) | service_literals if T.classify_mongo(n) == T.UNKNOWN]
ok("every Mongo collection the backend names is classified", not unclassified_mongo, str(unclassified_mongo))

storage_rules = (ROOT.parent / "storage.rules").read_text()
st_prefixes = {m.split("/")[0] for m in re.findall(r"^\s*match\s+/([A-Za-z0-9_-]+)/", storage_rules, re.M)} - {"b"}
unclassified_st = [p for p in st_prefixes if p not in T.known_names("storage")]
ok("every storage.rules prefix is in a storage list (keep / delete / undecided)", not unclassified_st, str(unclassified_st))
ok("the table has no overlaps", not T.self_check(), str(T.self_check()))
ok("exactly the three approved uploads prefixes are DELETE", set(T.STORAGE_DELETE) == {"profileMedia", "kyc", "hostVerification"})
ok("KEEP holds the spec's list", {"appConfig", "gifts", "levelConfig", "bagItems"} <= set(T.FIRESTORE_KEEP)
   and {"appBuilds", "contentAssets"} <= set(T.STORAGE_KEEP) and {"rates", "chance_configs"} <= set(T.MONGO_KEEP))
ok("DELETE holds the spec's list", {"users", "crmUsers", "agencies", "sellers", "rechargeRequests", "appeals",
                                     "hostVerification", "kycSubmissions", "notifications", "callHistory"} <= set(T.FIRESTORE_DELETE)
   and {"staff", "ledger", "balances", "cards", "audit", "recharges", "partner_sales"} <= set(T.MONGO_DELETE))
ok("everything under a DELETE prefix is DELETE (placeholders too); a bare object named like the prefix is UNKNOWN",
   T.classify_storage("kyc/loose.jpg") == T.DELETE and T.classify_storage("kyc/a1/") == T.DELETE
   and T.classify_storage("kyc") == T.UNKNOWN)
ok("an undecided prefix is UNKNOWN", T.classify_storage("sellerDocs/s1/doc.pdf") == T.UNKNOWN)
ok("the table fingerprint is stable", T.table_fingerprint() == T.table_fingerprint() and len(T.table_fingerprint()) == 64)

# ══════════════════════════════════════════════════════════════════════════════
print("2. Plan: the frozen manifest")

P.say = lambda *parts: None  # type: ignore[assignment]  — keep the refusal tables out of the test output
RUN = TMP / "run1"
RUN.mkdir()
BM = backup_manifest(RUN / "backup-manifest.json")
fs, mongo, storage, auth = world()
manifest = P.build_manifest(target=TARGET, fs=fs, mongo=mongo, storage=storage, auth=auth, backup_manifest_path=BM,
                            canary_project=TARGET.project, now=NOW)
ok("manifest_time is the freeze instant given", manifest["manifest_time"] == C.iso(NOW))
ok("no unknowns in the baseline world", not manifest["unknown"], str(manifest["unknown"]))
fsd = {e["path"] for e in manifest["delete"]["firestore"]}
ok("users and their subcollection documents are frozen by path",
   {"users/u1", "users/u2", "users/u1/fcmTokens/t1", "users/u1/diamondTransactions/d1", "agencies/a1/agencyHosts/u2"} <= fsd)
ok("KEEP collections contribute no delete paths", not any(p.startswith(("appConfig/", "gifts/", "levelConfig/")) for p in fsd))
ok("KEEP counts recorded for postcheck", manifest["keep"]["firestore"] == {"appConfig": 2, "gifts": 1, "levelConfig": 1}
   and manifest["keep"]["mongo"] == {"ops_canary": 1, "rates": 1, "scheduled_runs": 2}
   and manifest["keep"]["storage"] == {"appBuilds": 1, "contentAssets": 1}, str(manifest["keep"]))
ok("per-subcollection counts", manifest["counts"]["firestore"]["users/*/fcmTokens"] == 1
   and manifest["counts"]["firestore"]["users"] == 2 and manifest["counts"]["firestore"]["agencies/*/agencyHosts"] == 1)
ok("mongo ids are frozen with their types",
   {"collection": "balances", "id": {"t": "int", "v": 7}} in manifest["delete"]["mongo"]
   and {"collection": "audit", "id": {"t": "str", "v": "aud1"}} in manifest["delete"]["mongo"]
   and {"collection": "staff", "id": {"t": "oid", "v": "a" * 24}} in manifest["delete"]["mongo"])
ok("storage: only the approved prefixes, with generation", {e["name"] for e in manifest["delete"]["storage"]}
   == {"kyc/a1/u2/id.jpg", "profileMedia/u1/p.jpg"} and all(e["generation"] == 1 for e in manifest["delete"]["storage"]))
ok("auth: every account including the Owner's, email masked",
   {e["uid"] for e in manifest["delete"]["auth"]} == {"o1", "u1", "u2"}
   and all("@" not in e["email"] or e["email"].startswith("o***@") for e in manifest["delete"]["auth"]))
ok("three samples per collection", len(manifest["samples"]["firestore"]["users"]) == 2
   and manifest["samples"]["auth"]["users"] == ["o1", "u1", "u2"])
ok("target, hosts, canary, backup reference and table fingerprint recorded",
   manifest["target"] == TARGET.as_dict() and manifest["mongo_hosts"] == ["cluster0.example.invalid"]
   and manifest["backup"]["sha256"] == C.sha256_file(BM) and manifest["table_fingerprint"] == T.table_fingerprint())
ok("totals", manifest["totals"]["delete"] == len(fsd) + 5 + 2 + 3)
wo = world(extra_fs={"users/ghost/fcmTokens/t9": {"_create_time": T0}})   # parent deleted, subcollection left behind
orphan = P.build_manifest(target=TARGET, fs=wo[0], mongo=wo[1], storage=wo[2], auth=wo[3], backup_manifest_path=BM,
                          canary_project=TARGET.project, now=NOW)
opaths = {e["path"] for e in orphan["delete"]["firestore"]}
ok("a subcollection under a phantom (missing) parent is frozen; the phantom itself is not listed",
   "users/ghost/fcmTokens/t9" in opaths and "users/ghost" not in opaths and orphan["counts"]["firestore"]["users"] == 2)
MPATH, MSHA = P.write_manifest(dict(manifest), RUN)
ok("manifest written with a timestamped name", MPATH.name.startswith("reset-manifest-") and MSHA == C.sha256_file(MPATH))
ok("render lists DELETE, KEEP rows", "KEEP" in P.render(manifest) and "DELETE" in P.render(manifest))

# Refusals
def plan_with(**kw):
    w = world(**{k: v for k, v in kw.items() if k.startswith("extra_")})
    return lambda: P.build_manifest(target=kw.get("target", TARGET), fs=w[0], mongo=w[1], storage=w[2], auth=w[3],
                                    backup_manifest_path=kw.get("bm", BM), canary_project=kw.get("canary", TARGET.project),
                                    now=kw.get("now", NOW))

refused("an unknown Firestore collection refuses", plan_with(extra_fs={"brandNew/x": {"_create_time": T0}}), "UNKNOWN")
refused("an unknown subcollection under a DELETE document refuses",
        plan_with(extra_fs={"users/u1/mystery/m1": {"_create_time": T0}}), "UNKNOWN")
refused("an unknown Mongo collection refuses", plan_with(extra_mongo={"brand_new": [{"_id": "x"}]}), "UNKNOWN")
refused("an unknown Storage prefix refuses", plan_with(extra_storage=[{"name": "weird/x.bin", "size": 1, "generation": 1}]), "UNKNOWN")
refused("an undecided Storage prefix refuses (owner decides)",
        plan_with(extra_storage=[{"name": "sellerDocs/s1/doc.pdf", "size": 1, "generation": 1}]), "UNDECIDED")
refused("a Mongo _id of an unsupported type refuses", plan_with(extra_mongo={"cards": [{"_id": 1.5}]}), "_id")
refused("a stale backup (older than one hour) refuses",
        plan_with(bm=backup_manifest(RUN / "stale.json", finished=NOW - timedelta(minutes=61))), "one hour")
refused("an unverified backup refuses", plan_with(bm=backup_manifest(RUN / "unverified.json", verified=False)), "verify")
refused("a dry-run backup refuses", plan_with(bm=backup_manifest(RUN / "dry.json", mode="dry-run")), "dry-run")
refused("a backup for another target refuses",
        plan_with(bm=backup_manifest(RUN / "other.json", target=C.Target("real-project-1", "other-bucket", "zipper"))), "mismatch")
refused("a missing canary refuses", plan_with(canary=""), "canary")
refused("a canary naming another project refuses", plan_with(canary="some-other-project"), "canary")
refused("a target whose Firestore project differs refuses",
        plan_with(target=C.Target("real-project-2", TARGET.bucket, TARGET.mongo_db),
                  bm=backup_manifest(RUN / "p2.json", target=C.Target("real-project-2", TARGET.bucket, TARGET.mongo_db)),
                  canary="real-project-2"), "project")
w = world()
w[2]._exists = False
refused("a bucket that does not exist refuses",
        lambda: P.build_manifest(target=TARGET, fs=w[0], mongo=w[1], storage=w[2], auth=w[3], backup_manifest_path=BM,
                                 canary_project=TARGET.project, now=NOW), "bucket")
unknown_manifest = dict(manifest, unknown=[{"store": "firestore", "name": "x", "count": 1, "samples": [], "why": "?"}])
refused("write_manifest refuses a manifest with unknowns and writes a diagnostic",
        lambda: P.write_manifest(unknown_manifest, RUN), "UNKNOWN")
ok("…the diagnostic file exists and carries no delete lists",
   any(p.name.startswith("reset-plan-refused-") and "delete" not in json.loads(p.read_text()) for p in RUN.iterdir()))

# ══════════════════════════════════════════════════════════════════════════════
print("3. Execute: exactly the manifest, freeze respected, idempotent")

MANIFEST = C.read_json(MPATH)
# A document, a Mongo row, an object and an account created AFTER the manifest.
fs, mongo, storage, auth = world(
    extra_fs={"users/u3-new": {"_create_time": LATER}, "users/u1/fcmTokens/t-new": {"_create_time": LATER}},
    extra_mongo={"audit": [{"_id": "aud1", "at": T0}, {"_id": "aud-new", "at": LATER}]},
    extra_storage=[{"name": "kyc/a1/u9/new.jpg", "size": 1, "updated": LATER, "time_created": LATER, "generation": 9}],
    extra_auth=[{"uid": "u-new", "email": None, "phone": "+10000000009", "created": LATER, "providers": ["phone"]}])
# …and one manifest id that was re-created after the freeze (same path, newer create time),
fs.docs["users/u2"] = {"name": "b-recreated", "_create_time": LATER}
# …and one Storage object replaced after the freeze (generation changed).
storage.objects["profileMedia/u1/p.jpg"]["generation"] = 2
storage.objects["profileMedia/u1/p.jpg"]["time_created"] = LATER

EXEC_NOW = NOW + timedelta(minutes=10)
sha, mtime = X.static_checks(MANIFEST, MPATH, TARGET, EXEC_NOW)
ok("static checks pass on a fresh, verified backup and matching target", sha == MSHA and mtime == NOW)
X.live_checks(MANIFEST, TARGET, fs=fs, mongo=mongo, storage=storage, canary_project=TARGET.project)
log = X.Log(RUN / "reset-log-test.jsonl")
summary = X.execute_manifest(manifest=MANIFEST, manifest_sha=sha, manifest_time=mtime, target=TARGET, fs=fs, mongo=mongo,
                             storage=storage, auth=auth, log=log, apply=True)
log.close()
ok("post-manifest Firestore docs survive", "users/u3-new" in fs.docs and "users/u1/fcmTokens/t-new" in fs.docs)
ok("a manifest path re-created after the freeze is skipped, not deleted",
   "users/u2" in fs.docs and summary["per_collection"]["firestore/users"]["skipped_newer"] == 1)
ok("pre-manifest Firestore docs are deleted, deepest first",
   "users/u1" not in fs.docs and "users/u1/fcmTokens/t1" not in fs.docs
   and fs.deleted.index("users/u1/fcmTokens/t1") < fs.deleted.index("users/u1"))
ok("post-manifest Mongo row survives; frozen rows deleted",
   mongo.count("audit") == 1 and mongo.colls["audit"][0]["_id"] == "aud-new" and mongo.count("staff") == 0
   and mongo.count("balances") == 0)
ok("KEEP Mongo collections untouched", mongo.count("rates") == 1 and mongo.count("ops_canary") == 1 and mongo.count("scheduled_runs") == 2)
ok("post-manifest Storage object survives; replaced object skipped by generation",
   "kyc/a1/u9/new.jpg" in storage.objects and "profileMedia/u1/p.jpg" in storage.objects
   and "kyc/a1/u2/id.jpg" not in storage.objects and summary["per_collection"]["storage/profileMedia"]["skipped_newer"] == 1)
ok("KEEP Storage untouched", "appBuilds/app-1.apk" in storage.objects and "contentAssets/x.png" in storage.objects)
ok("post-manifest Auth account survives; frozen accounts deleted",
   set(auth.users) == {"u-new"} and set(auth.deleted) == {"o1", "u1", "u2"})
ok("totals: nothing failed", summary["totals"]["failed"] == 0 and summary["totals"]["deleted"] > 0)
lines = [json.loads(ln) for ln in (RUN / "reset-log-test.jsonl").read_text().splitlines()]
ok("log: start carries the target and manifest sha; one line per id; finish totals",
   lines[0]["event"] == "start" and lines[0]["target"] == TARGET.as_dict() and lines[0]["manifest_sha256"] == sha
   and sum(1 for ln in lines if ln["event"] == "item") == MANIFEST["totals"]["delete"]
   and lines[-1]["event"] == "finish")
ok("log: per-collection counts attempted/deleted/skipped/failed", all(
    set(X.OUTCOMES) <= set(c) for c in summary["per_collection"].values()))

# Idempotent re-run: nothing new is deleted, everything already gone is reported as such.
fs_del, mg_del, st_del, au_del = list(fs.deleted), list(mongo.deleted), list(storage.deleted), list(auth.deleted)
log2 = X.Log(None)
summary2 = X.execute_manifest(manifest=MANIFEST, manifest_sha=sha, manifest_time=mtime, target=TARGET, fs=fs, mongo=mongo,
                              storage=storage, auth=auth, log=log2, apply=True)
ok("re-run deletes nothing new", (fs.deleted, mongo.deleted, storage.deleted, auth.deleted) == (fs_del, mg_del, st_del, au_del)
   and summary2["totals"]["deleted"] == 0 and summary2["totals"]["already_absent"] > 0)
ok("re-run still protects the post-manifest records", "users/u3-new" in fs.docs and "u-new" in auth.users)

# A failure is recorded and completed by the next run.
fs3, mongo3, storage3, auth3 = world()
fs3.fail_paths.add("users/u2")
auth3.fail_uids.add("u1")
mongo3.fail_ids.add("aud1")
log3 = X.Log(None)
s3 = X.execute_manifest(manifest=MANIFEST, manifest_sha=sha, manifest_time=mtime, target=TARGET, fs=fs3, mongo=mongo3,
                        storage=storage3, auth=auth3, log=log3, apply=True)
ok("failures are counted per collection with the error", s3["totals"]["failed"] == 3
   and s3["per_collection"]["auth/users"]["failed"] == 1 and s3["per_collection"]["mongo/audit"]["failed"] == 1
   and any(e["id"] == "users/u2" for e in s3["errors"]))
fs3.fail_paths.clear(); auth3.fail_uids.clear(); mongo3.fail_ids.clear()
s4 = X.execute_manifest(manifest=MANIFEST, manifest_sha=sha, manifest_time=mtime, target=TARGET, fs=fs3, mongo=mongo3,
                        storage=storage3, auth=auth3, log=X.Log(None), apply=True)
ok("the re-run completes exactly the failed ones", s4["totals"]["deleted"] == 3 and s4["totals"]["failed"] == 0
   and "users/u2" not in fs3.docs and "u1" not in auth3.users and mongo3.count("audit") == 0)

# Rehearsal deletes nothing.
fs5, mongo5, storage5, auth5 = world()
s5 = X.execute_manifest(manifest=MANIFEST, manifest_sha=sha, manifest_time=mtime, target=TARGET, fs=fs5, mongo=mongo5,
                        storage=storage5, auth=auth5, log=X.Log(None), apply=False)
ok("--rehearse classifies but deletes nothing", not fs5.deleted and not mongo5.deleted and not storage5.deleted
   and not auth5.deleted and s5["totals"]["deleted"] == MANIFEST["totals"]["delete"] and s5["mode"] == "rehearse")

# Refusals before anything is deleted.
refused("execute refuses a typed target that differs from the manifest",
        lambda: X.static_checks(MANIFEST, MPATH, C.Target("real-project-1", "another-bucket", "zipper"), EXEC_NOW), "mismatch")
refused("execute refuses when the backup is older than one hour at execute time",
        lambda: X.static_checks(MANIFEST, MPATH, TARGET, NOW + timedelta(minutes=45)), "one hour")
tampered = dict(MANIFEST, table_fingerprint="0" * 64)
refused("execute refuses a manifest planned under a different table", lambda: X.static_checks(tampered, MPATH, TARGET, EXEC_NOW), "classification")
refused("execute refuses a manifest with unknowns", lambda: X.static_checks(dict(MANIFEST, unknown=[{"x": 1}]), MPATH, TARGET, EXEC_NOW), "UNKNOWN")
refused("execute refuses a file that is not a reset manifest", lambda: X.static_checks({"kind": "x"}, MPATH, TARGET, EXEC_NOW), "not a reset manifest")
BM.write_text(BM.read_text() + "\n")   # the backup manifest changed after the plan
refused("execute refuses when the backup manifest changed since the plan", lambda: X.static_checks(MANIFEST, MPATH, TARGET, EXEC_NOW), "sha256")
backup_manifest(BM)
ok("…and passes again once it matches", X.static_checks(C.read_json(MPATH) | {"backup": {**MANIFEST["backup"], "sha256": C.sha256_file(BM)}}, MPATH, TARGET, EXEC_NOW)[1] == NOW)
w = world()
refused("execute refuses a live Firestore project that differs",
        lambda: X.live_checks(MANIFEST, TARGET, fs=FakeFirestore("other"), mongo=w[1], storage=w[2], canary_project=TARGET.project), "project")
refused("execute refuses different MongoDB hosts",
        lambda: X.live_checks(MANIFEST, TARGET, fs=w[0], mongo=FakeMongo("zipper", hosts=["elsewhere"]), storage=w[2], canary_project=TARGET.project), "hosts")
refused("execute refuses a different MongoDB database",
        lambda: X.live_checks(MANIFEST, TARGET, fs=w[0], mongo=FakeMongo("other"), storage=w[2], canary_project=TARGET.project), "database")
refused("execute refuses a missing canary",
        lambda: X.live_checks(MANIFEST, TARGET, fs=w[0], mongo=w[1], storage=w[2], canary_project=""), "canary")
refused("execute refuses a different bucket",
        lambda: X.live_checks(MANIFEST, TARGET, fs=w[0], mongo=w[1], storage=FakeStorage("other"), canary_project=TARGET.project), "bucket")
refused("execute refuses a demo- project id", lambda: C.validate_target("demo-zipper", "demo-zipper.appspot.com", "zipper", allow_demo=False), "demo-")
refused("a wrong typed project id is refused", lambda: C.require_typed_project("real-project-1", lambda _p: "real-project-2"), "typed")
refused("a closed stdin is a refusal, not an answer", lambda: C.require_typed_project("real-project-1", lambda _p: (_ for _ in ()).throw(EOFError())), "typed")
refused("a wrong sha prefix is refused", lambda: C.require_typed_sha_prefix(MSHA, lambda _p: "ffffffffffff"), "sha256")
refused("a too-short sha prefix is refused", lambda: C.require_typed_sha_prefix(MSHA, lambda _p: MSHA[:6]), "sha256")
C.require_typed_sha_prefix(MSHA, lambda _p: MSHA[:12].upper())
C.require_typed_project("real-project-1", lambda _p: " real-project-1 ")
ok("the right typed values pass", True)

# ══════════════════════════════════════════════════════════════════════════════
print("4. Seed: validation and the documents the backend expects")

GOOD = {"observer": {"name": "Obs", "email": "obs@zipper-test-domain.org", "phone": ""},
        "owners": [{"name": "One", "email": "one@zipper-test-domain.org", "phone": "+10000000011"},
                   {"name": "Two", "email": "Two@Zipper-Test-Domain.org", "phone": "+1 000 000 0012"},
                   {"name": "Three", "email": "three@zipper-test-domain.org", "phone": "+10000000013"}]}
spec = S.validate_seed(GOOD)
ok("a valid file parses; emails lower-cased, phone spaces stripped", spec.owners[1].email == "two@zipper-test-domain.org"
   and spec.owners[1].phone == "+10000000012" and spec.observer.email.startswith("obs@"))
refused("both `observer` and `observers` refused", lambda: S.validate_seed({**GOOD, "observers": [GOOD["observer"]]}), "both")
refused("two observers refused",
        lambda: S.validate_seed({"observers": [GOOD["observer"], {**GOOD["observer"], "email": "x@zipper-test-domain.org"}], "owners": GOOD["owners"]}), "ONE observer")
refused("no observer refused", lambda: S.validate_seed({"owners": GOOD["owners"]}), "ONE observer")
refused("a bad phone refused", lambda: S.validate_seed({**GOOD, "owners": [{**GOOD["owners"][0], "phone": "9876543210"}]}), "E.164")
refused("a missing owner phone refused", lambda: S.validate_seed({**GOOD, "owners": [{**GOOD["owners"][0], "phone": ""}]}), "phone")
refused("a bad email refused", lambda: S.validate_seed({**GOOD, "owners": [{**GOOD["owners"][0], "email": "not-an-email"}]}), "email")
refused("the example placeholder addresses are refused",
        lambda: S.validate_seed(json.loads((ROOT / "scripts" / "reset" / "seed-accounts.example.json").read_text())), "placeholder")
refused("a duplicate email refused", lambda: S.validate_seed({**GOOD, "owners": GOOD["owners"][:1] + GOOD["owners"][:1]}), "more than once")
refused("observer listed as an owner refused",
        lambda: S.validate_seed({**GOOD, "owners": GOOD["owners"][:2] + [{**GOOD["owners"][0], "email": GOOD["observer"]["email"]}]}), "more than once")
refused("a duplicate phone refused", lambda: S.validate_seed({**GOOD, "owners": GOOD["owners"][:2] + [{**GOOD["owners"][2], "phone": "+10000000011"}]}), "phone")
refused("no owners refused", lambda: S.validate_seed({**GOOD, "owners": []}), "owners")
refused("four owners refused", lambda: S.validate_seed({**GOOD, "owners": GOOD["owners"] + [{"name": "F", "email": "f@zipper-test-domain.org", "phone": "+10000000014"}]}), "more than 3")
refused("unexpected keys refused (nothing invented from a typo)", lambda: S.validate_seed({**GOOD, "ownerz": []}), "unexpected")
refused("a name that is empty is refused", lambda: S.validate_seed({**GOOD, "owners": [{**GOOD["owners"][0], "name": " "}]}), "name")

PERMS = S.superadmin_permissions()
ok("superadmin permissions come from app.core.roles (every permission)", len(PERMS) == 20 and PERMS[0] == "can_view_users")
docs = S.owner_documents(spec.owners[0], "uidA", NOW, permissions=PERMS, crm_id="ABCD2345")
ok("staff row: the fields services/staff.invite writes", docs["staff"]["set"] == {
    "uid": "uidA", "email": "one@zipper-test-domain.org", "name": "One", "phone": "+10000000011", "role": "owner",
    "team": None, "field_charge": None, "reports_to": None, "status": "active", "is_active": True, "updated_at": NOW}
   and docs["staff"]["set_on_insert"] == {"created_at": NOW, "created_by": "reset-seed"} and docs["staff"]["filter"] == {"email": "one@zipper-test-domain.org"})
ok("crmUsers: the fields crm_directory.mirror writes for a staff role", set(docs["crmUsers/uidA"]) == {
    "uid", "email", "name", "role", "phone", "permissions", "isActive", "createdBy", "dept", "fieldCharge",
    "reportsTo", "crmId", "createdAt", "lastLoginAt"} and docs["crmUsers/uidA"]["role"] == "superadmin"
   and docs["crmUsers/uidA"]["permissions"] == PERMS and docs["crmUsers/uidA"]["dept"] is None)
ok("crmUsers never carries a partner link, roles or roleStatus", not ({"agencyId", "sellerId", "roles", "roleStatus"} & set(docs["crmUsers/uidA"])))
ok("users: the created-document shape of _attach_app_identity", set(docs["users/uidA"]) == {
    "uid", "crmRole", "isAgent", "isSeller", "isOfficial", "lastSeen", "email", "phoneNumber", "phoneKey",
    "isProfileComplete", "createdAt", "createdVia", "name"} and docs["users/uidA"]["crmRole"] == "superadmin"
   and docs["users/uidA"]["phoneKey"] == "10000000011" and docs["users/uidA"]["isProfileComplete"] is False)
ok("verifiedIdentities keyed by the phone digits", "verifiedIdentities/10000000011" in docs
   and docs["verifiedIdentities/10000000011"]["roles"] == ["superadmin"])
ok("staffRoster: names only", set(docs["staffRoster/uidA"]) == {"uid", "name", "role", "dept", "isActive", "updatedAt"})
obs = S.observer_documents(spec.observer, NOW)
ok("observer: staff row only, synthetic uid, no crmUsers", list(obs) == ["staff"] and obs["staff"]["set"]["uid"] == f"observer:{spec.observer.email}"
   and obs["staff"]["set"]["role"] == "observer")

fsS = FakeFirestore(TARGET.project, {"appConfig/economy": {"beanToDiamondRate": 10, "giftRates": {"beanToInrRate": 0.02}, "weeklyMinPayoutInr": 2000}})
mgS, auS = FakeMongo("zipper"), FakeAuth()
out: list[str] = []
res = S.seed(spec, target=TARGET, fs=fsS, mongo=mgS, auth=auS, apply=True, password_mode="none", now=NOW, permissions=PERMS, printer=out.append)
ok("seed creates one Auth user per owner, none for the observer", len(auS.created) == 3 and auS.get_user_by_email(spec.observer.email) is None
   and all(c["password"] is None for c in auS.created))
ok("seed writes staff rows for 3 owners + observer", mgS.count("staff") == 4 and sum(1 for r in mgS.colls["staff"] if r["role"] == "observer") == 1)
ok("seed writes the four Firestore documents per owner", sum(1 for p in fsS.docs if p.startswith("crmUsers/")) == 3
   and sum(1 for p in fsS.docs if p.startswith("users/")) == 3 and sum(1 for p in fsS.docs if p.startswith("staffRoster/")) == 3
   and sum(1 for p in fsS.docs if p.startswith("verifiedIdentities/")) == 3)
ok("seed result: expected auth count and uids", res["auth_user_count_expected"] == 3 and len(res["owners"]) == 3 and not res["economy"]["missing"])
ok("seed output never prints a full email or phone", not any(re.search(r"[A-Za-z0-9._%+-]+@zipper-test-domain\.org", ln) for ln in out)
   and not any("+1000000001" in ln for ln in out))
res2 = S.seed(spec, target=TARGET, fs=fsS, mongo=mgS, auth=auS, apply=True, password_mode="none", now=NOW, permissions=PERMS, printer=out.append)
ok("seed is idempotent (existing accounts reused, no duplicates)", len(auS.created) == 3 and mgS.count("staff") == 4
   and all(o["auth"] == "existing" for o in res2["owners"]))
out2: list[str] = []
S.seed(spec, target=TARGET, fs=fsS, mongo=FakeMongo("zipper"), auth=FakeAuth(), apply=True, password_mode="random", now=NOW, permissions=PERMS, printer=out2.append)
ok("--password random prints a password once per created owner", sum(1 for ln in out2 if "PASSWORD (shown once" in ln) == 3)
auR = FakeAuth()
out3: list[str] = []
S.seed(spec, target=TARGET, fs=fsS, mongo=FakeMongo("zipper"), auth=auR, apply=True, password_mode="reset-link", now=NOW, permissions=PERMS, printer=out3.append)
ok("--password reset-link prints the link once per owner", len(auR.reset_links) == 3 and sum(1 for ln in out3 if "SET-PASSWORD LINK" in ln) == 3)
refused("seed refuses when an Auth account carries the observer's email",
        lambda: S.seed(spec, target=TARGET, fs=fsS, mongo=FakeMongo("zipper"),
                       auth=FakeAuth([{"uid": "z", "email": spec.observer.email, "phone": None, "created": NOW, "providers": []}]),
                       apply=True, password_mode="none", now=NOW, permissions=PERMS, printer=out.append), "Observer")
refused("seed refuses a phone held by a different account",
        lambda: S.seed(spec, target=TARGET, fs=fsS, mongo=FakeMongo("zipper"),
                       auth=FakeAuth([{"uid": "z", "email": "z@zipper-test-domain.org", "phone": "+10000000011", "created": NOW, "providers": []}]),
                       apply=True, password_mode="none", now=NOW, permissions=PERMS, printer=out.append), "different Auth account")
dry_auth, mgD = FakeAuth(), FakeMongo("zipper")
S.seed(spec, target=TARGET, fs=fsS, mongo=mgD, auth=dry_auth, apply=False, password_mode="none", now=NOW, permissions=PERMS, printer=out.append)
ok("dry run writes nothing", not dry_auth.created and mgD.count("staff") == 0)
vals, missing = S.economy_findings({"beanToDiamondRate": 0, "giftRates": {}})
ok("economy check names each missing/invalid rate", len(missing) == 3 and "beanToDiamondRate" in missing[0]
   and "giftRates.beanToInrRate" in missing[1] and "weeklyMinPayoutInr" in missing[2])
ok("economy check: missing document", S.economy_findings(None)[1] == ["appConfig/economy (document missing)"])

# ══════════════════════════════════════════════════════════════════════════════
print("5. Postcheck")

fsP, mgP, stP, auP = world(
    extra_fs={"users/u3-new": {"_create_time": LATER}},
    extra_auth=[{"uid": "u-new", "email": None, "phone": "+10000000009", "created": LATER, "providers": ["phone"]}])
X.execute_manifest(manifest=MANIFEST, manifest_sha=sha, manifest_time=mtime, target=TARGET, fs=fsP, mongo=mgP, storage=stP, auth=auP,
                   log=X.Log(None), apply=True)
seed_result = {"kind": C.SEED_RESULT_KIND, "auth_user_count_expected": 1, "owners": [{"uid": "u-new"}],
               "observer": {"email": "obs@zipper-test-domain.org"}}
pc = PC.postcheck(manifest=MANIFEST, seed_result=seed_result, target=TARGET, fs=fsP, mongo=mgP, storage=stP, auth=auP, now=LATER)
by = {(r["store"], r["name"], r["check"]): r for r in pc["rows"]}
ok("postcheck passes after a clean execute (post-manifest records reported, not failed)", pc["passed"], str([r for r in pc["rows"] if not r["ok"]]))
ok("post-manifest users doc is listed", by[("firestore", "users", "DELETE collection empty (pre-manifest)")]["post_manifest"] == ["u3-new"])
ok("KEEP counts compared", by[("firestore", "appConfig", "KEEP count unchanged")]["ok"] and by[("mongo", "scheduled_runs", "KEEP count unchanged")]["ok"]
   and by[("storage", "appBuilds", "KEEP prefix count unchanged")]["ok"])
ok("auth count compared with the seeded count", by[("auth", "users", "Auth user count == seeded count")]["ok"])
ok("render produces a table", "KEEP count unchanged" in PC.render(pc))
fsP.docs["users/u1"] = {"_create_time": T0}          # a frozen id reappears with an OLD create time
mgP.colls["rates"].append({"_id": "r2"})             # a KEEP collection changed
stP.objects["appBuilds/app-1.apk"]["generation"] = 1
auP.users["extra"] = {"uid": "extra", "email": None, "phone": None, "created": T0, "providers": []}
mgP.colls["brand_new"] = [{"_id": 1}]
pc2 = PC.postcheck(manifest=MANIFEST, seed_result=seed_result, target=TARGET, fs=fsP, mongo=mgP, storage=stP, auth=auP, now=LATER)
by2 = {(r["store"], r["name"], r["check"]): r for r in pc2["rows"]}
ok("postcheck fails on a surviving frozen id", not by2[("all", "frozen ids", "every frozen id is gone")]["ok"])
ok("postcheck fails on a changed KEEP count", not by2[("mongo", "rates", "KEEP count unchanged")]["ok"])
ok("postcheck fails on an unexpected Auth account", not by2[("auth", "users", "Auth user count == seeded count")]["ok"])
ok("postcheck reports a new, unclassified collection", not by2[("mongo", "brand_new", "NEW name since the plan — classify it")]["ok"] and not pc2["passed"])
refused("postcheck refuses a manifest for another target",
        lambda: PC.postcheck(manifest=MANIFEST, seed_result=None, target=C.Target("real-project-1", "b2", "zipper"), fs=fsP, mongo=mgP, storage=stP, auth=auP), "mismatch")

# ══════════════════════════════════════════════════════════════════════════════
print("6. Backup: dry run prints no secret; verify reads a real-shaped archive")

os.environ["MONGO_URI_TEST_RESET"] = "mongodb+srv://user:S3CRET-PASSWORD@cluster0.example.invalid/?retryWrites=true"
calls: list[list[str]] = []
printed: list[str] = []
_say = B.say
B.say = lambda *parts: printed.append(" ".join(str(p) for p in parts))  # type: ignore[assignment]
try:
    out_dir = TMP / "backup-dry"
    path = B.run_backup(TARGET, "backups-bucket", out_dir, execute=False, mongo_uri_env="MONGO_URI_TEST_RESET",
                        runner=lambda cmd: calls.append(cmd) or subprocess.CompletedProcess(cmd, 0, "", ""), now=NOW)
finally:
    B.say = _say  # type: ignore[assignment]
text = "\n".join(printed)
ok("dry run runs no command", not calls)
ok("dry run prints the gcloud export, mongodump and gsutil commands",
   "gcloud firestore export gs://backups-bucket/zipper-backups/firestore/" in text and "mongodump --config=" in text
   and "gsutil -m cp -r gs://real-project-1.appspot.com/kyc gs://backups-bucket/zipper-backups/storage/" in text)
ok("dry run never prints the connection string or its password", "S3CRET" not in text and "mongodb+srv" not in text)
dm = C.read_json(path)
ok("dry-run manifest is marked and unusable for a plan", dm["mode"] == "dry-run" and path.name == "backup-manifest.dry-run.json")
refused("verify refuses a dry-run manifest", lambda: B.verify_manifest(path, runner=lambda c: subprocess.CompletedProcess(c, 0, "", "")), "DRY RUN")
refused("mongo uri env must be a NAME, never a value", lambda: C.mongo_uri_from_env("mongodb://x"), "NAME")
refused("an unset uri env refuses", lambda: C.mongo_uri_from_env("MONGO_URI_DOES_NOT_EXIST_X"), "not set")
ok("mongo hosts are recorded without credentials", C.mongo_hosts(os.environ["MONGO_URI_TEST_RESET"]) == ["cluster0.example.invalid"])
cfg = B.write_mongo_config("mongodb://u:p@h/", str(TMP))
ok("the mongodump config file is 0600 and holds only the uri", oct(os.stat(cfg).st_mode & 0o777) == "0o600"
   and Path(cfg).read_text().startswith("uri: "))
os.remove(cfg)
ok("executed-run commands carry the typed project and never a default bucket",
   B.firestore_export_command(TARGET, "backups-bucket", "S")[-2] == "--project=real-project-1"
   and B.mongodump_command(TARGET, "/tmp/c.yaml", "/tmp/a.gz") == ["mongodump", "--config=/tmp/c.yaml", "--db=zipper", "--archive=/tmp/a.gz", "--gzip"])

# A real-shaped mongodump archive: magic + BSON header + collection metadata + terminator, gzipped.
def bson(doc: dict) -> bytes:
    body = b""
    for k, v in doc.items():
        key = k.encode() + b"\x00"
        if isinstance(v, str):
            s = v.encode() + b"\x00"
            body += b"\x02" + key + struct.pack("<i", len(s)) + s
        elif isinstance(v, bool):
            body += b"\x08" + key + (b"\x01" if v else b"\x00")
        elif isinstance(v, int):
            body += b"\x10" + key + struct.pack("<i", v)
        elif isinstance(v, dict):
            body += b"\x03" + key + bson(v)
        else:
            raise TypeError(k)
    return struct.pack("<i", len(body) + 5) + body + b"\x00"

def make_archive(path: Path, db: str = "zipper") -> None:
    raw = (B.ARCHIVE_MAGIC + bson({"concurrent_collections": 4, "version": "0.1", "server_version": "7.0.0", "tool_version": "100.9.4"})
           + bson({"db": db, "collection": "staff", "metadata": "{}", "size": 0, "type": "collection"})
           + bson({"db": db, "collection": "ledger", "metadata": "{}", "size": 0, "type": "collection"})
           + struct.pack("<i", -1) + b"\x00" * 64)
    with gzip.open(path, "wb") as fh:
        fh.write(raw)

hdr, metas = B.read_archive_prelude(io.BytesIO(B.ARCHIVE_MAGIC + bson({"tool_version": "t"}) + bson({"db": "zipper", "collection": "c"}) + struct.pack("<i", -1)))
ok("archive prelude parser reads header and namespaces", hdr["tool_version"] == "t" and metas[0]["collection"] == "c")
try:
    B.read_archive_prelude(io.BytesIO(b"not-an-archive-at-all"))
    ok("bad magic is refused", False)
except ValueError:
    ok("bad magic is refused", True)

exe_dir = TMP / "backup-exec"
exe_dir.mkdir()
archive = exe_dir / "mongo-zipper-S.archive.gz"
make_archive(archive)
inv = exe_dir / "storage-inventory-S.jsonl"
inv.write_text('{"name": "kyc/a/b/c.jpg"}\n{"name": "appBuilds/x.apk"}\n')
exec_manifest = {
    "kind": C.BACKUP_MANIFEST_KIND, "version": 1, "mode": "executed", "target": TARGET.as_dict(), "backup_bucket": "backups-bucket",
    "run_stamp": "S", "started": C.iso(NOW), "finished": C.iso(NOW),
    "firestore_export": {"uri": "gs://backups-bucket/zipper-backups/firestore/S/"},
    "mongo_dump": {"path": str(archive), "db": "zipper", "sha256": C.sha256_file(archive)},
    "storage": {"inventory_path": str(inv), "copy_uri": "gs://backups-bucket/zipper-backups/storage/S/", "object_count": 2,
                "copied_object_count_expected": 1},
    "artifacts": {str(archive): C.sha256_file(archive), str(inv): C.sha256_file(inv)}, "verify": None,
}
mp = exe_dir / "backup-manifest.json"
C.write_json(mp, exec_manifest)

def gs_runner(listing_ok=True, copy_count=1, restore_rc=0):
    def run(cmd: list[str]) -> subprocess.CompletedProcess:
        calls.append(cmd)
        if cmd[:2] == ["gsutil", "ls"] and "firestore" in cmd[-1]:
            out = ("gs://backups-bucket/zipper-backups/firestore/S/S.overall_export_metadata\n"
                   "gs://backups-bucket/zipper-backups/firestore/S/all_namespaces/all_kinds/output-0\n") if listing_ok else ""
            return subprocess.CompletedProcess(cmd, 0, out, "")
        if cmd[:2] == ["gsutil", "ls"]:
            return subprocess.CompletedProcess(cmd, 0, "".join(f"gs://backups-bucket/zipper-backups/storage/S/kyc/a/b/{i}.jpg\n" for i in range(copy_count)), "")
        if cmd[:2] == ["gsutil", "stat"]:
            return subprocess.CompletedProcess(cmd, 0, "Content-Length: 123", "")
        if cmd[0] == "mongorestore":
            return subprocess.CompletedProcess(cmd, restore_rc, "", "" if restore_rc == 0 else "Failed: archive corrupt")
        raise AssertionError(cmd)
    return run

calls.clear()
_say = B.say
B.say = lambda *parts: None  # type: ignore[assignment]
try:
    verified = B.verify_manifest(mp, runner=gs_runner(), which=lambda name: "/usr/bin/mongorestore", now=NOW)
    ok("verify passes and records the verdict in the manifest", verified["verify"]["passed"] is True
       and C.read_json(mp)["verify"]["passed"] is True and C.read_json(mp)["mongo_dump"]["namespaces"] == ["zipper.ledger", "zipper.staff"])
    ok("verify used gsutil ls/stat and mongorestore --dryRun (no uri on the command line)",
       any(c[:2] == ["gsutil", "stat"] for c in calls) and any(c[0] == "mongorestore" and "--dryRun" in c for c in calls)
       and not any("mongodb" in " ".join(c) for c in calls))
    C.write_json(mp, exec_manifest)
    verified2 = B.verify_manifest(mp, runner=gs_runner(), which=lambda name: None, now=NOW)
    ok("without mongorestore the archive is still listed and verify passes", verified2["verify"]["passed"]
       and verified2["mongo_dump"]["mongorestore_dry_run"]["status"] == "unavailable")
    C.write_json(mp, exec_manifest)
    refused("verify fails when the export metadata is not listed", lambda: B.verify_manifest(mp, runner=gs_runner(listing_ok=False), which=lambda n: None, now=NOW), "did not verify")
    ok("…and the failure is recorded in the manifest", C.read_json(mp)["verify"]["passed"] is False)
    C.write_json(mp, exec_manifest)
    refused("verify fails when the storage copy is short", lambda: B.verify_manifest(mp, runner=gs_runner(copy_count=0), which=lambda n: None, now=NOW), "did not verify")
    C.write_json(mp, exec_manifest)
    refused("verify fails when mongorestore --dryRun reports a bad archive", lambda: B.verify_manifest(mp, runner=gs_runner(restore_rc=1), which=lambda n: "/x", now=NOW), "did not verify")
    archive.write_bytes(archive.read_bytes() + b"garbage")
    C.write_json(mp, exec_manifest)
    refused("verify fails when the archive changed on disk", lambda: B.verify_manifest(mp, runner=gs_runner(), which=lambda n: None, now=NOW), "did not verify")
finally:
    B.say = _say  # type: ignore[assignment]
make_archive(archive)
C.write_json(mp, dict(exec_manifest, mongo_dump={**exec_manifest["mongo_dump"], "sha256": C.sha256_file(archive)},
                      artifacts={str(archive): C.sha256_file(archive), str(inv): C.sha256_file(inv)}))
refused("plan refuses a backup that verify has not stamped (verify: null)",
        lambda: C.check_backup_manifest(C.read_json(mp), TARGET, NOW), "verify")

# ══════════════════════════════════════════════════════════════════════════════
print("7. No module performs an unbounded delete")

RESET_DIR = ROOT / "scripts" / "reset"
sources = {p.name: p.read_text() for p in RESET_DIR.glob("*.py")}
forbidden = [r"delete_many\(", r"recursive_delete", r"\.drop\(", r"drop_collection", r"drop_database",
             r"delete_collection", r"\.where\([^)]*\)\.stream\(\)[^\n]*delete", r"collection_group\("]
for name, src in sources.items():
    for pat in forbidden:
        ok(f"{name}: no `{pat}`", re.search(pat, src) is None)
ok("live.delete_one filters on _id only", "delete_one({\"_id\": self._decode(id_spec)})" in sources["live.py"]
   and sources["live.py"].count(".delete_one(") == 1)
exec_src = sources["execute.py"]
ok("execute never lists users, blobs or collections to find targets",
   not re.search(r"list_users\(|list_objects\(|list_collections\(|list_docs\(|find_ids\(", exec_src.split('"""', 2)[2]))
ok("execute deletes only by explicit id/path", "delete_docs(chunk)" in exec_src and "delete_one(coll, id_spec)" in exec_src
   and "delete_object(name, " in exec_src and "delete_users(chunk)" in exec_src)
ok("no `listUsers + delete all` pattern anywhere", not any(re.search(r"iterate_all\(\)[^\n]*\n[^\n]*delete", s) for s in sources.values()))
ok("plan.py, postcheck.py and classification.py contain no delete call",
   all(not re.search(r"\.delete\w*\(", sources[n].split('"""', 2)[2]) for n in ("plan.py", "postcheck.py", "classification.py")))
ok("no module imports app.config / app.db / app.services or loads an env file",
   not any(re.search(r"^\s*(from|import)\s+app\.(config|db|services)|load_dotenv|open\([^)]*\.env", s, re.M)
           for s in sources.values()))
ok("seed takes the permission table from app.core.roles only",
   re.search(r"^\s*from app\.core\.roles import", sources["seed.py"], re.M) is not None
   and not re.search(r"^\s*(from|import)\s+app\.(?!core\.roles)", sources["seed.py"], re.M))
ok("no module prints a connection string", not any(re.search(r"(print|say)\([^)]*uri\b", s) for s in sources.values()))
ok("adapters cannot express an unbounded delete", "delete_many" not in sources["adapters.py"] and "delete_all" not in sources["adapters.py"])

old_exec = (ROOT / "scripts" / "execute_test_data_reset.py").read_text()
old_plan = (ROOT / "scripts" / "plan_test_data_reset.py").read_text()
ok("the old executor is marked superseded and refuses --apply", "SUPERSEDED" in old_exec[:1500] and "scripts/reset/" in old_exec[:1500]
   and "refuse" in old_exec.split('"""', 2)[2][:3000].lower() and '"--apply" in sys.argv' in old_exec)
ok("the old planner is marked superseded", "SUPERSEDED" in old_plan[:1500] and "scripts/reset/" in old_plan[:1500])
gitignore = (ROOT.parent / ".gitignore").read_text()
ok("seed-accounts.json and the run artifacts are gitignored",
   "backend/scripts/reset/seed-accounts.json" in gitignore and "backend/reset-runs/" in gitignore)
ok("the example seed file and runbook/launcher exist", (RESET_DIR / "seed-accounts.example.json").is_file()
   and (RESET_DIR / "RESET-RUNBOOK.md").is_file() and (RESET_DIR / "run-reset.command").is_file())
launcher = (RESET_DIR / "run-reset.command").read_text()
launcher_code = "\n".join(ln for ln in launcher.splitlines() if not ln.strip().startswith("#"))
ok("the launcher never sources .env, never calls the old scripts, and refuses demo- ids",
   not re.search(r"(^|\s)(source|\.)\s", launcher_code) and ".env" not in launcher_code
   and "execute_test_data_reset" not in launcher_code and "reset_test_data" not in launcher_code
   and "demo-" in launcher_code)
STEPS = ("backup run", "backup verify", "reset.plan", "--rehearse", "reset.execute", "--execute --password", "reset.postcheck")
positions = [launcher_code.rfind(s) for s in STEPS]
ok("the launcher chains every step in order and confirms each", all(p >= 0 for p in positions)
   and positions == sorted(positions) and launcher_code.count("confirm_step ") >= 7
   and "--validate-only" in launcher_code and launcher_code.find("--validate-only") < launcher_code.find("backup run"))

# ══════════════════════════════════════════════════════════════════════════════
if failures:
    print(f"\n{len(failures)} of {checks} checks FAILED:")
    for f in failures:
        print("  ✗", f)
    sys.exit(1)
print(f"\nAll {checks} reset-tooling checks passed.")
sys.exit(0)
