"""Live-room intervention — ending a stream, and muting a host.

Spec 8.7. Ops watches live rooms (3.4.5), and 8.7.3 says ops can end a stream,
mute a host or force-close a room on violation. 8.7.4 says every intervention is
logged with a reason.

WHY THIS IS A SERVICE AND NOT A FIRESTORE WRITE FROM THE BROWSER.
  It used to be one. `/live` set `isActive: false` on the room document straight
  from the CRM, which is why the control was removed rather than fixed: a
  browser writing app state directly is a change with no actor, no reason and no
  audit entry, and the only record that a stream had been cut was that it had
  stopped. Moderation on this system is direct — a ban takes effect on the call,
  no signature (5.6) — but direct is not the same as unrecorded.

  So the write moves here, behind a session, with a mandatory reason, through
  the Admin SDK. The room document changes exactly as it did; what is different
  is that `/audit` now answers "who ended that stream and why".

WHAT ENDING A ROOM ACTUALLY DOES, STATED PLAINLY.
  It sets `isActive: false` on `liveRooms/{roomId}` and writes who, when and
  why beside it. **That is a flag, not a network operation.** The stream itself
  is carried by the media provider and stops when the host's client stops
  publishing; the app is what watches this flag and drops the room. The CRM says
  the same sentence rather than implying the video is severed the instant the
  button is pressed.

MUTE IS THE SAME SHAPE AND NEEDS MORE FROM THE APP.
  8.7.3 lists muting a host beside ending a stream, and the honest position is
  that this service can record the decision and cannot enforce it. `hostMuted`
  is written here, audited here, and does nothing at all until the Android app
  reads it and stops publishing the host's audio. `mute_host` says so in its
  return value rather than letting a green tick imply silence.

Firestore is the record for a live room because the app reads it there —
the same division as `sellers` and `agencies` documents everywhere else in this
codebase. Mongo holds the audit entry, which is the part that must never be
lost.
"""

from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timezone
from typing import Any

from app.core import audit
from app.core.roles import Role
from app.db import firebase

log = logging.getLogger(__name__)

#: The Firestore collection the Android app writes and `/live` reads.
ROOMS = "liveRooms"

#: Same floor as everywhere else a reason is demanded. An intervention with
#: "asd" against it is not logged with a reason, it is logged with a keystroke.
MIN_REASON = 6


class LiveError(Exception):
    """Refused by a live-room rule. The message is safe to show the caller."""


class Act:
    """Audit actions this module adds to the ones in `app.core.audit`."""

    #: 8.7.3 — a stream ended by ops. Its own action rather than a generic edit:
    #: this is the one write in the system that reaches into a broadcast a
    #: member of the public is watching, and reading `/audit` for a host should
    #: show it as such.
    ROOM_ENDED = "live.room_ended"
    #: 8.7.3 — a host muted or unmuted. Separate from the end, because a mute is
    #: reversible and an ended room is not.
    HOST_MUTED = "live.host_muted"
    HOST_UNMUTED = "live.host_unmuted"


#: Who may intervene in a live room. Owners, and the ops team who do the
#: watching (3.4.5). Deliberately narrower than the set who may warn or ban a
#: host: warning is a record against an account, and ending a stream is cutting
#: a broadcast off in front of its audience.
#:
#: Held here rather than in `app/core/deps.py` because it is one route pair's
#: rule, not a tier of the authority model — and the router applies it on top of
#: `require_write`, so the observer and every external partner are already gone
#: before this set is consulted.
INTERVENTION_ROLES: frozenset[Role] = frozenset(
    {Role.OWNER, Role.OPS_ADMIN, Role.OPS_MEMBER}
)


def may_intervene(role: Any) -> bool:
    try:
        return Role(role) in INTERVENTION_ROLES
    except ValueError:
        return False


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _who(actor: dict) -> dict:
    return {
        "uid": actor.get("uid", ""),
        "name": actor.get("name", ""),
        "role": str(actor.get("role", "")),
        "team": str(actor["team"]) if actor.get("team") else None,
    }


