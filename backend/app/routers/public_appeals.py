"""PUBLIC appeal endpoints — no session (UGP-F).

Mounted at `/api/public/appeals`. The two routes carry no dependency at all,
which is the point: the person they are for is locked out of their account.
What protects them instead is in `services/public_appeals.py` — identification
that answers a missing and an unrestricted account the same way, rate limits
per client and per account, content-typed and size-capped attachments stored
privately, and the rule that filing an appeal never lifts anything.

The staff side (signed links to the attachments) lives on the users router,
behind a session, beside the appeals queue it serves.
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request, status
from pydantic import BaseModel, Field

from app.services import public_appeals as svc

router = APIRouter(prefix="/public/appeals", tags=["public-appeals"])

#: Read at most this much of any one upload.
_READ_CAP = svc.MAX_VIDEO_BYTES + 1
#: The largest body this route will accept when the client declares its size:
#: every attachment at its cap, plus room for the text fields and the
#: multipart framing.
_MAX_BODY = svc.MAX_TOTAL_BYTES + 512 * 1024


def _client_address(request: Request) -> str:
    """The caller's address as Hosting/Cloud Run forward it — for rate limiting only.

    BEST EFFORT, AND SAID SO (UGP review): the left-most `X-Forwarded-For`
    entry is whatever the caller sent first, so a client that forges the
    header gets a fresh per-client budget. Which hop Google's front ends append
    for a Hosting rewrite is not documented; until it has been read off the
    deployed stack (manual checklist), the binding limits are the per-account
    ones and the one-pending-appeal rule, which no header changes. Never the
    connecting peer: on Cloud Run that is Google's proxy, shared by everyone,
    and one abuser would lock the page for all.
    """
    forwarded = request.headers.get("x-forwarded-for", "")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return request.client.host if request.client else ""


def _field(form, key: str, lo: int, hi: int) -> str:
    value = form.get(key)
    text = value.strip() if isinstance(value, str) else ""
    if len(text) < lo or len(text) > hi:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"'{key}' must be between {lo} and {hi} characters.",
        )
    return text


def _fail(exc: svc.PublicAppealError) -> HTTPException:
    code = status.HTTP_429_TOO_MANY_REQUESTS if isinstance(exc, svc.RateLimited) else status.HTTP_400_BAD_REQUEST
    return HTTPException(status_code=code, detail=str(exc))


class Lookup(BaseModel):
    account_id: str = Field(min_length=6, max_length=128)
    display_name: str = Field(default="", max_length=80)
    #: §5 — the phone number or email address ON the account. Required to get
    #: past `not_found`; a wrong one answers 400 with the mismatch sentence.
    contact: str = Field(default="", max_length=120)


@router.post("/lookup")
async def lookup(body: Lookup, request: Request):
    """PUBLIC. Is there an account these details name that can be appealed?

    Answers `appealable` (with a masked name), `appeal_pending`, or
    `not_found` — and `not_found` also for an account that is not restricted,
    so this cannot be used to learn who is banned. §5: the `contact` must
    match the account (its registered phone or email) or the answer is a 400
    naming the mismatch."""
    try:
        return await svc.lookup(
            body.account_id, body.display_name, _client_address(request),
            contact=str(getattr(body, "contact", "") or ""),
        )
    except svc.PublicAppealError as exc:
        raise _fail(exc) from exc


@router.post("", status_code=status.HTTP_201_CREATED)
async def submit(request: Request):
    """PUBLIC. File an appeal: message + up to 3 screenshots or videos.

    Returns `{reference, status: "pending"}`. Nothing about the account
    changes; a reviewer decides it in the CRM's appeals inbox.

    The multipart body is parsed HERE rather than through `Form`/`File`
    parameters (UGP review), so two checks run before any of it is read: the
    size the client declares, and whether this client has already spent its
    submissions for the hour. Declared through parameters, the whole body was
    spooled — to `/tmp`, which is memory on Cloud Run — before either limit
    applied. A request that declares no size is still bounded by Cloud Run's
    own 32 MiB request ceiling and by the per-file caps below.
    """
    declared = request.headers.get("content-length", "")
    if declared.isdigit() and int(declared) > _MAX_BODY:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail="The attachments are too large altogether.",
        )
    client = _client_address(request)
    if await svc.client_over_submit_budget(client):
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Too many appeals from here. Try again in an hour.",
        )
    try:
        form = await request.form(max_files=svc.MAX_FILES + 1, max_fields=9)
    except Exception as exc:  # noqa: BLE001 — a malformed or oversized form
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="The form could not be read.") from exc
    try:
        account_id = _field(form, "account_id", 6, 128)
        display_name = _field(form, "display_name", 0, 80)
        # §5: the phone number or email on the account. Checked in the service
        # against the Firebase Auth record; absent → CONTACT_REQUIRED (400).
        contact = _field(form, "contact", 0, 120)
        statement = _field(form, "statement", 1, 4000)
        uploads: list[svc.Upload] = []
        for item in form.getlist("files")[: svc.MAX_FILES + 1]:
            if isinstance(item, str) or not hasattr(item, "read"):
                continue
            data = await item.read(_READ_CAP)
            if len(data) >= _READ_CAP:
                raise HTTPException(
                    status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                    detail="One of the attachments is too large.",
                )
            uploads.append(svc.Upload(filename=getattr(item, "filename", "") or "", data=data))
    finally:
        await form.close()
    try:
        return await svc.submit(account_id, display_name, statement, uploads, client, contact=contact)
    except svc.PublicAppealError as exc:
        raise _fail(exc) from exc
