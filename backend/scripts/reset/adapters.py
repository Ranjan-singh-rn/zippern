"""The narrow interfaces the reset tooling talks to. `live.py` implements them on
the real SDKs; `tests/test_reset_tooling.py` implements them in memory.

Every delete takes EXPLICIT ids. No adapter offers "delete a collection",
"delete a query" or "delete everything": the interface cannot express an
unbounded delete, so no caller can perform one.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any, Protocol


class FirestoreAdapter(Protocol):
    def project(self) -> str: ...
    def list_collections(self) -> list[str]:
        """Top-level collection ids."""
    def list_docs(self, collection_path: str) -> list[tuple[str, dict]]:
        """(document id, fields) for every EXISTING document in `collection_path`
        (`users` or `users/u1/fcmTokens`)."""
    def list_doc_ids(self, collection_path: str) -> list[str]:
        """Every document id in `collection_path`, INCLUDING "missing" parents
        that exist only because a subcollection hangs off them."""
    def list_subcollections(self, doc_path: str) -> list[str]: ...
    def get_doc(self, doc_path: str) -> dict | None:
        """Fields, plus `_create_time` (datetime) when the server reports it. None if missing."""
    def count(self, collection_path: str) -> int: ...
    def delete_docs(self, doc_paths: list[str]) -> None:
        """Delete exactly these documents (batched). Missing ones are no-ops."""
    def set_doc(self, doc_path: str, data: dict, merge: bool = True) -> None: ...


class MongoAdapter(Protocol):
    def db_name(self) -> str: ...
    def hosts(self) -> list[str]: ...
    def list_collections(self) -> list[str]: ...
    def find_ids(self, collection: str) -> list[dict]:
        """Every document's `_id` plus any creation-time fields (a projection)."""
    def find_one(self, collection: str, id_spec: dict) -> dict | None: ...
    def count(self, collection: str) -> int: ...
    def delete_one(self, collection: str, id_spec: dict) -> int:
        """Delete the ONE document with this `_id`. Returns 0 or 1."""
    def upsert(self, collection: str, filter_: dict, set_fields: dict, set_on_insert: dict) -> None: ...


class StorageAdapter(Protocol):
    def bucket_name(self) -> str: ...
    def bucket_exists(self) -> bool: ...
    def list_objects(self) -> list[dict]:
        """{name, size, md5, updated, time_created, generation} for every object."""
    def get_object(self, name: str) -> dict | None: ...
    def delete_object(self, name: str, generation: Any = None) -> None: ...


class AuthAdapter(Protocol):
    def list_users(self) -> list[dict]:
        """{uid, email, phone, created (datetime|None), providers (list[str])}."""
    def get_user(self, uid: str) -> dict | None: ...
    def get_user_by_email(self, email: str) -> dict | None: ...
    def get_user_by_phone(self, phone: str) -> dict | None: ...
    def delete_users(self, uids: list[str]) -> list[tuple[str, str]]:
        """Delete exactly these uids. Returns (uid, error) for each failure."""
    def create_user(self, *, email: str, phone: str, display_name: str,
                    email_verified: bool, password: str | None) -> str: ...
    def update_user(self, uid: str, **fields: Any) -> None: ...
    def generate_password_reset_link(self, email: str) -> str: ...


def encode_mongo_id(value: Any) -> dict:
    """A JSON-safe, round-trippable `_id`. Refuses shapes it cannot restore exactly."""
    name = type(value).__name__
    if name == "ObjectId":
        return {"t": "oid", "v": str(value)}
    if isinstance(value, bool):
        raise ValueError("a boolean _id cannot be frozen")
    if isinstance(value, str):
        return {"t": "str", "v": value}
    if isinstance(value, int):
        return {"t": "int", "v": value}
    raise ValueError(f"unsupported _id type {name}; not frozen (never guessed)")


def creation_time_of(fields: dict, *candidates: str) -> datetime | None:
    """The earliest usable creation-time field among `candidates`, else None."""
    from scripts.reset.common import as_datetime

    found = [dt for dt in (as_datetime(fields.get(k)) for k in candidates if k in fields) if dt]
    return min(found) if found else None


FIRESTORE_CREATED_FIELDS = ("createdAt", "created_at", "createdAtMs", "timestamp", "created")
MONGO_CREATED_FIELDS = ("created_at", "createdAt", "at", "queued_at", "started_at", "generated_at",
                        "played_at", "detected_at", "flagged_at", "issued_at", "requested_at")
