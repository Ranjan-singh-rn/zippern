"""Composed email — the HTTP surface of `services/broadcast.py`. Spec 8A.7.2.

**Why this is not in `notifications.py`.** That router opens by stating an
invariant it keeps everywhere: *"Recipients are never taken from a request. No
endpoint here accepts an address to send to."* A composed message cannot keep
that invariant literally — a customer-care reply is, definitionally, a reply to
an address somebody typed. Rather than weaken a rule that thirty other routes
rely on, the exception lives in its own file where a reviewer sees it, with its
own narrower rule in place of the one it cannot keep:

    An address in a request is not a recipient until it has been **found** on a
    real record — the staff collection in Mongo, an agency or seller
    registration in Firestore, or an app user's profile. An address on none of
    them is refused. See `broadcast._find_person`.

Everything else about a composed send is the same machinery as a payout receipt:
one row per recipient in `email_deliveries`, `email.prepare_attachments` for the
files, `email.may_receive` at the moment of sending, and the bounce webhook
rewriting the outcome afterwards. `/tech/email?kind=broadcast.<id>` is the
record of one send.

Three routes and nothing else:

  * `GET /audiences` — what can be sent to, and what *this* account may send to.
  * `GET /audience` — the count and a sample, sending nothing. The last chance
    to notice the audience is wrong.
  * `POST /email` — the send. Audited, with a mandatory reason and the resolved
    audience recorded address by address.
"""

from __future__ import annotations

import base64
import binascii

from fastapi import APIRouter, Body, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field

from app.config import settings
from app.core.deps import require_write
from app.services import broadcast
from app.services import email as mail

router = APIRouter(prefix="/broadcasts", tags=["broadcasts"])


def _refuse(exc: broadcast.BroadcastError) -> HTTPException:
    """One refusal, one status code, and the service's own words for it.

    The message is written for the person reading it and is shown verbatim by
    the CRM — nothing here paraphrases a refusal into "Request failed".
    """
    code = (
        status.HTTP_403_FORBIDDEN
        if isinstance(exc, broadcast.NotAuthorised)
        else status.HTTP_400_BAD_REQUEST
    )
    return HTTPException(status_code=code, detail=str(exc))


# ══════════════════════════════════════════════════════════════════════════════
#  What can be sent, and by whom
# ══════════════════════════════════════════════════════════════════════════════


@router.get("/audiences")
async def audiences(user: dict = Depends(require_write)):
    """The catalogue: every audience, who may send to it, and whether you may.

    Answered for the caller rather than in the abstract, so the composer can
    grey out an audience with the reason attached instead of offering it and
    then refusing the send.
    """
    out = []
    for audience in broadcast.Audience:
        allowed, why = broadcast.authority_for(audience)
        try:
            broadcast.check_authority(user, audience)
            may, refusal = True, ""
        except broadcast.NotAuthorised as exc:
            may, refusal = False, str(exc)
        out.append(
            {
                "audience": str(audience),
                "label": broadcast.audience_label(audience, "<an address>"),
                "needs_address": audience is broadcast.Audience.PERSON,
                "may_send": may,
                "refusal": refusal,
                "allowed_roles": sorted(str(r) for r in allowed),
                "why": why,
            }
        )
    return {
        "audiences": out,
        "sender_identities": [
            {
                "identity": str(identity),
                "from": mail.sender_for(identity)[0],
                "from_name": mail.sender_for(identity)[1],
                "reply_to": mail.sender_for(identity)[2],
                "alignment": mail.sender_alignment(identity),
            }
            for identity in mail.SenderIdentity
        ],
        "limits": {
            "max_recipients": int(settings.broadcast_max_recipients),
            "confirm_above": int(settings.broadcast_confirm_above),
            "max_subject_chars": broadcast.MAX_SUBJECT_CHARS,
            "max_body_chars": broadcast.MAX_BODY_CHARS,
            "max_attachment_bytes": int(settings.email_max_attachment_bytes),
            "max_total_attachment_bytes": int(
                settings.email_max_total_attachment_bytes
            ),
        },
        "unsubscribe": {
            "stream": broadcast.STREAM,
            "note": (
                "Every composed message carries List-Unsubscribe and is sent as "
                "bulk mail. An address that has opted out is left out of every "
                "audience, including a send to one named person, and gets an "
                "'unsubscribed_local' row in the delivery log saying so."
            ),
        },
    }


@router.get("/audience")
async def preview_audience(
    audience: str = Query(
        ...,
        description=(
            "'all_agencies', 'all_sellers', 'all_users', or "
            "'person:<email address>'."
        ),
    ),
    sample: int = Query(default=25, ge=1, le=100),
    user: dict = Depends(require_write),
):
    """Who this audience resolves to right now. Sends nothing, records nothing.

    **The count here is the control.** Sending to every app user cannot be
    undone, and the number is the last thing that can catch the wrong audience
    before it is irreversible — which is why `POST /email` makes the caller
    echo it back above `BROADCAST_CONFIRM_ABOVE` rather than trusting a dialog.

    The sample is a list of real customer addresses, so this route sits behind
    exactly the authority the send does: if you may not write to an audience you
    may not read it either.
    """
    try:
        return await broadcast.preview(audience, user=user, sample_size=sample)
    except broadcast.BroadcastError as exc:
        raise _refuse(exc) from exc


