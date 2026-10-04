"""Appeals — contesting a ban, a suspension, or a report decision.

Every other moderation path in this system runs one way: somebody with
authority decides, and the person it happened to finds out. This is the return
path, and until it existed the product's honest description of a wrongful ban
was "email support@zipperlive.app and hope".

── WHO MAY RAISE ONE, AND WHY TWO KINDS OF RAISER ────────────────────────────

  the account itself   from the banned screen in the app. They are still
                       signed in — `isBanned` gates the product, not the
                       session — so they can write their own appeal and
                       nothing else.
  their agency         from the agency dashboard. An agency recruited the
                       host, is paid on their earnings, and usually knows the
                       context the reviewer does not: that the "scam" was a
                       gift the viewer later regretted, or that the person in
                       the report is a different host with a similar name.
                       An agency contesting a report against its own host is
                       the single most likely source of a correction.

Both write the appeal document directly, exactly as an agency writes a host
invitation directly. What neither can do is DECIDE one — that is this module,
on the server, audited, and it is the only thing that reverses anything.

── OVERTURNING IS NOT ONE ACT ────────────────────────────────────────────────

A report decision can produce four different consequences, and they do not
reverse the same way:

  ban             reversible here and now. The account is unbanned, audited as
                  an unban with the appeal id on it, and the device bans that
                  ban caused come off with it.
  suspend         also reversible here and now — and NOT by the same call. The
                  account is RESUMED, audited as `user.resumed`, and no device
                  is touched, because a suspension never barred one. Reversing
                  a suspension through unban is what used to happen and it
                  deleted device bans that belonged to somebody else's
                  decision.
  warn            the warning stays on the record and is marked overturned. A
                  deleted warning is a deleted fact; a warning that says "this
                  was appealed and withdrawn" is the truth.
  deduct          if the card has not been signed, it can be cancelled. If it
                  HAS been signed the beans are gone, and returning them is a
                  new movement of value that an owner has to sign — so this
                  module raises that credit rather than moving anything, and
                  says so.

So `decide_appeal` returns what it actually did AND what it could not do, and
the CRM shows both. An appeal that reads "overturned" while the beans are still
missing would be the same class of lie as a report marked actioned that banned
nobody.
"""

from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timezone
from typing import Any, Callable

from google.cloud.firestore_v1.base_query import BaseQuery, FieldFilter

from app.core import audit
from app.core.compat import StrEnum
from app.db import firebase
from app.services import users as users_svc

log = logging.getLogger(__name__)

APPEALS = "appeals"
REPORTS = "reports"
USERS = "users"

MAX_READ = 500


class AppealError(Exception):
    """Rejected by a rule. The message is safe to show the caller."""


class AppealNotFound(AppealError):
    pass


class AppealKind(StrEnum):
    #: The account is banned or suspended and says it should not be.
    BAN = "ban"
    #: A specific report decision is being contested as wrong or false.
    REPORT = "report"


class AppealStatus(StrEnum):
    PENDING = "pending"
    #: Reviewed, and the original decision stands.
    UPHELD = "upheld"
    #: Reviewed, and the original decision was wrong.
    OVERTURNED = "overturned"


class Action:
    """Audit action names this module adds."""

    APPEAL_UPHELD = "appeal.upheld"
    APPEAL_OVERTURNED = "appeal.overturned"


async def _fs(fn: Callable, *args, **kwargs):
    return await asyncio.to_thread(fn, *args, **kwargs)


def _ref(appeal_id: str):
    if not appeal_id or not appeal_id.strip():
        raise AppealError("An appeal id is required.")
    return firebase.firestore_client().collection(APPEALS).document(appeal_id.strip())


def _require_reason(reason: str) -> str:
    reason = (reason or "").strip()
    if len(reason) < 10:
        # Longer than the three characters every other decision asks for, and
        # deliberately. This one is read by the person it happened to: an
        # upheld appeal with "no" written on it tells them nothing and produces
        # a second appeal saying the same thing.
        raise AppealError(
            "Say why, in at least 10 characters. This is shown to the person "
            "who appealed — it is the whole answer they get."
        )
    return reason


# ── Reading the queue ─────────────────────────────────────────────────────────


async def list_appeals(
    status: str | None = None, limit: int = 100
) -> list[dict[str, Any]]:
    """Appeals, oldest first.

    Oldest first, unlike the report queue: a pending appeal is somebody locked
    out of the product while they wait, so the longest wait is the most urgent
    thing on the screen. A newest-first queue strands exactly the person with
    the strongest grievance.
    """
    col = firebase.firestore_client().collection(APPEALS)
    query = col
    if status:
        query = query.where(filter=FieldFilter("status", "==", str(status)))
    query = query.order_by("createdAt", direction=BaseQuery.ASCENDING).limit(
        min(limit, MAX_READ)
    )
    docs = await _fs(lambda: list(query.stream()))
    return [{"id": d.id, **(d.to_dict() or {})} for d in docs]


