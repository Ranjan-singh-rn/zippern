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
import secrets
from datetime import datetime, timezone
from typing import Any, Callable

from firebase_admin import firestore
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


APPEAL_CLAIM_CONTENDED = (
    "Another change to this appeal was being saved at the same moment, so it was "
    "not resolved. Nothing was changed — try again."
)


class AppealClaimContended(AppealError):
    """HT-1 — Firestore gave up on resolving an appeal under contention. Nothing was written.

    The same shape as `partner_ops.HostMoveContended`. `_auto_resolve_one`'s
    compare-and-set is one transaction; when Firestore aborts it
    (`firebase.is_transaction_contention`) no attempt committed, so the appeal
    is read once more: no longer pending → None, the documented "it had moved
    on" result; still pending → this. Every caller of `auto_resolve_pending`
    already treats an error as "left pending, logged" and never fails the
    unban, resume or decision it follows, so it does not reach a response.
    """


APPEAL_CLAIM_UNKNOWN = (
    "The database did not confirm whether this appeal was resolved. It is not shown "
    "as resolved here; the next unban or resume looks at it again."
)


class AppealClaimOutcomeUnknown(AppealError):
    """HT-2 — the claim's outcome could not be established, and it is not visible.

    A Firestore error other than ABORTED, after which the appeal was read again:
    not resolved by this claim, still pending. A commit can still land after the
    client stopped waiting, so this is not "nothing happened". Like
    `AppealClaimContended` it never reaches a response — the callers of
    `auto_resolve_pending` log it — and the next unban or resume claims again,
    recognising the claim if it did land.
    """


class AppealDecisionNotRecorded(AppealError):
    """HT-2 — the appeal's effects are committed, but the verdict is not recorded.

    The ban or suspension was lifted (or the report dismissed) under the
    decision lease, and the verdict's stamp could not be confirmed, twice. The
    lease is given back, so the appeal can be decided again at once — and
    safely: a restriction already lifted is found lifted and nothing is lifted
    twice. 409 ("not_applied") or 503 ("unknown").
    """

    def __init__(self, message: str, *, outcome: str) -> None:
        super().__init__(message)
        self.outcome = outcome
        self.status_code = 503 if outcome == "unknown" else 409


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
    #: The restriction was removed administratively, and nobody decided this
    #: appeal. NOT a verdict — see `VERDICTS` and `decide_appeal` below.
    #:
    #: It exists because the alternative was writing `overturned`, which asserts
    #: "a reviewer found the original decision wrong". An admin lifting a
    #: suspension early for unrelated reasons has found nothing of the sort, and
    #: a moderation record that says otherwise is the same class of untruth as a
    #: report marked actioned that banned nobody.
    RESOLVED = "resolved"


#: The two a reviewer may actually choose. `PENDING` is the starting state and
#: `RESOLVED` is written by the system, so neither is selectable — and both are
#: refused by `decide_appeal` rather than being absent from a type, because the
#: endpoint takes a string off the wire and the refusal has to be explicit.
VERDICTS: frozenset[AppealStatus] = frozenset(
    {AppealStatus.UPHELD, AppealStatus.OVERTURNED}
)


