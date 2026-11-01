"""Transfers between agencies: an admin requests, the Owner decides (C3 / B10).

── WHY THIS EXISTS ─────────────────────────────────────────────────────────

Moving a Host or a Sub-agency to another agency changes who is paid commission
on their earnings from then on. It used to happen only as a side effect of a
revocation with `transfer_to`, executed by whoever could revoke, with no Owner
approval, no Owner notice, and no way to move anybody without revoking
something first. Now a transfer is its own request: an admin who reviews
agencies (`can_approve_kyc`, or the Owner) files it with a reason, the Owners
are told, and only the Owner decides. Approving re-validates everything and
runs the EXISTING move helpers — `partner_ops._move_host` and the sub-agency
move revocation uses — so the move is exactly the one the platform already
makes. No balance and no ledger row moves: history keeps the agency it was
earned under (`meta.agency_id` on every commission row).

── THE DATA ────────────────────────────────────────────────────────────────

Mongo `transfer_requests`:

    { _id: "tr_<token>", kind: host | sub_agency, subject_id,
      from_agency_id, to_agency_id, note,
      status: pending | approved | rejected,
      requested_by: {uid, role}, requested_at,
      decision: {by_uid, note, at} | null }

One OPEN request per subject: `transfer_locks` with `_id = "<kind>:<subject_id>"`,
inserted when filed, deleted at the decision. No index is added — `_id` is the
lock.
"""

from __future__ import annotations

import asyncio
import logging
import secrets
from datetime import datetime, timezone
from typing import Any

from pymongo import ReturnDocument
from pymongo.errors import DuplicateKeyError

from app.core import audit
from app.core import roles as R
from app.core.roles import Permission
from app.db import firebase
from app.db.mongo import C, get_db
from app.services import notices

log = logging.getLogger(__name__)

TRANSFER_REQUESTS = "transfer_requests"
TRANSFER_LOCKS = "transfer_locks"

KINDS = ("host", "sub_agency")
NOTE_MIN = 10
NOTE_MAX = 2000
DECIDE_LEASE_SECONDS = 120

OWNER_ONLY_DECIDE = "Only the Owner can decide a transfer."

_LEAVING_STATES = frozenset({"deleted", "permanently_deactivated", "recovery_pending"})


class Act:
    REQUESTED = "transfer.requested"
    APPROVED = "transfer.approved"
    REJECTED = "transfer.rejected"


class TransferError(Exception):
    """Refused by a rule. The message is safe to show the caller."""

    status_code = 400


class TransferForbidden(TransferError):
    status_code = 403


class TransferNotFound(TransferError):
    status_code = 404


class TransferConflict(TransferError):
    status_code = 409


class TransferOutcomeUnknown(TransferError):
    """HT-2 — the move's outcome could not be established. 503."""

    status_code = 503


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(value: Any) -> str | None:
    isoformat = getattr(value, "isoformat", None)
    if callable(isoformat):
        try:
            return str(isoformat())
        except Exception:  # noqa: BLE001
            return None
    return value if isinstance(value, str) and value else None


def _moment(value: Any) -> float:
    ts = getattr(value, "timestamp", None)
    if callable(ts):
        try:
            return float(ts())
        except Exception:  # noqa: BLE001
            return 0.0
    return 0.0


def _who(actor: dict) -> dict:
    return {"uid": str(actor.get("uid", "")), "role": str(actor.get("role", ""))}


def _label(kind: str) -> str:
    return "Host" if kind == "host" else "Sub-agency"


def _require_note(note: str) -> str:
    text = (note or "").strip()
    if len(text) < NOTE_MIN:
        raise TransferError(
            f"Say why, in at least {NOTE_MIN} characters. The note is the record "
            "of this transfer."
        )
    return text[:NOTE_MAX]


def may_request(actor: dict) -> bool:
    """`can_approve_kyc`, or the Owner (who holds every capability anyway)."""
    role = (actor or {}).get("role")
    return R.is_owner_value(role) or R.has_permission(role, Permission.CAN_APPROVE_KYC)