async def appeals_for_agency(agency_id: str, limit: int = 100) -> list[dict[str, Any]]:
    """Appeals an agency raised, so it can see what became of them."""
    if not agency_id or not agency_id.strip():
        raise AppealError("An agency id is required.")
    col = firebase.firestore_client().collection(APPEALS)
    query = (
        col.where(filter=FieldFilter("agencyId", "==", agency_id.strip()))
        .order_by("createdAt", direction=BaseQuery.DESCENDING)
        .limit(min(limit, MAX_READ))
    )
    docs = await _fs(lambda: list(query.stream()))
    return [{"id": d.id, **(d.to_dict() or {})} for d in docs]


# ── Reports against an agency's own hosts ─────────────────────────────────────


#: Firestore refuses an `in` filter with more than thirty values.
_IN_CHUNK = 30


async def reports_for_agency_hosts(
    agency_id: str, limit: int = 200
) -> list[dict[str, Any]]:
    """Every report filed against a host of this agency.

    This is what makes an agency able to contest one. It exists as an API call
    rather than a security rule because the question — "is the person this
    report names one of mine" — cannot be asked of the report document: a
    report carries a `targetUid` and nothing about agencies, and the answer
    lives on the user document it points at. A rule would need a `get()` per
    row and would still not satisfy a list query.

    So the hosts are resolved first and the reports are fetched by uid.
    """
    if not agency_id or not agency_id.strip():
        raise AppealError("An agency id is required.")

    fs = firebase.firestore_client()
    host_docs = await _fs(
        lambda: list(
            fs.collection(USERS)
            .where(filter=FieldFilter("agencyId", "==", agency_id.strip()))
            # A projection, not the whole user document: this loop only needs
            # the ids. `agencyId` rather than an empty field list because an
            # empty projection is not something every client version accepts,
            # and this field is on every document the filter can match.
            .select(["agencyId"])
            .limit(MAX_READ)
            .stream()
        )
    )
    uids = [d.id for d in host_docs]
    if not uids:
        return []

    out: list[dict[str, Any]] = []
    for i in range(0, len(uids), _IN_CHUNK):
        chunk = uids[i : i + _IN_CHUNK]
        docs = await _fs(
            lambda c=chunk: list(
                fs.collection(REPORTS)
                .where(filter=FieldFilter("targetUid", "in", c))
                .limit(MAX_READ)
                .stream()
            )
        )
        out.extend({"id": d.id, **(d.to_dict() or {})} for d in docs)
        if len(out) >= limit:
            break

    # Newest first, and tolerant of a document with no timestamp — an unsorted
    # report is still a report and must not be dropped by the sort.
    out.sort(key=lambda r: (r.get("createdAt") is None, r.get("createdAt")), reverse=True)
    return out[:limit]


# ── The decision ──────────────────────────────────────────────────────────────