def _require_reason(reason: str) -> str:
    text = (reason or "").strip()
    if len(text) < MIN_REASON:
        raise LiveError(
            f"A reason of at least {MIN_REASON} characters is required. Every "
            "intervention in a live room is logged with one (8.7.4)."
        )
    return text


def _room_id(room_id: str) -> str:
    text = (room_id or "").strip()
    if not text:
        raise LiveError("A room id is required.")
    return text


# ── Firestore, off the event loop ─────────────────────────────────────────────


def _read_room(room_id: str) -> dict | None:
    """Blocking — the live room document, or None if there is none."""
    snapshot = firebase.firestore_client().collection(ROOMS).document(room_id).get()
    return (snapshot.to_dict() or {}) if snapshot.exists else None


def _write_room(room_id: str, fields: dict) -> None:
    """Blocking — merge fields into the room document.

    `update` rather than `set(merge=True)` on purpose: it fails on a document
    that does not exist, and a room that vanished between the read and the write
    must surface as an error rather than be recreated as a stub that `/live`
    would then list as a room.
    """
    firebase.firestore_client().collection(ROOMS).document(room_id).update(fields)


async def _room_or_refuse(room_id: str) -> dict:
    try:
        room = await asyncio.to_thread(_read_room, room_id)
    except Exception as exc:  # noqa: BLE001
        log.exception("Could not read live room %s", room_id)
        raise LiveError(
            f"The live room '{room_id}' could not be read, so nothing was "
            "changed. This is a read failure, not a room that does not exist — "
            "try again."
        ) from exc

    if room is None:
        raise LiveError(
            f"No live room '{room_id}'. Nothing was changed. A room that has "
            "already closed is deleted by the app rather than kept, so this is "
            "the answer for a stream that ended on its own."
        )
    return room


# ══════════════════════════════════════════════════════════════════════════════
# Ending a stream — 8.7.3 / 8.7.4
# ══════════════════════════════════════════════════════════════════════════════


async def end_room(room_id: str, reason: str, actor: dict) -> dict:
    """End a live room. Direct, audited, and with a mandatory reason.

    Refused if the room does not exist, if the reason is too short, or if the
    room is **already ended** — the last one deliberately rather than quietly
    succeeding. A no-op mutation that answers "done" reads as "I ended it", and
    an operator who pressed the button twice deserves to know the second press
    did nothing rather than to find two entries in the log describing one act.

    Nothing about the host's account changes. Ending a room is not a ban and not
    a warning; if the behaviour warrants one, that is `POST /users/{uid}/ban` or
    `/warn` and it is a separate decision with its own reason.
    """
    room_id = _room_id(room_id)
    reason = _require_reason(reason)
    room = await _room_or_refuse(room_id)

    if not room.get("isActive", False):
        ended_at = room.get("endedAt")
        raise LiveError(
            f"'{room_id}' is not live"
            + (f" — it ended at {ended_at}" if ended_at else "")
            + ". Nothing was changed, and nothing was recorded a second time."
        )

    now = _now()
    host_uid = str(room.get("hostUid") or "")
    host_name = str(room.get("hostName") or "")

    before = {
        "isActive": True,
        "viewerCount": room.get("viewerCount", 0),
        "totalGiftsReceived": room.get("totalGiftsReceived", 0),
    }
    fields = {
        "isActive": False,
        "endedAt": now,
        "endedBy": _who(actor),
        "endedByStaff": True,
        "endReason": reason,
    }

    try:
        await asyncio.to_thread(_write_room, room_id, fields)
    except Exception as exc:  # noqa: BLE001
        log.exception("Could not end live room %s", room_id)
        raise LiveError(
            f"The room could not be closed: {exc}. Nothing was changed and "
            "nothing was recorded — the stream is still live."
        ) from exc

    # Written after the change and never before it: an audit entry describing an
    # end that did not happen is worse than no entry at all.
    audit_id = await audit.record(
        actor=actor,
        action=Act.ROOM_ENDED,
        subject_type="live_room",
        subject_id=room_id,
        reason=reason,
        before=before,
        after={"isActive": False},
        meta={
            "host_uid": host_uid,
            "host_name": host_name,
            "title": room.get("title", ""),
            "viewers_at_end": room.get("viewerCount", 0),
            "gifts_at_end": room.get("totalGiftsReceived", 0),
            # Said out loud so nobody reads this entry as "the video was cut".
            "enforcement": (
                "The room is flagged inactive. The app is what drops the "
                "stream when it reads the flag; the host's account is "
                "untouched."
            ),
        },
    )

    return {
        "room_id": room_id,
        "host_uid": host_uid,
        "host_name": host_name,
        "ended": True,
        "ended_at": now,
        "reason": reason,
        "audit_id": audit_id,
        "note": (
            "The room is marked ended and the reason is on the record. The "
            "stream stops when the host's client reads the flag and drops it, "
            "so it may stay visible in the app for a moment. The host's account "
            "is unchanged — ending a room is not a ban."
        ),
    }


