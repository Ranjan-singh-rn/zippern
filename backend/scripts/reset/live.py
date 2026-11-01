"""The real adapters. The ONLY module that imports an SDK, and it does so lazily.

Connections are built from the TYPED target and the TYPED credentials path —
never from `app.config`, `.env`, `.firebaserc` or a default bucket. Every
identifier the SDK reports back (the key's project, the Firestore client's
project, the bucket's existence, the MongoDB database's canary) is compared
with what was typed before anything else happens.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from scripts.reset.adapters import MONGO_CREATED_FIELDS
from scripts.reset.common import Refused, Target, credential_project, mongo_hosts, say

CANARY_COLLECTION = "ops_canary"
CANARY_ID = "target"
FIRESTORE_BATCH = 400
AUTH_BATCH = 1000


# ══════════════════════════════════════════════════════════════════════════════
#  Firebase (Firestore, Storage, Auth)
# ══════════════════════════════════════════════════════════════════════════════

class FirebaseSession:
    """One Admin app, named, for one typed target. Closed with `close()`."""

    def __init__(self, target: Target, credentials_path: str) -> None:
        import firebase_admin
        from firebase_admin import credentials

        key_project = credential_project(credentials_path)
        if key_project != target.project:
            raise Refused(f"the service-account key belongs to project {key_project!r}, "
                          f"not to --project {target.project!r}")
        cred = credentials.Certificate(credentials_path)
        self.target = target
        self.app = firebase_admin.initialize_app(
            cred, {"projectId": target.project, "storageBucket": target.bucket},
            name=f"zipper-reset-{id(self)}")
        if str(getattr(self.app, "project_id", "") or "") != target.project:
            raise Refused("the Firebase app resolved a different project than the one typed")
        say(f"firebase: project {target.project} (key project {key_project}), bucket {target.bucket}")

    def close(self) -> None:
        import firebase_admin

        try:
            firebase_admin.delete_app(self.app)
        except Exception:  # noqa: BLE001
            pass

    # ── Firestore ────────────────────────────────────────────────────────────

    def firestore(self) -> "LiveFirestore":
        return LiveFirestore(self)

    def storage(self) -> "LiveStorage":
        return LiveStorage(self)

    def auth(self) -> "LiveAuth":
        return LiveAuth(self)


class LiveFirestore:
    def __init__(self, session: FirebaseSession) -> None:
        from firebase_admin import firestore

        self._client = firestore.client(session.app)
        live_project = str(getattr(self._client, "project", "") or "")
        if live_project != session.target.project:
            raise Refused(f"the Firestore client is for project {live_project!r}, "
                          f"not {session.target.project!r}")
        self._project = live_project

    def project(self) -> str:
        return self._project

    def list_collections(self) -> list[str]:
        return sorted(c.id for c in self._client.collections())

    def list_docs(self, collection_path: str) -> list[tuple[str, dict]]:
        out = []
        for d in self._client.collection(collection_path).stream():
            fields = d.to_dict() or {}
            ct = getattr(d, "create_time", None)
            if ct is not None:
                fields["_create_time"] = ct
            out.append((d.id, fields))
        return out

    def list_doc_ids(self, collection_path: str) -> list[str]:
        # `list_documents()` is the ListDocuments RPC with show_missing: it also
        # returns a parent that was deleted while its subcollections stayed.
        return sorted(ref.id for ref in self._client.collection(collection_path).list_documents())

    def list_subcollections(self, doc_path: str) -> list[str]:
        return sorted(c.id for c in self._client.document(doc_path).collections())

    def get_doc(self, doc_path: str) -> dict | None:
        snap = self._client.document(doc_path).get()
        if not getattr(snap, "exists", False):
            return None
        fields = snap.to_dict() or {}
        ct = getattr(snap, "create_time", None)
        if ct is not None:
            fields["_create_time"] = ct
        return fields

    def count(self, collection_path: str) -> int:
        coll = self._client.collection(collection_path)
        try:
            result = coll.count().get()
            return int(result[0][0].value)
        except Exception:  # noqa: BLE001 — older servers/clients: count by streaming ids
            return sum(1 for _ in coll.select([]).stream())

    def delete_docs(self, doc_paths: list[str]) -> None:
        for i in range(0, len(doc_paths), FIRESTORE_BATCH):
            batch = self._client.batch()
            for path in doc_paths[i:i + FIRESTORE_BATCH]:
                batch.delete(self._client.document(path))
            batch.commit()

    def set_doc(self, doc_path: str, data: dict, merge: bool = True) -> None:
        self._client.document(doc_path).set(data, merge=merge)


class LiveStorage:
    def __init__(self, session: FirebaseSession) -> None:
        from firebase_admin import storage

        self._bucket = storage.bucket(session.target.bucket, app=session.app)
        self._name = session.target.bucket

    def bucket_name(self) -> str:
        return self._name

    def bucket_exists(self) -> bool:
        return bool(self._bucket.exists())

    @staticmethod
    def _info(blob: Any) -> dict:
        return {
            "name": blob.name, "size": int(blob.size or 0), "md5": blob.md5_hash,
            "updated": blob.updated, "time_created": blob.time_created,
            "generation": blob.generation,
        }

    def list_objects(self) -> list[dict]:
        return [self._info(b) for b in self._bucket.list_blobs()]

    def get_object(self, name: str) -> dict | None:
        blob = self._bucket.get_blob(name)
        return self._info(blob) if blob is not None else None

    def delete_object(self, name: str, generation: Any = None) -> None:
        blob = self._bucket.blob(name)
        if generation:
            blob.delete(if_generation_match=int(generation))
        else:
            blob.delete()


class LiveAuth:
    def __init__(self, session: FirebaseSession) -> None:
        from firebase_admin import auth

        self._auth = auth
        self._app = session.app

    @staticmethod
    def _info(u: Any) -> dict:
        meta = getattr(u, "user_metadata", None)
        created_ms = getattr(meta, "creation_timestamp", None) if meta else None
        created = (datetime.fromtimestamp(created_ms / 1000.0, tz=timezone.utc)
                   if isinstance(created_ms, (int, float)) and created_ms else None)
        return {
            "uid": u.uid, "email": u.email, "phone": u.phone_number, "created": created,
            "providers": [p.provider_id for p in (u.provider_data or [])],
            "email_verified": bool(getattr(u, "email_verified", False)),
            "disabled": bool(getattr(u, "disabled", False)),
        }

    def list_users(self) -> list[dict]:
        return [self._info(u) for u in self._auth.list_users(app=self._app).iterate_all()]

    def _lookup(self, fn, value: str) -> dict | None:
        try:
            return self._info(fn(value, app=self._app))
        except self._auth.UserNotFoundError:
            return None
        except ValueError:
            return None

    def get_user(self, uid: str) -> dict | None:
        return self._lookup(self._auth.get_user, uid)

    def get_user_by_email(self, email: str) -> dict | None:
        return self._lookup(self._auth.get_user_by_email, email)

    def get_user_by_phone(self, phone: str) -> dict | None:
        return self._lookup(self._auth.get_user_by_phone_number, phone)

    def delete_users(self, uids: list[str]) -> list[tuple[str, str]]:
        errors: list[tuple[str, str]] = []
        for i in range(0, len(uids), AUTH_BATCH):
            chunk = uids[i:i + AUTH_BATCH]
            result = self._auth.delete_users(chunk, app=self._app)
            for err in result.errors:
                errors.append((chunk[err.index], str(err.reason)))
        return errors

    def create_user(self, *, email: str, phone: str, display_name: str,
                    email_verified: bool, password: str | None) -> str:
        kwargs: dict[str, Any] = {"email": email, "display_name": display_name,
                                  "email_verified": email_verified}
        if phone:
            kwargs["phone_number"] = phone
        if password:
            kwargs["password"] = password
        return self._auth.create_user(app=self._app, **kwargs).uid

    def update_user(self, uid: str, **fields: Any) -> None:
        self._auth.update_user(uid, app=self._app, **fields)

    def generate_password_reset_link(self, email: str) -> str:
        return self._auth.generate_password_reset_link(email, app=self._app)


# ══════════════════════════════════════════════════════════════════════════════
#  MongoDB
# ══════════════════════════════════════════════════════════════════════════════

class LiveMongo:
    def __init__(self, uri: str, target: Target) -> None:
        import pymongo

        self._hosts = mongo_hosts(uri)
        self._client = pymongo.MongoClient(uri, tz_aware=True, serverSelectionTimeoutMS=20_000)
        self._client.admin.command("ping")
        self._db = self._client[target.mongo_db]
        self._name = target.mongo_db
        say(f"mongo: database {self._name} on {len(self._hosts)} host(s)")

    def close(self) -> None:
        self._client.close()

    def db_name(self) -> str:
        return self._name

    def hosts(self) -> list[str]:
        return list(self._hosts)

    def list_collections(self) -> list[str]:
        return sorted(self._db.list_collection_names())

    def find_ids(self, collection: str) -> list[dict]:
        projection = {"_id": 1, **{k: 1 for k in MONGO_CREATED_FIELDS}}
        return list(self._db[collection].find({}, projection))

    @staticmethod
    def _decode(id_spec: dict) -> Any:
        t, v = id_spec.get("t"), id_spec.get("v")
        if t == "oid":
            from bson import ObjectId

            return ObjectId(str(v))
        if t == "str":
            return str(v)
        if t == "int":
            return int(v)
        raise Refused(f"unsupported frozen _id spec {id_spec!r}")

    def find_one(self, collection: str, id_spec: dict) -> dict | None:
        return self._db[collection].find_one({"_id": self._decode(id_spec)})

    def count(self, collection: str) -> int:
        return int(self._db[collection].count_documents({}))

    def delete_one(self, collection: str, id_spec: dict) -> int:
        return int(self._db[collection].delete_one({"_id": self._decode(id_spec)}).deleted_count)

    def upsert(self, collection: str, filter_: dict, set_fields: dict, set_on_insert: dict) -> None:
        self._db[collection].update_one(
            filter_, {"$set": set_fields, "$setOnInsert": set_on_insert}, upsert=True)


def mongo_canary_project(mongo: Any) -> str:
    """The project named by `ops_canary/target`, or '' when absent/unreadable."""
    try:
        doc = mongo.find_one(CANARY_COLLECTION, {"t": "str", "v": CANARY_ID})
    except Exception:  # noqa: BLE001
        return ""
    return str((doc or {}).get("firebase_project_id") or "").strip()


def require_canary(mongo: Any, target: Target) -> None:
    named = mongo_canary_project(mongo)
    if named != target.project:
        raise Refused(
            f"the MongoDB database {target.mongo_db!r} has no data canary "
            f"({CANARY_COLLECTION}/{CANARY_ID} with firebase_project_id={target.project!r})"
            + (f"; it names {named!r}" if named else "")
            + ". Provision it deliberately (see RESET-RUNBOOK.md, step 0) so a database "
              "cannot be reset under the wrong project's name.")