def view(doc: dict) -> dict[str, Any]:
    decision = doc.get("decision") or None
    return {
        "id": str(doc.get("_id") or ""),
        "kind": str(doc.get("kind") or ""),
        "subject_id": str(doc.get("subject_id") or ""),
        "from_agency_id": str(doc.get("from_agency_id") or ""),
        "to_agency_id": str(doc.get("to_agency_id") or ""),
        "note": str(doc.get("note") or ""),
        "status": str(doc.get("status") or ""),
        "requested_by": doc.get("requested_by") or {},
        "requested_at": _iso(doc.get("requested_at")),
        "decision": (
            {**decision, "at": _iso(decision.get("at"))} if isinstance(decision, dict) else None
        ),
    }


def _live(row: dict | None, kind: str) -> bool:
    return (
        bool(row)
        and str(row.get("kind") or "") == kind
        and str(row.get("status") or "") == "approved"
        and bool(row.get("is_active", False))
    )


def _read_doc(collection: str, doc_id: str) -> dict | None:
    """Blocking — one Firestore document, or None."""
    snap = firebase.firestore_client().collection(collection).document(doc_id).get()
    if not getattr(snap, "exists", False):
        return None
    return snap.to_dict() or {}


def _read_roster_row(agency_id: str, uid: str) -> dict:
    """Blocking — the host's roster row under its current agency, or a bare one."""
    snap = (
        firebase.firestore_client()
        .collection("agencies").document(agency_id)
        .collection("agencyHosts").document(uid)
        .get()
    )
    row = (snap.to_dict() or {}) if getattr(snap, "exists", False) else {}
    row["uid"] = uid
    return row


async def _validate(kind: str, subject_id: str, to_agency_id: str, db) -> dict[str, Any]:
    """Everything a transfer needs to be true, read NOW. Returns the plan.

    Used when a request is filed and again when the Owner approves it, so a
    subject revoked, restricted or moved in between is refused at approval.
    """
    from app.services import partner_applications as apps  # local: apps imports partner_ops
    from app.services import partner_roles
    from app.services import users as users_svc

    if kind not in KINDS:
        raise TransferError("A transfer moves a Host or a Sub-agency.")
    subject_id = str(subject_id or "").strip()
    to_id = str(to_agency_id or "").strip()
    if not subject_id or not to_id:
        raise TransferError("Name who moves and the agency they move to.")
    to = await db[C.PARTNERS].find_one({"_id": to_id})

    if kind == "host":
        user = await asyncio.to_thread(_read_doc, "users", subject_id)
        if user is None:
            raise TransferError("There is no account with that id.")
        if apps.host_state(user) != "active":
            raise TransferError(
                "This account is not an active Host — a revoked Host is reinstated "
                "or applies, it is not transferred."
            )
        if users_svc.restriction_of(user) or str(user.get("accountState") or "") in _LEAVING_STATES:
            raise TransferError("This account is restricted, so its Host role cannot be transferred.")
        from_id = str(user.get("agencyId") or "").strip()
        if not from_id:
            raise TransferError("This Host has no current agency on record, so there is nothing to move from.")
        # The destination: a live MAIN agency, or a live Sub-agency under a live main agency.
        if _live(to, "agency"):
            pass
        elif _live(to, "sub_agency"):
            main = await db[C.PARTNERS].find_one({"_id": str((to or {}).get("parent_id") or "")})
            if not _live(main, "agency"):
                raise TransferError(
                    f"'{(to or {}).get('name') or to_id}' is a sub-agency whose main agency "
                    "is not active, so it cannot take a Host."
                )
        else:
            raise TransferError(
                f"'{(to or {}).get('name') or to_id}' is not an approved, active agency or "
                "sub-agency, so it cannot take a Host."
            )
        if await partner_roles.owner_uid_of(to, db=db) == subject_id:
            raise TransferError("A Host cannot be moved under their own agency.")
        roster = await asyncio.to_thread(_read_roster_row, from_id, subject_id)
        subject: dict[str, Any] = {"uid": subject_id, "name": str(user.get("name") or "")}
    else:
        sub = await db[C.PARTNERS].find_one({"_id": subject_id})
        if not sub or str(sub.get("kind") or "") != "sub_agency":
            raise TransferError("That is not a registered sub-agency.")
        if str(sub.get("status") or "") != "approved":
            raise TransferError(
                f"{sub.get('name') or subject_id} is {sub.get('status') or 'not approved'}; "
                "only an approved sub-agency can be transferred."
            )
        from_id = str(sub.get("parent_id") or "").strip()
        if not _live(to, "agency"):
            raise TransferError(
                f"'{(to or {}).get('name') or to_id}' is not an approved, active MAIN agency, "
                "so it cannot take a sub-agency."
            )
        if to_id == subject_id:
            raise TransferError("A sub-agency cannot be moved under itself.")
        roster = {}
        subject = {"id": subject_id, "name": str(sub.get("name") or "")}

    if to_id == from_id:
        raise TransferError("That is already the current agency. Choose a different one.")
    from_row = await db[C.PARTNERS].find_one({"_id": from_id}) if from_id else None
    names = await asyncio.to_thread(apps._current_agency_names, [from_id, to_id])
    return {
        "kind": kind,
        "subject": subject,
        "from_agency_id": from_id,
        "from_name": names.get(from_id) or str((from_row or {}).get("name") or ""),
        "to": to,
        "to_agency_id": to_id,
        "to_name": names.get(to_id) or str((to or {}).get("name") or ""),
        "roster_row": roster,
    }