# ══════════════════════════════════════════════════════════════════════════════
#  The send
# ══════════════════════════════════════════════════════════════════════════════


class AttachmentIn(BaseModel):
    filename: str = Field(..., description="As the recipient will see it on disk.")
    content_type: str = Field(
        default="application/octet-stream",
        description=(
            "A bare 'type/subtype'. Parameters are stripped before the provider "
            "sees them — a charset here is what made every report email fail "
            "once (see email.Attachment)."
        ),
    )
    data_base64: str = Field(..., description="The file's exact bytes, base64.")


class BroadcastIn(BaseModel):
    audience: str = Field(
        ...,
        description=(
            "'all_agencies', 'all_sellers', 'all_users' or 'person:<email>'."
        ),
    )
    subject: str = Field(..., description="Plain text. Refused if empty.")
    body: str = Field(
        ...,
        description=(
            "Plain text. Blank lines become paragraphs. It is escaped and "
            "wrapped in the standard Zipper email shell — HTML in it arrives as "
            "the literal characters, deliberately."
        ),
    )
    reason: str = Field(
        ...,
        description=(
            "Why this is being sent. Mandatory, written to the audit log beside "
            "the resolved audience."
        ),
    )
    identity: str | None = Field(
        default=None,
        description=(
            "'transactional', 'bulk' or 'support'. Anything larger than one "
            "person is sent from the bulk address whatever is chosen, and the "
            "response says so."
        ),
    )
    attachments: list[AttachmentIn] = Field(default_factory=list)
    confirm_recipients: int | None = Field(
        default=None,
        description=(
            "The exact number `GET /audience` reported. Required above "
            "BROADCAST_CONFIRM_ABOVE recipients; a number that no longer "
            "matches is refused with the real one."
        ),
    )


def _decode(attachments: list[AttachmentIn]) -> list[mail.Attachment]:
    """Base64 in, exact bytes out, with the request-size guard applied first.

    The per-file and per-message ceilings are enforced by
    `email.prepare_attachments`, which is where they belong and where they are
    reported to the reader. What is checked *here* is the decoded total before
    anything else runs, because base64 inflates by a third and a caller can
    otherwise make the API hold 80 MB in memory on its way to being told the
    limit is 20.
    """
    ceiling = int(settings.email_max_total_attachment_bytes)
    out: list[mail.Attachment] = []
    total = 0

    for item in attachments:
        name = str(getattr(item, "filename", "") or "").strip()
        if not name:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=(
                    "An attachment with no filename cannot be sent — a "
                    "recipient has nothing to save it as."
                ),
            )
        raw = str(getattr(item, "data_base64", "") or "")
        try:
            data = base64.b64decode(raw, validate=True)
        except (binascii.Error, ValueError) as exc:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=(
                    f"'{name}' did not arrive as valid base64 ({exc}), so its "
                    "bytes are not the bytes that were picked. Nothing was sent "
                    "rather than a corrupt file."
                ),
            ) from exc
        total += len(data)
        if total > ceiling:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=(
                    f"The attachments come to more than {ceiling:,} bytes in "
                    "total, which is over what one message may carry. Send the "
                    "large file as a link instead."
                ),
            )
        out.append(
            mail.Attachment(
                filename=name,
                data=data,
                content_type=str(
                    getattr(item, "content_type", "") or "application/octet-stream"
                ),
            )
        )
    return out


@router.post("/email", status_code=status.HTTP_200_OK)
async def send_broadcast(
    body: BroadcastIn = Body(...),
    user: dict = Depends(require_write),
):
    """Send one composed message. Audited, with a mandatory reason.

    Authority is decided by the **audience**, not by this route
    (`broadcast.authority_for`): one named person is a team admin's to send,
    every agency or every seller is a marketing admin's, and every app user is
    an owner's and nobody else's. `require_write` here only establishes that the
    caller is internal and is not the Observer.

    **`can_send_broadcasts` is checked in `broadcast.check_authority`, not
    here**, and per audience. A route-level dependency could only ask for the
    strictest reading of a body it cannot see, which would take the `person`
    audience away from the five department admins the clause above deliberately
    gives it to — Support answering a ticket by email is not a broadcast. The
    three bulk audiences do need the capability, and that is asserted where the
    audience is known.

    A 200 means the send ran, not that every message arrived. Read `failed`,
    `not_attempted` and `stopped_early`, and follow `delivery_log` for the row
    behind each recipient.
    """
    try:
        return await broadcast.send(
            spec=str(getattr(body, "audience", "")),
            subject=str(getattr(body, "subject", "")),
            body=str(getattr(body, "body", "")),
            reason=str(getattr(body, "reason", "")),
            actor=user,
            identity=getattr(body, "identity", None),
            attachments=_decode(list(getattr(body, "attachments", []) or [])),
            confirm_recipients=getattr(body, "confirm_recipients", None),
        )
    except broadcast.BroadcastError as exc:
        raise _refuse(exc) from exc
    except mail.TemplateError as exc:
        # The email shell could not be built, so nothing was sent. Its own
        # branch because it is a deployment fault, not a caller's mistake, and
        # a 400 blaming the sender for it would waste their afternoon.
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=(
                f"The email template could not be built ({exc}), so nothing was "
                "sent. This is a fault in the deployment, not in the message."
            ),
        ) from exc