async def decide_appeal(
    appeal_id: str, verdict: str, reason: str, actor: dict
) -> dict[str, Any]:
    """Uphold or overturn an appeal, and reverse what an overturn can reverse.

    Returns `reversed` — what actually changed — and `outstanding`, the things
    that could not be undone from here and need a separate act. Both are shown
    to the reviewer, because "overturned" on its own would imply the second
    list is empty.
    """
    reason = _require_reason(reason)

    try:
        verdict_enum = AppealStatus(verdict)
    except ValueError as exc:
        raise AppealError("A verdict must be 'upheld' or 'overturned'.") from exc
    if verdict_enum is AppealStatus.PENDING:
        raise AppealError("A verdict must be 'upheld' or 'overturned'.")

    ref = _ref(appeal_id)
    snap = await _fs(ref.get)
    if not snap.exists:
        raise AppealNotFound("No appeal with that id.")
    appeal = snap.to_dict() or {}

    status_before = appeal.get("status", str(AppealStatus.PENDING))
    if status_before != str(AppealStatus.PENDING):
        raise AppealError(f"This appeal was already {status_before}.")

    subject_uid = str(appeal.get("subjectUid") or "").strip()
    if not subject_uid:
        raise AppealError("This appeal does not name an account.")

    # Four eyes. Somebody who decided the original action cannot also decide
    # whether it was right — an appeal reviewed by its own author is a formality
    # with a paper trail, which is worse than no appeal process at all because
    # it looks like one.
    original_actor = str(appeal.get("originalDecidedBy") or "").strip()
    if original_actor and original_actor == str(actor.get("uid", "")):
        raise AppealError(
            "You made the decision being appealed, so you cannot decide the "
            "appeal. Someone else has to look at it."
        )

    reversed_acts: list[str] = []
    outstanding: list[str] = []
    outcome_audit_id: str | None = None

    if verdict_enum is AppealStatus.OVERTURNED:
        link = {"appeal_id": appeal_id, "appeal_kind": str(appeal.get("kind", ""))}

        # ── 1. The account itself ─────────────────────────────────────────
        #
        # Which restriction it is under decides which operation reverses it,
        # and they are NOT interchangeable. This used to call `unban_user` for
        # both, on the reasoning that a suspension IS a ban with a flag — true
        # of the account fields and false of everything else. Unbanning went on
        # to delete a `bannedDevices` record, which a suspension had never
        # created; so overturning a suspension released a handset that Ops had
        # barred for their own reasons, and the log recorded `user.unbanned`
        # against somebody who had never been banned.
        #
        # `restriction_of` is the service's own reader, including for documents
        # written before `accountState` carried a moderation value, so the two
        # modules cannot disagree about what an account currently is.
        try:
            user = await users_svc.load_user(subject_uid)
        except users_svc.UserNotFound:
            user = {}
            outstanding.append(
                "The account no longer exists, so nothing could be restored to it."
            )

        restriction = users_svc.restriction_of(user) if user else ""
        if restriction == str(users_svc.AccountState.SUSPENDED):
            resumed = await users_svc.resume_user(
                subject_uid, reason, actor, meta=link
            )
            outcome_audit_id = resumed.get("audit_id")
            reversed_acts.append(
                "The suspension was lifted and the account resumed. No device "
                "ban was touched — a suspension never placed one."
            )
        elif restriction == str(users_svc.AccountState.BANNED):
            unban = await users_svc.unban_user(subject_uid, reason, actor, meta=link)
            outcome_audit_id = unban.get("audit_id")
            reversed_acts.append("The account was unbanned.")
            for kept in unban.get("device_bans_kept") or []:
                # A ban lifted while a handset stays barred is exactly the case
                # the person will come back about, so it goes on `outstanding`
                # rather than being buried in the unban's own response.
                outstanding.append(
                    f"Device {kept.get('device_id')} stays barred — "
                    f"{kept.get('because')}. This account is still blocked on it."
                )
            if unban.get("devices_released"):
                reversed_acts.append(
                    f"{len(unban['devices_released'])} handset(s) barred by that "
                    "ban were released with it."
                )
        elif user:
            reversed_acts.append(
                "The account was under no restriction, so nothing was lifted."
            )

        # 2. The report, when this appeal contests one.
        report_id = str(appeal.get("reportId") or "").strip()
        if report_id:
            report_ref = firebase.firestore_client().collection(REPORTS).document(report_id)
            report_snap = await _fs(report_ref.get)
            if not report_snap.exists:
                outstanding.append("The report named by this appeal no longer exists.")
            else:
                report = report_snap.to_dict() or {}
                await _fs(
                    report_ref.update,
                    {
                        "status": "dismissed",
                        "overturnedByAppealId": appeal_id,
                        "overturnedBy": actor.get("uid", ""),
                        "overturnedByName": actor.get("name", ""),
                        "overturnedAt": datetime.now(timezone.utc),
                        "overturnReason": reason,
                    },
                )
                reversed_acts.append("The report was marked dismissed on appeal.")

                action_taken = str(report.get("actionTaken") or "")
                if action_taken == "warn":
                    # The warning is kept and marked. Deleting it would delete
                    # the fact that it happened, and the count it fed is used
                    # to judge repeat behaviour — a silently decremented
                    # counter is a record nobody can reconstruct.
                    outstanding.append(
                        "The warning stays on the record, marked as overturned. "
                        "It is no longer held against them."
                    )
                if action_taken == "deduct":
                    card_id = report.get("outcomeCardId")
                    outstanding.append(
                        "Beans were deducted by this decision. Returning them is a "
                        "movement of value, so raise a credit on the money board — "
                        f"the original card is {card_id or 'not recorded'}."
                    )

    now = datetime.now(timezone.utc)
    patch = {
        "status": str(verdict_enum),
        "decisionReason": reason,
        "decidedBy": actor.get("uid", ""),
        "decidedByName": actor.get("name", ""),
        "decidedByRole": str(actor.get("role", "")),
        "decidedAt": now,
        "outcomeAuditId": outcome_audit_id,
        "reversed": reversed_acts,
        "outstanding": outstanding,
    }
    await _fs(ref.update, patch)

    audit_id = await audit.record(
        actor=actor,
        action=(
            Action.APPEAL_OVERTURNED
            if verdict_enum is AppealStatus.OVERTURNED
            else Action.APPEAL_UPHELD
        ),
        subject_type="user",
        subject_id=subject_uid,
        reason=reason,
        before={"status": status_before},
        after={"status": str(verdict_enum)},
        meta={
            "appeal_id": appeal_id,
            "kind": str(appeal.get("kind", "")),
            "report_id": appeal.get("reportId"),
            "raised_by": appeal.get("raisedByUid"),
            "raised_by_role": appeal.get("raisedByRole"),
            "agency_id": appeal.get("agencyId"),
            "reversed": reversed_acts,
            "outstanding": outstanding,
        },
    )

    return {
        "appeal_id": appeal_id,
        "status": str(verdict_enum),
        "subject_uid": subject_uid,
        "reversed": reversed_acts,
        "outstanding": outstanding,
        "audit_id": audit_id,
    }