class Action:
    """Audit action names this module adds."""

    APPEAL_UPHELD = "appeal.upheld"
    APPEAL_OVERTURNED = "appeal.overturned"
    #: Deliberately NOT `appeal.overturned`. That name means a reviewer judged
    #: the original decision wrong; this one means nobody judged anything and
    #: the restriction simply went away. Conflating them in the audit log would
    #: make the two indistinguishable to whoever reads it next.
    APPEAL_AUTO_RESOLVED = "appeal.auto_resolved"


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

    # ── Only the two real verdicts, and the refusal is explicit ──────────────
    #
    # `AppealStatus` now has four members, and two of them are not choices a
    # reviewer gets to make: `pending` is where an appeal starts and `resolved`
    # is written by the system when a restriction is lifted administratively.
    #
    # Checked against `VERDICTS` rather than by excluding `PENDING` one value at
    # a time. The old form was `if verdict_enum is AppealStatus.PENDING`, which
    # was exhaustive when there were three members and silently stopped being so
    # the moment a fourth arrived — `resolved` would have parsed, passed, and
    # let a reviewer write it as though they had decided something.
    try:
        verdict_enum = AppealStatus(verdict)
    except ValueError as exc:
        raise AppealError("A verdict must be 'upheld' or 'overturned'.") from exc
    if verdict_enum not in VERDICTS:
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
    #
    # B29: the original decider is read from the RECORD of the decision, not
    # only from `originalDecidedBy` — a field no writer fills, so the check
    # compared against a blank and the moderator who banned could decide the
    # appeal. The account carries who restricted it (`bannedBy` /
    # `suspendedBy`, stamped by `users._stamp`), and a contested report
    # carries who decided it (`reviewedBy`).
    if str(actor.get("uid", "")).strip() in await _original_deciders(appeal, subject_uid):
        raise AppealError(
            "You made the decision being appealed, so you cannot decide the "
            "appeal. Someone else has to look at it."
        )

    # B40: claim the decision against the status read above BEFORE anything
    # is reversed — a lease taken in a transaction, so two reviewers deciding
    # at once cannot both act, and an overturn racing an uphold cannot lift a
    # ban the record then says was upheld. Released if the decision fails.
    try:
        lease = await _fs(
            firebase.claim_decision, ref,
            expected_status=str(AppealStatus.PENDING), actor_uid=str(actor.get("uid", "")),
            default_status=str(AppealStatus.PENDING),
        )
    except firebase.DecisionConflict as exc:
        raise AppealError(str(exc)) from exc
    try:
        return await _decide_under_lease(
            appeal_id, ref, lease, appeal, verdict_enum, status_before, subject_uid,
            reason, actor,
        )
    except Exception:
        await _fs(firebase.release_decision, ref, lease)
        raise


async def _original_deciders(appeal: dict, subject_uid: str) -> set[str]:
    """B29 — every uid that made the decision this appeal contests."""
    found = {str(appeal.get("originalDecidedBy") or "").strip()}
    try:
        user = await users_svc.load_user(subject_uid)
    except users_svc.UserNotFound:
        user = {}
    restriction = users_svc.restriction_of(user) if user else ""
    if restriction == str(users_svc.AccountState.BANNED):
        found.add(str(user.get("bannedBy") or "").strip())
    elif restriction == str(users_svc.AccountState.SUSPENDED):
        found.add(str(user.get("suspendedBy") or "").strip())
    report_id = str(appeal.get("reportId") or "").strip()
    if report_id:
        snap = await _fs(firebase.firestore_client().collection(REPORTS).document(report_id).get)
        if getattr(snap, "exists", False):
            found.add(str((snap.to_dict() or {}).get("reviewedBy") or "").strip())
    found.discard("")
    return found