async def request(
    kind: str, subject_id: str, to_agency_id: str, note: str, actor: dict
) -> dict[str, Any]:
    """File a transfer for the Owner to decide. Moves nothing."""
    from app.services import role_appeals  # local: the shared Owner-email helper

    if not may_request(actor):
        raise TransferForbidden("Your account cannot request transfers.")
    kind = str(kind or "").strip()
    text = _require_note(note)
    db = get_db()
    plan = await _validate(kind, subject_id, to_agency_id, db)
    subject_id = str(subject_id).strip()

    lock_id = f"{kind}:{subject_id}"
    request_id = "tr_" + secrets.token_urlsafe(12)
    now = _now()
    for _ in range(2):
        try:
            await db[TRANSFER_LOCKS].insert_one(
                {"_id": lock_id, "request_id": request_id, "created_at": now}
            )
            break
        except DuplicateKeyError:
            lock = await db[TRANSFER_LOCKS].find_one({"_id": lock_id}) or {}
            held = await db[TRANSFER_REQUESTS].find_one({"_id": str(lock.get("request_id") or "")})
            if held is not None and str(held.get("status") or "") == "pending":
                raise TransferConflict(
                    f"A transfer of this {_label(kind)} is already waiting for the Owner "
                    f"({held['_id']})."
                )
            if held is None and _now().timestamp() - _moment(lock.get("created_at")) < 30:
                raise TransferConflict("A transfer of this subject is being filed right now.")
            await db[TRANSFER_LOCKS].delete_one({"_id": lock_id, "request_id": lock.get("request_id")})
    else:
        raise TransferConflict("A transfer of this subject is being filed right now.")

    doc = {
        "_id": request_id,
        "kind": kind,
        "subject_id": subject_id,
        "from_agency_id": plan["from_agency_id"],
        "to_agency_id": plan["to_agency_id"],
        "note": text,
        "status": "pending",
        "requested_by": _who(actor),
        "requested_at": now,
        "decision": None,
    }
    try:
        await db[TRANSFER_REQUESTS].insert_one(doc)
    except Exception:
        await db[TRANSFER_LOCKS].delete_one({"_id": lock_id, "request_id": request_id})
        raise

    await audit.record(
        actor=actor,
        action=Act.REQUESTED,
        subject_type="transfer_request",
        subject_id=request_id,
        reason=text,
        before={"agency_id": plan["from_agency_id"]},
        after={"agency_id": plan["to_agency_id"], "status": "pending"},
        meta={"kind": kind, "subject_id": subject_id, "notify": "owners"},
    )
    email = await role_appeals.email_owners(
        kind="transfer.requested",
        subject=f"Transfer waiting for your decision: {_label(kind)} to {plan['to_name'] or plan['to_agency_id']}",
        title=f"A {_label(kind)} transfer is waiting for your decision",
        rows=[
            ("Request", request_id),
            (_label(kind), plan["subject"].get("name") or subject_id),
            ("From", plan["from_name"] or plan["from_agency_id"]),
            ("To", plan["to_name"] or plan["to_agency_id"]),
            ("Note", text),
            ("Requested by", str(actor.get("name") or actor.get("uid") or "")),
        ],
        dedupe_key=f"transfer.requested:{request_id}",
    )
    return {"request": view(doc), "owner_notified": {"audit": Act.REQUESTED, "email": email}}