# ══════════════════════════════════════════════════════════════════════════════
# Muting a host — 8.7.3, and what it needs from the Android app
# ══════════════════════════════════════════════════════════════════════════════


async def mute_host(room_id: str, muted: bool, reason: str, actor: dict) -> dict:
    """Set or clear the mute flag on a live room's host. Audited either way.

    **This records a decision; it does not enforce one.** There is no server-side
    path to a media stream from here — the audio is published by the host's
    device to the media provider and this system is not in it. What this writes
    is `hostMuted` on the room document, which is a instruction the Android app
    must honour by stopping the host's audio publisher; until the app reads it,
    the flag is a record of a decision and the host is still audible.

    That is stated in the return value, and the CRM prints it, because a mute
    button that reports success while the room is still making noise is worse
    than no button.

    Unmuting is the same call with `muted=False`, and carries its own reason for
    the same reason the mute did: lifting an intervention is an intervention.
    """
    room_id = _room_id(room_id)
    reason = _require_reason(reason)
    room = await _room_or_refuse(room_id)

    was = bool(room.get("hostMuted", False))
    if was == bool(muted):
        raise LiveError(
            f"This host is already {'muted' if was else 'not muted'}. Nothing "
            "was changed, and nothing was recorded a second time."
        )

    now = _now()
    host_uid = str(room.get("hostUid") or "")
    host_name = str(room.get("hostName") or "")

    fields = {
        "hostMuted": bool(muted),
        "hostMutedAt": now if muted else None,
        "hostMutedBy": _who(actor) if muted else None,
        "hostMuteReason": reason,
    }

    try:
        await asyncio.to_thread(_write_room, room_id, fields)
    except Exception as exc:  # noqa: BLE001
        log.exception("Could not set the mute flag on live room %s", room_id)
        raise LiveError(
            f"The mute flag could not be written: {exc}. Nothing was changed "
            "and nothing was recorded."
        ) from exc

    audit_id = await audit.record(
        actor=actor,
        action=Act.HOST_MUTED if muted else Act.HOST_UNMUTED,
        subject_type="live_room",
        subject_id=room_id,
        reason=reason,
        before={"hostMuted": was},
        after={"hostMuted": bool(muted)},
        meta={
            "host_uid": host_uid,
            "host_name": host_name,
            "title": room.get("title", ""),
            "enforcement": (
                "hostMuted is a flag on the room document. The Android app must "
                "read it and stop the host's audio publisher; this API cannot "
                "reach the media stream. Until the app honours it, the host is "
                "still audible."
            ),
        },
    )

    return {
        "room_id": room_id,
        "host_uid": host_uid,
        "host_name": host_name,
        "muted": bool(muted),
        "was_muted": was,
        "at": now,
        "reason": reason,
        "audit_id": audit_id,
        # Read verbatim by the CRM. It is the whole truth about this endpoint.
        "app_must_honour": (
            "hostMuted is written on the room document and the decision is on "
            "the record. It takes effect only when the Android app reads the "
            "flag and stops publishing the host's audio — this API is not in "
            "the media path and cannot silence anybody on its own. If the app "
            "does not yet read hostMuted, this has changed nothing the audience "
            "can hear."
        ),
    }