async def _decide_under_lease(
    appeal_id: str, ref, lease: str, appeal: dict, verdict_enum: AppealStatus,
    status_before: str, subject_uid: str, reason: str, actor: dict,
) -> dict[str, Any]:
    """`decide_appeal`, from the moment its lease is held."""
    reversed_acts: list[str] = []
    outstanding: list[str] = []
    outcome_audit_id: str | None = None
    lifted = False

    # HT-2: an overturn of THIS appeal whose reversal was carried out but whose
    # verdict could not be recorded (`AppealDecisionNotRecorded`) left the
    # appeal pending over a lifted restriction. Its unban / resume is audited
    # with this appeal's id. Upholding now would record the opposite of what
    # happened; deciding it again as overturned records it — and counts the
    # restriction as lifted, so the person's other pending appeals are closed.
    lifted_earlier = [
        e for e in await audit.history_for("user", subject_uid)
        if e.get("action") in (audit.Action.USER_UNBANNED, audit.Action.USER_RESUMED)
        and str((e.get("meta") or {}).get("appeal_id") or "") == appeal_id
    ] if subject_uid else []
    if lifted_earlier and verdict_enum is AppealStatus.UPHELD:
        raise AppealError(
            "An earlier decision on this appeal already lifted the restriction, but the "
            "verdict was not recorded. Decide it as overturned to record what happened — "
            "upholding it now would contradict the account. Nothing was changed."
        )

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

        # ── `enforce_target_policy=False` on both restorations below ────────
        #
        # Overturning an appeal is RESTORATIVE: it lifts a restriction that
        # already exists. The target-protection guard refuses internal
        # identities and self-targeting, which is the right answer for somebody
        # pressing Ban in user management and the wrong one here — leaving it
        # on would mean a restriction that should never have been applied also
        # could never be lifted, trapping the account permanently.
        #
        # The reviewer's authority is checked by `decide_appeal` above (four
        # eyes, `CAN_APPROVE_KYC`), so this is not an unguarded path; it is a
        # guarded path whose guard is a different and more specific one.
        restriction = users_svc.restriction_of(user) if user else ""
        if restriction == str(users_svc.AccountState.SUSPENDED):
            resumed = await users_svc.resume_user(
                subject_uid, reason, actor, meta=link,
                enforce_target_policy=False,
            )
            outcome_audit_id = resumed.get("audit_id")
            lifted = True
            reversed_acts.append(
                "The suspension was lifted and the account resumed. No device "
                "ban was touched — a suspension never placed one."
            )
        elif restriction == str(users_svc.AccountState.BANNED):
            unban = await users_svc.unban_user(
                subject_uid, reason, actor, meta=link,
                enforce_target_policy=False,
            )
            outcome_audit_id = unban.get("audit_id")
            lifted = True
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
        elif user and lifted_earlier:
            lifted = True
            reversed_acts.append(
                "The restriction was already lifted by an earlier decision on this appeal "
                "that could not be recorded; nothing was lifted twice."
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
    # B40: stamped only while this decision's lease still holds and the appeal
    # is still pending — never over a verdict or a resolution made meanwhile.
    # HT-2: a verdict whose answer was lost is recognised (it used to come back
    # False, and the audit was skipped for a verdict that WAS recorded), and one
    # that could not be confirmed is stamped once more under the lease.
    try:
        stamped = await _fs(
            firebase.complete_decision_retry_once, ref, lease, patch,
            expected_status=str(AppealStatus.PENDING), default_status=str(AppealStatus.PENDING),
        )
    except firebase.DecisionNotRecorded as exc:
        raise AppealDecisionNotRecorded(
            "The appeal's decision was carried out"
            + (" (" + "; ".join(reversed_acts) + ")" if reversed_acts else "")
            + ", but the verdict could not be recorded: the database "
            + ("was busy." if exc.outcome == "not_applied" else "did not confirm it.")
            + " Decide it again to record it — nothing is lifted twice.",
            outcome=exc.outcome,
        ) from exc
    if not stamped:
        raise AppealError(
            "This appeal was decided or closed while it was being decided. Reload "
            "it and check what it says now."
        )

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

    # UGP review: an appeal from the public web form does not block the owner's
    # own, so a second appeal can be pending for this account. This overturn
    # has just lifted the restriction it was about; leaving the other pending
    # would have it decided later against a restriction that no longer exists.
    # It is closed the way an administrator's unban closes one — `resolved`,
    # no reviewer invented — with its own trigger and its own reason. The
    # appeal decided HERE is no longer pending, so it is not touched.
    also_resolved: list[str] = []
    if lifted:
        try:
            other = await auto_resolve_pending(
                subject_uid, actor, trigger="appeal_overturned",
                reason=OVERTURN_RESOLVE_REASON,
            )
        except Exception:  # noqa: BLE001 — the decision itself is made and recorded
            log.exception("appeal %s: other pending appeals not resolved", appeal_id)
            other = None
        if other:
            also_resolved = [other["appeal_id"], *other.get("also_resolved", [])]

    return {
        "appeal_id": appeal_id,
        "status": str(verdict_enum),
        "subject_uid": subject_uid,
        "reversed": reversed_acts,
        "outstanding": outstanding,
        "audit_id": audit_id,
        **({"also_resolved": also_resolved} if also_resolved else {}),
    }


# ── A restriction lifted by hand, with an appeal still waiting ───────────────

#: Written as the reason. The person reads this, so it says what happened
#: rather than what a reviewer thought, because no reviewer thought anything.
AUTO_RESOLVE_REASON = "Restriction manually removed by administrator."
#: The same, when the restriction was lifted by ANOTHER appeal being accepted.
OVERTURN_RESOLVE_REASON = "The restriction was lifted when another appeal for this account was accepted."


async def auto_resolve_pending(
    subject_uid: str, actor: dict, *, trigger: str, reason: str | None = None,
) -> dict[str, Any] | None:
    """Close a pending appeal because its restriction was lifted by an admin.

    Returns the resolution, or `None` when there was nothing pending — which is
    the ordinary case and is not an error.

    ── WHY THIS IS CALLED FROM THE ROUTER AND NOT FROM `unban_user` ──────────

    `unban_user` and `resume_user` have exactly three callers, and only one of
    them is an administrator acting by hand:

        routers/users.py   POST /{uid}/unban, /{uid}/resume   ← this one
        services/users.py  lift_expired_suspensions sweep     ← must NOT resolve
        services/appeals   decide_appeal's own reversal       ← must NOT resolve
                           (UGP review: AFTER an overturn has lifted the
                           restriction, `decide_appeal` calls this for any
                           OTHER appeal still pending — trigger
                           "appeal_overturned", its own reason. The appeal it
                           decided is no longer pending and is not touched.)

    Hooking the service would therefore need a runtime guard on `meta` to tell
    the three apart, and — decisively — `services/users` cannot import
    `services/appeals`, because `services/appeals` already imports
    `services/users`. That cycle is not worth a deferred import to dodge.

    Calling from the router instead makes the distinction STRUCTURAL rather
    than conditional: the sweep and the appeal path do not go through an HTTP
    endpoint, so they cannot reach this however it is later edited. The
    `meta.appeal_id` marker `decide_appeal` passes stays exactly as it was and
    is still what labels the audit entry; it simply is not load-bearing here.

    `trigger` is required and recorded. A future second admin path must name
    itself, which is the point — opting in is explicit, and nothing acquires
    this behaviour by accident.

    ── WHAT IT DELIBERATELY DOES NOT WRITE ──────────────────────────────────

    No `decidedBy`, no `decidedByName`, no `decidedByRole`. Those fields mean
    "a person reviewed this", and populating them with the admin who lifted the
    restriction would manufacture a reviewer who never read the appeal — and
    would quietly satisfy the four-eyes check the next time anybody looked.
    `resolvedBy` is a separate field for exactly that reason: it records who
    lifted the RESTRICTION, which is a different act.
    """
    uid = (subject_uid or "").strip()
    if not uid:
        return None

    client = firebase.firestore_client()
    # Same predicate as the duplicate-appeal rule: subjectUid + pending, with no
    # `kind` filter. Deliberately unchanged — a suspension appeal and a ban
    # appeal both carry kind 'ban', so a kind filter would separate nothing.
    #
    # UGP review: EVERY pending appeal, not the first. An appeal from the public
    # web form does not block the owner's own (anybody can file one naming the
    # account), so two can be pending together — and one left behind after the
    # restriction is lifted would wait forever, then be "decided" against a
    # restriction that no longer exists.
    query = (
        client.collection(APPEALS)
        .where(filter=FieldFilter("subjectUid", "==", uid))
        .where(filter=FieldFilter("status", "==", str(AppealStatus.PENDING)))
        .limit(10)
    )
    docs = await _fs(lambda: list(query.stream()))
    if not docs:
        # Nothing waiting. The overwhelmingly common case: most restrictions are
        # lifted without anybody having appealed.
        return None

    resolutions: list[dict[str, Any]] = []
    for snap in docs:
        one = await _auto_resolve_one(client, snap, uid, actor, trigger, reason or AUTO_RESOLVE_REASON)
        if one is not None:
            resolutions.append(one)
    if not resolutions:
        return None
    first = dict(resolutions[0])
    if len(resolutions) > 1:
        first["also_resolved"] = [r["appeal_id"] for r in resolutions[1:]]
    return first


async def _auto_resolve_one(
    client, snap, uid: str, actor: dict, trigger: str, reason: str,
) -> dict[str, Any] | None:
    """Resolve ONE pending appeal, compare-and-set. `None` when it had moved on.

    HT-1 / HT-2: the claim carries its own id (`resolvedClaimId`), and the
    transaction recognises it first, so a claim whose answer was lost is
    reported as the resolution it is — it used to come back None, with no audit
    entry for an appeal it HAD resolved. After a Firestore error the appeal is
    read again: resolved by this claim → resolved; resolved or decided by
    somebody else → None; still pending → `AppealClaimContended` (aborted) or
    `AppealClaimOutcomeUnknown`. An error of the transaction's own code is
    re-raised unchanged.
    """
    appeal = snap.to_dict() or {}

    now = datetime.now(timezone.utc)
    claim_id = secrets.token_urlsafe(12)
    patch = {
        "status": str(AppealStatus.RESOLVED),
        "decisionReason": reason,
        # Who lifted the restriction — NOT who decided the appeal.
        "resolvedBy": actor.get("uid", ""),
        "resolvedByName": actor.get("name", ""),
        "resolvedByRole": str(actor.get("role", "")),
        "resolvedAt": now,
        "resolvedTrigger": trigger,
        "autoResolved": True,
        # HT-2: this claim's id, so a claim that landed can be told from one
        # that did not (appeals are written by the server only).
        "resolvedClaimId": claim_id,
    }

    # ── Idempotent, and that is a correctness requirement, not a nicety ──────
    #
    # Unban is repeatable from the CRM. Without the guard, a second press would
    # overwrite `resolvedAt`, write a second audit entry, and make one event
    # look like two in the record. The compare-and-set makes the second call a
    # no-op: the transaction re-reads inside the lock and bails if anything has
    # already moved the status off `pending`.
    #
    # This also closes the race between two admins pressing Unban at once, and
    # the narrower one between this and a reviewer deciding the same appeal in
    # the CRM at the same moment — whichever transaction commits first wins, and
    # the loser writes nothing.
    # Same shape as `firebase.debit_host_beans`: the decorator is the
    # module-level `firestore.transactional`, and the transaction object is
    # passed in from `client.transaction()`.
    ref = snap.reference

    def _state(fresh) -> str:
        if not getattr(fresh, "exists", False):
            return "gone"
        data = fresh.to_dict() or {}
        if data.get("resolvedClaimId") == claim_id and data.get("status") == str(AppealStatus.RESOLVED):
            return "ours"
        return "pending" if data.get("status") == str(AppealStatus.PENDING) else "moved"

    @firestore.transactional
    def _claim(transaction) -> bool:
        state = _state(ref.get(transaction=transaction))
        if state == "ours":
            return True  # HT-2: an earlier attempt of this claim committed
        if state != "pending":
            return False
        transaction.update(ref, patch)
        return True

    try:
        claimed = await _fs(lambda: _claim(client.transaction()))
    except Exception as exc:
        kind = firebase.transaction_error_kind(exc)
        if kind is None:
            raise
        # HT-1 / HT-2: which documented result applies? The error does not say.
        log.warning("appeal %s: the claim failed (%s); reading it again", snap.id, exc)
        try:
            state = _state(await _fs(ref.get))
        except Exception:  # noqa: BLE001 — what is known is reported below
            log.exception("appeal %s: could not re-read it after the failed claim", snap.id)
            raise AppealClaimOutcomeUnknown(APPEAL_CLAIM_UNKNOWN) from exc
        if state in ("moved", "gone"):
            return None  # somebody else resolved or decided it: the compare-and-set result
        if state == "pending":
            if kind == "contended":
                raise AppealClaimContended(APPEAL_CLAIM_CONTENDED) from exc
            raise AppealClaimOutcomeUnknown(APPEAL_CLAIM_UNKNOWN) from exc
        claimed = True  # "ours": the claim landed; its answer was lost
    if not claimed:
        return None

    audit_id = await audit.record(
        actor=actor,
        action=Action.APPEAL_AUTO_RESOLVED,
        subject_type="appeal",
        subject_id=snap.id,
        reason=reason,
        before={"status": str(AppealStatus.PENDING)},
        after={"status": str(AppealStatus.RESOLVED)},
        meta={
            "appeal_id": snap.id,
            "subject_uid": uid,
            "kind": str(appeal.get("kind", "")),
            "trigger": trigger,
            "raised_by": appeal.get("raisedByUid"),
            "source": str(appeal.get("source", "") or "app"),
            # Stated so the log cannot be misread as a verdict.
            "reviewed": False,
        },
    )

    log.info(
        "appeal %s auto-resolved for %s by %s (%s)",
        snap.id, uid, actor.get("uid", ""), trigger,
    )
    return {
        "appeal_id": snap.id,
        "status": str(AppealStatus.RESOLVED),
        "subject_uid": uid,
        "audit_id": audit_id,
    }