async def list_requests(actor: dict, status: str = "open", limit: int = 200) -> dict[str, Any]:
    """`{"requests": [...]}`, oldest first."""
    if not may_request(actor):
        raise TransferForbidden("Your account cannot see transfer requests.")
    query: dict[str, Any] = {} if str(status or "open") == "all" else {"status": "pending"}
    rows = [r async for r in get_db()[TRANSFER_REQUESTS].find(query)]
    rows.sort(key=lambda r: _moment(r.get("requested_at")))
    return {"requests": [view(r) for r in rows[: max(1, min(int(limit), 500))]]}


def _move_id(req: dict) -> str:
    """HT-2 — the id a host move made for this request carries (`transferId` on the roster row)."""
    return f"transfer:{req.get('_id')}"


def _host_move_landed(req: dict) -> bool:
    """Blocking — HT-2: is THIS request's move already made?

    The Host is under the destination and the destination's roster row carries
    this request's move id — written in the same transaction as the move.
    """
    uid = str(req.get("subject_id") or "").strip()
    to_id = str(req.get("to_agency_id") or "").strip()
    if not uid or not to_id:
        return False
    client = firebase.firestore_client()
    user = client.collection("users").document(uid).get()
    if not getattr(user, "exists", False) or str((user.to_dict() or {}).get("agencyId") or "").strip() != to_id:
        return False
    row = client.collection("agencies").document(to_id).collection("agencyHosts").document(uid).get()
    return bool(getattr(row, "exists", False)) and (row.to_dict() or {}).get("transferId") == _move_id(req)


async def _record_landed_move(req: dict) -> dict:
    """HT-2 — the approval of a move that already landed: the Host is told; nothing moves."""
    from app.services import partner_applications as apps  # local: apps imports partner_ops

    uid = str(req.get("subject_id") or "")
    from_id = str(req.get("from_agency_id") or "")
    to_id = str(req.get("to_agency_id") or "")
    names = await asyncio.to_thread(apps._current_agency_names, [from_id, to_id])
    await notices.partner_transferred(uid, "host", from_id, names.get(from_id) or from_id, names.get(to_id) or to_id)
    return {"kind": "host", "subject_id": uid, "from": from_id, "to": to_id,
            "recorded_after_unconfirmed_move": True}


async def _execute(plan: dict, req: dict, note: str, actor: dict, now: datetime) -> dict:
    """Run the EXISTING move for this subject. No balance or ledger row moves."""
    from app.services import partner_ops  # local: partner_ops imports this module's peers

    from_id = plan["from_agency_id"]
    to_id = plan["to_agency_id"]
    if plan["kind"] == "host":
        uid = plan["subject"]["uid"]
        try:
            moved = await asyncio.to_thread(
                partner_ops._move_host, plan["roster_row"], from_id, to_id, now, move_id=_move_id(req)
            )
        except partner_ops.HostMoveContended as exc:
            # HT-1: Firestore aborted the move under contention and the host is
            # still under `from_id` (read again after the failure). 409: `decide`
            # releases its lease, the request stays pending, approve again.
            raise TransferConflict(
                "Another change to this host was being saved at the same moment, so the "
                "transfer was not made: the host is still under its agency. Approve it "
                "again — it cannot move the host twice."
            ) from exc
        except partner_ops.HostMoveOutcomeUnknown as exc:
            # HT-2: the database did not confirm the move and it is not visible,
            # but it may still land. 503, never "nothing changed": the request
            # stays pending, and approving again is safe (compare-and-set).
            raise TransferOutcomeUnknown(
                "The database did not confirm whether the host was moved. The request is "
                "still pending: approve it again — it cannot move the host twice, and a move "
                "that did happen is recognised and recorded."
            ) from exc
        if not moved:
            # FX-10: `_move_host` moves only a host still under `from_id`.
            raise TransferError("The host moved while this was being decided. Nothing was changed.")
        await notices.partner_transferred(uid, "host", from_id, plan["from_name"], plan["to_name"])
        return {"kind": "host", "subject_id": uid, "from": from_id, "to": to_id}
    sub_id = plan["subject"]["id"]
    moved = await partner_ops._move_sub_agency(
        sub_id, from_id, plan["from_name"], plan["to"], note, actor, now, expect_parent=from_id
    )
    if not moved:
        raise TransferError("The sub-agency moved while this was being decided. Nothing was changed.")
    return {"kind": "sub_agency", "subject_id": sub_id, "from": from_id, "to": to_id}


