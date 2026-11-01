"""The internal half of the Storage role claim.

``storage.rules`` cannot read Firestore, so the ``crmUsers/{uid}`` lookup that
makes ``firestore.rules`` correct has no equivalent there. Until this existed,
``storage.rules`` stood in a predicate that returned ``request.auth != null``
— so every KYC document, identity proof and bank slip in the bucket was
readable by anybody holding any token.

A Firebase custom claim is the only thing that puts a role into a token a
Storage rule can see. This module sets it for **internal** identities. The
partner half — agency and coin seller — is set by the
``syncStorageRoleClaim`` Firestore trigger in ``functions/src/index.ts``.

── WHY THE TWO HALVES ARE SEPARATE, AND WHY IT MATTERS ───────────────────────

Partner ``crmUsers`` documents are written **by the client**, in the browser,
with the new partner's own token. A single trigger mirroring ``crmUsers.role``
onto a claim would therefore be an escalation path: write yourself
``role: 'owner'``, collect an owner claim, read every KYC document in the
business. ``firestore.rules`` currently prevents that first step, but making
Storage authorisation depend on a rules file in another language staying
correct forever is not a control — it is a hope.

So the privileged vocabulary is simply not reachable from Firestore. The
trigger can emit ``agency`` and ``seller`` and nothing else, by construction.
Internal roles come from here, and the authority here is the Mongo ``staff``
row — which no client can write, because the only way to create one is
``POST /staff`` behind ``require_write`` + ``can_manage_team``.

── THE VOCABULARY IS ``Role`` ────────────────────────────────────────────────

The claim carries a :class:`~app.core.roles.Role` value, not the CRM spelling.
The two differ — ``Role.OWNER`` is ``"owner"`` here and ``"superadmin"`` in
``crmUsers`` (see ``crm_directory.CRM_ROLE``) — and keeping the token on one
vocabulary means ``storage.rules`` never has to know about the mapping.

``Role.OBSERVER`` is included and is the reason this module cannot be replaced
by the trigger even in principle: an observer deliberately has **no**
``crmUsers`` document at all (``crm_directory.NOT_MIRRORED``), so Firestore has
nothing to mirror.

── FAILURE IS REPORTED, NEVER SWALLOWED SILENTLY ─────────────────────────────

Every function returns a problem string rather than raising. A claim that
could not be written must not roll back a staff invitation that already
succeeded — but it must also not vanish. Callers put the string in the audit
entry, the same way ``staff.deactivate`` already handles
``firebase_revoke_failed``.
"""

from __future__ import annotations

import logging
from typing import Any

from app.core.roles import EXTERNAL_ROLES, INTERNAL_ROLES, Role

log = logging.getLogger(__name__)

#: The claim keys this module owns. Anything else on the token is left alone —
#: `set_custom_user_claims` REPLACES the whole object, so a blind write would
#: silently drop a claim set by something else.
CLAIM_KEYS = ("role", "aid")


def _auth():
    """The Admin SDK auth client, imported lazily.

    Module-scope `firebase_admin` access runs before `firebase.init()` and
    raises `FirebaseAppError`; the same trap `app/db/firebase.py` documents.
    """
    from firebase_admin import auth as fb_auth

    return fb_auth


def claim_for(role: Role | str | None) -> dict[str, str] | None:
    """The claim an internal role earns, or ``None`` if it earns nothing.

    ``None`` for the two external roles as well as for junk: a partner's claim
    is the trigger's to write, and this module overwriting it would make the
    two authorities race on every staff edit.
    """
    if role is None:
        return None
    try:
        parsed = Role(str(role))
    except ValueError:
        return None
    if parsed in EXTERNAL_ROLES or parsed not in INTERNAL_ROLES:
        return None
    # `aid` is always present so a Storage rule can read it without an
    # existence check. An internal role is not scoped to one agency.
    return {"role": str(parsed), "aid": ""}


def _apply(uid: str, wanted: dict[str, str] | None) -> str:
    """Write ``wanted`` onto the uid's claims, preserving unrelated keys."""
    uid = (uid or "").strip()
    if not uid:
        return "no uid"

    try:
        fb_auth = _auth()
        existing = dict(getattr(fb_auth.get_user(uid), "custom_claims", None) or {})
    except Exception as exc:  # noqa: BLE001 — the message is the point
        log.warning("storage claim: could not read user %s: %s", uid, exc)
        return f"could not read the Firebase user: {exc}"

    # P1-A3b: `mfa_sid` is a PER-SESSION developer claim (custom-token sign-in
    # after Owner MFA). Account-wide claims must never carry it — it would then
    # appear in EVERY sign-in of the account — so it is dropped here, always.
    rest = {k: v for k, v in existing.items() if k not in CLAIM_KEYS and k != "mfa_sid"}
    merged = {**rest, **(wanted or {})}

    if merged == existing:
        return ""

    try:
        _auth().set_custom_user_claims(uid, merged)
    except Exception as exc:  # noqa: BLE001
        log.warning("storage claim: could not write for %s: %s", uid, exc)
        return f"could not set the Storage role claim: {exc}"

    log.info("storage claim %s for %s", wanted or "cleared", uid)
    return ""


def apply_for_role(uid: str, role: Role | str | None) -> str:
    """Grant or clear a uid's internal claim. Returns '' or a problem string.

    Covers the whole internal lifecycle:

    * **invite** — the role is internal, the claim is granted;
    * **role change** — the old claim is replaced, including a move between
      departments and a promotion to owner;
    * **deactivation** — call :func:`clear` instead, which is the same write
      with no claim.

    An external role clears the claim rather than writing one, so a staff
    account converted to a partner does not keep internal access while the
    trigger catches up.
    """
    return _apply(uid, claim_for(role))


#: The only partner roles this module will write, and the reason it has a
#: whitelist at all: `apply_partner` is reachable from the backfill script,
#: which reads `crmUsers` — a client-written collection. Without this, a
#: document carrying `role: 'owner'` would be handed straight through.
#: Mirrors `PARTNER_CLAIM_ROLE` in functions/src/storageClaims.ts.
_PARTNER_ROLES = frozenset({"agency", "seller"})


def apply_partner(uid: str, role: str, agency_id: str = "") -> str:
    """Write a PARTNER claim. Used only by the backfill.

    At runtime the `syncStorageRoleClaim` trigger owns this; the backfill
    exists because the trigger has never fired for accounts that predate it.

    Refuses anything outside `_PARTNER_ROLES` rather than trusting its caller.
    The data behind this call came from a client-written Firestore document,
    so "the caller already checked" is not a property worth relying on in the
    one function that can write an authorisation token.
    """
    r = (role or "").strip()
    if r not in _PARTNER_ROLES:
        return f"refused: {r!r} is not a partner role"
    return _apply(uid, {"role": r, "aid": (agency_id or "").strip()})


def clear(uid: str) -> str:
    """Remove the Storage claim. Used on deactivation and account removal.

    The token already in the person's browser keeps its claim until it expires
    — up to an hour. ``staff.deactivate`` disables the Firebase login in the
    same breath, which is what actually ends the session; this removes the
    authority so a reactivated login does not silently come back with its old
    access.
    """
    return _apply(uid, None)


def describe(uid: str) -> dict[str, Any]:
    """The claim currently on a uid. For the backfill script's report."""
    try:
        claims = dict(getattr(_auth().get_user(uid), "custom_claims", None) or {})
    except Exception as exc:  # noqa: BLE001
        return {"uid": uid, "error": str(exc)}
    return {"uid": uid, "role": claims.get("role", ""), "aid": claims.get("aid", "")}