async def decide(request_id: str, approve: bool, note: str, actor: dict) -> dict[str, Any]:
    """The Owner approves (re-validated, then moved) or rejects. Anyone else: 403."""
    if not R.is_owner_value((actor or {}).get("role")):
        raise TransferForbidden(OWNER_ONLY_DECIDE)
    text = _require_note(note)
    db = get_db()
    req = await db[TRANSFER_REQUESTS].find_one({"_id": str(request_id or "").strip()})
    if req is None:
        raise TransferNotFound("No transfer request with that id.")
    if str(req.get("status") or "") != "pending":
        raise TransferConflict(f"This transfer was already {req.get('status')}.")
    lease_at = _moment(req.get("deciding_at"))
    if req.get("deciding_token") and lease_at and _now().timestamp() - lease_at < DECIDE_LEASE_SECONDS:
        raise TransferConflict("Another decision on this transfer is in progress. Reload it in a moment.")

    token = secrets.token_urlsafe(12)
    now = _now()
    claimed = await db[TRANSFER_REQUESTS].find_one_and_update(
        {"_id": req["_id"], "status": "pending", "deciding_token": req.get("deciding_token")},
        {"$set": {"deciding_token": token, "deciding_at": now}},
        return_document=ReturnDocument.AFTER,
    )
    if claimed is None:
        raise TransferConflict("This transfer changed while you were deciding it. Reload it.")

    kind = str(req.get("kind") or "")
    moved = None
    try:
        if approve and kind == "host" and await asyncio.to_thread(_host_move_landed, req):
            # HT-2: THIS request's move landed on an earlier approval whose answer
            # was lost (that approval said it could not be confirmed). Record it —
            # the approval, its audit and the Host's notice — and never move twice.
            # Validating it again would refuse it ("already the current agency")
            # and leave the request pending over a move that happened.
            moved = await _record_landed_move(req)
        elif approve:
            plan = await _validate(kind, str(req.get("subject_id") or ""), str(req.get("to_agency_id") or ""), db)
            if plan["from_agency_id"] != str(req.get("from_agency_id") or ""):
                raise TransferError(
                    f"The {_label(kind)} is no longer under the agency this transfer was "
                    "requested from. Nothing was changed — file a new request."
                )
            moved = await _execute(plan, req, text, actor, now)
        final = "approved" if approve else "rejected"
        updated = await db[TRANSFER_REQUESTS].find_one_and_update(
            {"_id": req["_id"], "deciding_token": token},
            {"$set": {"status": final, "decision": {"by_uid": str(actor.get("uid", "")),
                                                    "note": text, "at": now},
                      "deciding_token": None, "deciding_at": None}},
            return_document=ReturnDocument.AFTER,
        )
        if updated is None:
            raise TransferConflict("Another decision took this transfer over. Reload it.")
    except Exception:
        await db[TRANSFER_REQUESTS].update_one(
            {"_id": req["_id"], "deciding_token": token},
            {"$set": {"deciding_token": None, "deciding_at": None}},
        )
        raise

    await db[TRANSFER_LOCKS].delete_one(
        {"_id": f"{kind}:{req.get('subject_id')}", "request_id": req["_id"]}
    )
    await audit.record(
        actor=actor,
        action=Act.APPROVED if approve else Act.REJECTED,
        subject_type="transfer_request",
        subject_id=str(req["_id"]),
        reason=text,
        before={"status": "pending", "agency_id": req.get("from_agency_id")},
        after={"status": final,
               "agency_id": req.get("to_agency_id") if approve else req.get("from_agency_id")},
        meta={"kind": kind, "subject_id": req.get("subject_id"), "moved": moved,
              "balances_moved": False},
    )
    return {"request": view(updated), "moved": moved}
