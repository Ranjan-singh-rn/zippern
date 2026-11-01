"""Request dependencies — who is calling, and may they do this."""

from __future__ import annotations

import logging
from collections.abc import Awaitable, Callable

from fastapi import Depends, Header, HTTPException, Request, status

from app.core import roles as R
from app.core.account_state import AccountRefused, assert_may_act
from app.core.roles import Role
from app.core.security import AuthError, Op, is_service_actor, verify_service_key
from app.core.security import verify_session

log = logging.getLogger(__name__)

# The name of the header a machine credential is presented in. It exists in
# exactly one place so it can be grepped, and it is read by exactly the two
# dependencies built at the foot of this module.
SERVICE_KEY_HEADER = "X-Service-Key"


# ══════════════════════════════════════════════════════════════════════════════
# What an external partner may reach — an allowlist, not a deny-list
# ══════════════════════════════════════════════════════════════════════════════
#
# Until now no agency or seller could obtain a session, so every route in this
# API was written by somebody who knew the caller was staff. Most of them say
# so; `require_internal`, `require_owner` and `require_team_admin` all refuse an
# external role. **Some do not**, and they are not marked:
#
#   * `require_write` refused only the observer, so an agency session would have
#     satisfied all thirty-three of its routes — `POST /users/{uid}/ban`,
#     `PATCH /staff/{uid}/role`, `POST /partner-ops/partners/{id}/approve`, every
#     card verification and every card rejection.
#   * Nine routes take a bare `current_user` and were never meant for a partner:
#     `GET /cards`, `GET /cards/inbox`, `GET /staff`, `GET /staff/overview`,
#     `GET /staff/assignable-roles`, `GET /users/devices/bans`,
#     `GET /users/reports`, `GET /users/{uid}/history` and
#     `GET /users/{uid}/warnings`. Each scopes on team or on nothing at all, and
#     team is a concept an external partner has no value for.
#
#     That list is the state as this guard was written, and it has grown since:
#     `GET /staff/me` and `GET /users/appeals` belong to it too. The live,
#     authoritative version is pinned in `tests/test_partner_session.py` — a new
#     one appearing there is a failing test rather than a line nobody reads.
#
# (Two more take a bare session and already say so themselves —
# `GET /partner-ops/payment-references/{ref}` and
# `GET /partner-ops/subagency-payouts/open` carry their own `is_internal`
# refusal. They are the only two that did.)
#
# Of those eleven, exactly two are now open to a partner and both were opened by
# fixing the scope rather than by trusting it. `GET /cards` is scoped in
# `board_for`, explicitly in the code rather than falling out of an external
# role having no team; the duplicate-reference evidence riding on those cards,
# which names *other* sellers, is narrowed by `cards.partner_view`.
#
# NOTE — `board_for`'s external branch is no longer `requested_by.uid == me`
# alone, and this comment used to say it was. It is now that **or** a card whose
# `subject.id` is one of the ids on the caller's own session AND whose `type` is
# on `cards.PARTNER_SUBJECT_CARD_TYPES`. That was widened deliberately: lending,
# repayment, recovery and write-off are raised by staff *about* a seller, so
# under the old rule a seller could see the debt in their ledger and never the
# card that created it. The allowlist is what keeps it safe — a card type added
# tomorrow is invisible to partners until someone puts it on that list.
# `GET /partner-ops/subagency-payouts/open` returned every open payout in the
# business, so its `is_internal` refusal is replaced by a filter to the payouts
# the caller is the parent or the sub of. The other nine are unchanged and still
# refused: `GET /cards/inbox` counts what is waiting on a *verifier* and a
# *signer*, `payment-references` searches every card in the business for a UTR,
# and the six staff and user routes scope on team.
#
# Auditing that list once and hoping it stays true is not a control: the failure
# mode of a new route is silence. So the question is inverted. An external
# session may reach the routes named below **and nothing else**, whatever
# dependency a route declares and whenever it was added. A route added tomorrow
# is refused to a partner until somebody puts it in this set, in a diff, next to
# this comment.
#
# **Every entry carries the spec clause that justifies it and says how it is
# scoped**, because "who may reach this" and "which record do they get" are two
# different questions and being on this list only answers the first. Reaching a
# route is never permission to name somebody else's id in it: the second answer
# is `own_partner_id_or_403` (or an equivalent filter) *inside* the route, on
# every single one of them.
#
# Nothing here executes, signs or verifies anything. Execution of a money card
# is `require_owner` and stays there — a partner raises a request and an owner
# makes it real, which is the whole of Part 5.
PARTNER_REACHABLE: frozenset[tuple[str, str]] = frozenset(
    {
        # ── Their own session and identity ────────────────────────────────────
        ("GET", "/api/auth/me"),
        ("POST", "/api/auth/signout"),
        # ── Decision 15 (RC): verifying their own contacts ────────────────────
        # A role approved by the Owner waits until the login holds BOTH a
        # verified phone and a verified email. These three are how the
        # person, signed in to the waiting room with no partner ids at all,
        # sees what is missing, starts the role once both are verified, and
        # reports a contact that turned out to belong to another account.
        # Each acts on the session's OWN uid only (`own_session_uid(user)`),
        # takes no id from the request — no path parameter, and no id field in
        # the body — and re-reads the verification from Firebase Auth and the
        # server's ledger, so nothing is started on the caller's word. The two
        # POSTs are the only self-scoped writes on this list;
        # `tests/test_partner_session.py` reads the router source and fails if
        # either one grows an id.
        ("GET", "/api/partner-ops/me/verification"),
        ("POST", "/api/partner-ops/me/verification/check"),
        ("POST", "/api/partner-ops/me/verification/conflict"),
        # ── Their own money — 4.1.9 / 0.2.2–0.2.4 / 0.4.2 ─────────────────────
        # Each scoped by `own_partner_id_or_403(user, id, kind=…)`; the `kind`
        # is what stops a dual-role login reading its seller record through an
        # agency route.
        ("GET", "/api/partners/agencies/{agency_id}/statement"),
        ("GET", "/api/partners/agencies/{agency_id}/hosts"),
        # 4.2.9 — a parent sees its subs' status and what it owes them.
        ("GET", "/api/partners/agencies/{agency_id}/sub-agencies"),
        # ── What has been alleged about their hosts, and their replies ────────
        #
        # Both scoped by `own_partner_id_or_403(…, kind="agency")`, and both are
        # deliberate grants to an outside business rather than accidents of a
        # bare `current_user`.
        #
        # An agency could previously see nothing about a report against one of
        # its hosts. The host would be warned, suspended or banned, their
        # earnings would stop, and the agency would find out by noticing the
        # beans had gone quiet — while being the party most likely to know the
        # context that makes the report wrong. `host-reports` is what lets them
        # look; `appeals` is what became of the ones they contested.
        #
        # Neither returns another agency's anything: `host-reports` resolves
        # this agency's own roster first and fetches reports by those uids, and
        # `appeals` filters on `agencyId`.
        ("GET", "/api/partners/agencies/{agency_id}/host-reports"),
        ("GET", "/api/partners/agencies/{agency_id}/appeals"),
        ("GET", "/api/partners/sellers/{seller_id}/statement"),
        # A coin seller filing a sale names the buyer; this resolves exactly
        # that person (exact uid / email / phone, contact details masked). The
        # route itself refuses any partner without a Coin Seller role.
        ("GET", "/api/partner-ops/buyers/lookup"),
        # Their whole record in one list — purchases with the rupees and the
        # UTR, lending, repayments, recoveries, write-offs and the sales they
        # filed. Scoped by the same `own_partner_id_or_403(…, kind="seller")`
        # as the statement beside it, and it reads no other partner's anything:
        # every one of its four sources is keyed on this seller's own id.
        #
        # A seller could previously reconcile their own account only by reading
        # four separate tabs, and a repayment they had made appeared in none of
        # them — `execute_repayment` writes no coin movement, so the statement
        # cannot show one at any limit. This is the route that answers it.
        ("GET", "/api/partners/sellers/{seller_id}/history"),
        # 4.3.12 — whether they may take new inventory, and why not.
        ("GET", "/api/partners/sellers/{seller_id}/can-take-inventory"),
        # ── Their own KYC documents, behind a short-lived signed URL ──────────
        #
        # A partner has always been able to SEE its own documents — the agency
        # dashboard renders them — but it was doing so from the permanent
        # `?alt=media&token=` download URL stored at upload. That URL is a
        # bearer credential Storage Rules are never consulted for, so it had to
        # stop being handed to a browser; this route is what replaces it.
        #
        # Reachable rather than internal-only for that reason: refusing a
        # partner here would not close anything, it would just leave the
        # dashboard on the permanent URL it is being taken off.
        #
        # Scoped by `partner_ids_of(user, kind)` in `services/documents`, the
        # same session-derived authority the statement routes above use —
        # deliberately NOT by matching `ownerUid`/`crmUid` on the record, which
        # are client-written during signup. `kind='host'` has no external
        # branch at all, so a host application is staff-only by omission.
        ("GET", "/api/documents/{kind}/{record_id}"),
        # The batch form of the same route, for list views. Each ref inside it
        # is authorised individually by `_may_see`, and one the caller may not
        # see is omitted — so batching grants nothing the single route does
        # not. A partner reaches only its own records through either.
        ("GET", "/api/documents/batch"),
        # ── Their own record, and their own sales ─────────────────────────────
        # `list_partners` answers an external caller from `partner_ids_of` and
        # ignores the filters; `get_partner` is `own_partner_id_or_403` with no
        # `kind`, because both of a dual-role login's records are their own.
        ("GET", "/api/partner-ops/partners"),
        ("GET", "/api/partner-ops/partners/{partner_id}"),
        # 4.3.8 — the sales they filed. `list_sales` pins an external caller to
        # their own *seller* id and answers an agency-only login with nothing.
        ("GET", "/api/partner-ops/sales"),
        # A seller's own recharge queue — the buyer-filed requests staff are
        # verifying — scoped to its own partner id inside the route.
        ("GET", "/api/partner-ops/recharges"),
        ("GET", "/api/partner-ops/recharges/{recharge_id}"),
        # ── Where their own request has got to — 5.2 / 4.3.6 ─────────────────
        # A seller who has paid us can otherwise see nothing between "raised"
        # and "the coins appeared", and `approved` is not `executed`. Scoped in
        # `services/cards.board_for`, which answers an external session with the
        # cards they raised **or** cards raised about them — `subject.id` on the
        # caller's own session and `type` on `PARTNER_SUBJECT_CARD_TYPES`. The
        # second half is why a seller can see the lending card behind a debt
        # staff raised, and the allowlist is why they cannot see anything else.
        # The duplicate-payment-reference evidence attached to those cards is
        # about *other* sellers and is narrowed by `cards.partner_view`, which
        # also replaces every internal name with "Zipper".
        ("GET", "/api/cards"),
        # ── Both legs of a payout that runs through them — 4.2.6 / 4.2.7 ─────
        # 4.2.6 says a sub-agency payout is not closed until the second leg is
        # confirmed, and leg 1 debits the *sub's* balance — so the figure on
        # /partners/agencies/{id}/sub-agencies reads zero from leg 1 onwards
        # while the sub may not have been paid at all. Without this an agency
        # cannot see which half it is in. Scoped in the route to payouts where
        # the caller is the parent or the sub.
        ("GET", "/api/partner-ops/subagency-payouts/open"),
        # ══ Writes that name a partner record ════════════════════════════════
        #
        # Three. (The other two writes on this list are the Decision 15
        # self-scoped verification POSTs above, which name no record at all.)
        #
        # The first two are the *start* of a flow the spec puts in the
        # partner's hands, both raise a request that moves nothing, and both are
        # scoped by `own_partner_id_or_403(…, kind="seller")` inside the route
        # against the id in the URL or the body. Both carry a mandatory reason
        # and both are audited, exactly as they were for staff. The third
        # (Decision 16) is scoped the same way with `kind="agency"` and files a
        # pending application that holds nothing.
        #
        # 4.3.5 — "Seller buys inventory." The card is verified, signed and only
        # then executed by an owner (4.3.6): nothing here credits a coin.
        ("POST", "/api/partner-ops/sellers/{seller_id}/coin-purchases"),
        # 4.3.8 — "Seller sells diamonds to users and files a record of each
        # sale." Filing leaves the sale at `pending`; approval is owner-only and
        # debits the seller's inventory first (4.3.9).
        ("POST", "/api/partner-ops/sales"),
        # Decision 16 (RC) — a parent agency files a FRESH Sub-agency
        # application for a person whose earlier one was rejected (their login
        # already exists, so the dashboard's own create cannot). Scoped by
        # `own_partner_id_or_403(…, kind="agency")` on the URL's agency id;
        # files a pending record that holds nothing, decided by staff.
        ("POST", "/api/partner-ops/agencies/{agency_id}/sub-agencies/reapply"),
    }
)


def _route_key(request: Request | None) -> tuple[str, str] | None:
    """(method, templated path) for the route this request matched.

    The path template is taken from the matched route rather than from the URL,
    so it is the same string that appears in `PARTNER_REACHABLE` whatever ids
    the caller put in it, and a caller cannot influence it.
    """
    route = getattr(request, "scope", {}).get("route") if request is not None else None
    path = str(getattr(route, "path", "") or "")
    if not path:
        return None
    return (str(getattr(request, "method", "") or "").upper(), path)


def _refuse_unreachable_route(request: Request | None, user: dict) -> None:
    """Stop an external session at any route not named in `PARTNER_REACHABLE`.

    A request whose route cannot be identified is refused too. That case should
    not arise — FastAPI puts the matched route in the scope before a dependency
    runs — but "I could not tell which route this is" is not a reason to allow
    a partner through.
    """
    if not R.is_external(user["role"]):
        return

    key = _route_key(request)
    if key is None or key not in PARTNER_REACHABLE:
        log.warning(
            "External session %s (%s) reached %s, which is not partner-reachable.",
            user.get("uid", ""),
            user.get("role", ""),
            key or "an unidentified route",
        )
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Not available to partner accounts.",
        )


async def current_user(
    request: Request = None,  # type: ignore[assignment]
    authorization: str = Header(default=""),
) -> dict:
    if not authorization.startswith("Bearer "):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Sign-in required",
        )
    try:
        user = await verify_session(authorization.removeprefix("Bearer ").strip())
    except AuthError as exc:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail=str(exc)
        ) from exc

    # ── Is the account behind this session still allowed in? ─────────────────
    #
    # This used to be checked on 22 permission-gated routes and nowhere else,
    # and for a partner it was not checked on any route at all. A session token
    # carries its role as a claim; between issue and expiry that claim is a
    # snapshot, and the three doors `renew_session` already names — a script, a
    # migration, a hand edit — move an account without revoking anything.
    #
    # `account_state` holds the authoritative answer and caches it on the
    # session document, so this is one extra read and write per session per
    # minute rather than per request. See that module for the full argument.
    #
    # A 403 rather than a 401: the credential is valid, the account is not
    # permitted. A 401 would send the CRM into its renewal loop against a server
    # that is going to keep refusing.
    try:
        await assert_may_act(user)
    except AccountRefused as exc:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN, detail=exc.message
        ) from exc

    # Nothing below this line runs for an internal session: `is_external` is an
    # allowlist of the two partner roles, so an owner, a team member, the
    # observer and a machine credential all fall straight through unchanged.
    _refuse_unreachable_route(request, user)
    return user


# ══════════════════════════════════════════════════════════════════════════════
# Scoping one partner to their own records
# ══════════════════════════════════════════════════════════════════════════════


def partner_ids_of(user: dict, kind: str | None = None) -> set[str]:
    """Every partner record this session may read, or those of one kind.

    Read from the session, which took them from `partners` at sign-in — never
    from the request, and never from the uid. The old fallback here was
    `user.get("partner_id") or user["uid"]`, which silently treats a Firebase
    uid as a partner id: for an applicant with no approved record that turned a
    scope check into a lookup of a partner that does not exist, and the answer
    depended on what the service happened to do with an unknown id.
    """
    ids = {
        str(k): str(v)
        for k, v in dict(user.get("partner_ids") or {}).items()
        if str(v or "").strip()
    }
    if kind is not None:
        value = ids.get(str(kind))
        return {value} if value else set()
    return set(ids.values())


def own_partner_id_or_403(
    user: dict, requested_id: str, kind: str | None = None
) -> str:
    """Staff may read any partner. A partner may read only their own.

    `kind` is `"agency"` or `"seller"` on a route that can only mean one of
    them, and it does two things. It disambiguates `"me"` for a login holding
    both capabilities, and it stops a dual-role partner reading their *seller*
    record through an *agency* route — which would hand agency figures a seller
    id and answer with something nobody asked for.

    A partner with no ids on their session — an applicant under review — is
    refused here, on the same comparison that refuses somebody else's id.
    """
    if R.is_internal(user["role"]):
        return requested_id

    allowed = partner_ids_of(user, kind)
    if not allowed:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=(
                "This account has no approved partner record, so there is "
                "nothing to show yet."
            ),
        )

    requested = str(requested_id or "").strip()
    if requested in {"", "me"}:
        if len(allowed) != 1:
            # Only reachable for a dual-role login on a route that serves both
            # capabilities. Guessing which record they meant would be a coin
            # toss about whose money is displayed.
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=(
                    "This login holds more than one partner record. Name the "
                    "one you want rather than 'me'."
                ),
            )
        return next(iter(allowed))

    if requested not in allowed:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You can only view your own records.",
        )
    return requested


def own_session_uid(user: dict) -> str:
    """The subject of a self-scoped route: this session's own uid, and nothing else.

    For a route that takes NO id from the request — no path parameter, and no
    id field in its body — because what it acts on is the signed-in person
    themselves (Decision 15: "show me what is verified on my login", "start my
    approved role now that both contacts are verified"). An applicant whose
    role is waiting has no partner ids on the session at all, which is why
    `own_partner_id_or_403` cannot be the scope here: it would refuse exactly
    the person the route exists for.

    `tests/test_partner_session.py` holds a route that calls this to having no
    path parameter and no id field in its body, so it cannot become a way to
    name somebody else.
    """
    uid = str((user or {}).get("uid") or "").strip()
    if not uid:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="This session names no account.",
        )
    return uid


async def require_write(user: dict = Depends(current_user)) -> dict:
    """A write. The observer never does one, and neither does a partner.

    The observer half is spec 1.1.4 and is unchanged. The external half is new
    and is belt to the allowlist's braces: no `require_write` route is in
    `PARTNER_REACHABLE`, so a partner is already stopped in `current_user` —
    but this guard does not depend on that set being maintained. `require_write`
    is the dependency on partner approval, card verification, user bans and
    staff role changes, and it is the one that read as "any signed-in account
    that is not the observer".

    Nothing changes for an internal role: every role that satisfied this before
    satisfies it now.

    The two writes a partner *is* allowed to make do not weaken this. They were
    moved off this guard onto `require_write_or_partner` rather than punching a
    hole through it, so the sentence above stays literally true: no
    `require_write` route is partner-reachable, and a route that wants to admit
    a partner has to say so in its own signature where a reviewer sees it.
    """
    if R.is_external(user["role"]):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Not available to partner accounts.",
        )
    if not R.can_write(user["role"]):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="The observer account is read-only.",
        )
    return user


async def require_write_or_partner(user: dict = Depends(current_user)) -> dict:
    """A write that the spec puts in a partner's own hands, or a staff write.

    Five routes use this and no others. Three name a partner record:
    `POST /partner-ops/sellers/{id}/coin-purchases` (4.3.5) and
    `POST /partner-ops/sales` (4.3.8) — both raise a request that moves
    nothing, executed or approved by an owner — and Decision 16's
    `POST /partner-ops/agencies/{id}/sub-agencies/reapply`, which files a
    pending application staff decide. Two name nothing at all:
    `POST /partner-ops/me/verification/check` and `/conflict` (Decision 15),
    which act on `own_session_uid(user)` and take no id from the request.

    **This dependency does not scope anything, and a route that uses it without
    scoping is a hole.** It answers "may this caller write at all", which for a
    partner is not the interesting question — the interesting question is which
    seller id they are allowed to name, and the answer to that is
    `own_partner_id_or_403(user, …, kind="seller")` on the id in the URL or the
    body, in the route, before the service is called. `tests/
    test_partner_session.py` reads the router source and fails if a non-GET
    route on the allowlist does not do exactly that, so this cannot be forgotten
    quietly.

    Two things hold it in place even so. An external session reaches this at all
    only on a route named in `PARTNER_REACHABLE` — `current_user` has already
    refused every other one — and for an internal role this is `require_write`
    unchanged, observer refusal and all. Nothing an internal caller could do
    before moves.
    """
    if R.is_external(user["role"]):
        return user
    return await require_write(user)


async def require_owner(user: dict = Depends(current_user)) -> dict:
    """Only owners sign money. Spec 1.2.1."""
    if not R.is_owner(user["role"]):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only a business owner can approve this.",
        )
    return user


async def require_internal(user: dict = Depends(current_user)) -> dict:
    if not R.is_internal(user["role"]):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Not available to external accounts.",
        )
    return user


async def require_team_admin(user: dict = Depends(current_user)) -> dict:
    if not (R.is_team_admin(user["role"]) or R.is_owner(user["role"])):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Requires a team admin.",
        )
    return user


async def require_owner_provisioner(user: dict = Depends(current_user)) -> dict:
    """The observer, and nothing else. The one write it is allowed.

    ── WHY THIS IS A ROLE CHECK AND NOT A PERMISSION ─────────────────────────

    The organisation is

        Observer  →  Owners  →  six departments  →  admin  →  member

    and the observer's job at the top of it is to provision owners. But the
    observer has no CRM presence at all — no Firebase account, no `crmUsers`
    document (`crm_directory.NOT_MIRRORED` explains why: the CRM vocabulary's
    lowest tier is `superadmin`, so any document it were given would grant full
    write access on every Firestore-backed page), and it holds none of the
    twenty capabilities, which are mirrored from `zipper-crm/lib/auth.ts`.

    Adding a twenty-first for this would put a non-CRM authority into a table
    whose whole point is that it matches the front end, and would hand it to
    owners too, since `PERMISSIONS[OWNER]` is asserted to be every member of the
    enum. So the authority lives here: one route, one role, nothing inherited.

    ── WHY `require_write` IS NOT REUSED ─────────────────────────────────────

    It refuses the observer by name — spec 1.1.4, read-only — and that must keep
    being true everywhere else. Carving a hole in it would open every write the
    observer is deliberately kept away from. This guard stands alongside it
    rather than weakening it, and the route it guards cannot name a role at all:
    see `POST /staff/owners`, which hardcodes `Role.OWNER`.
    """
    if user["role"] != Role.OBSERVER:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only the observer provisions owner accounts.",
        )
    return user


# ══════════════════════════════════════════════════════════════════════════════
# The twenty capabilities — `app/core/roles.PERMISSIONS`, made a gate
# ══════════════════════════════════════════════════════════════════════════════
#
# The guards above are role *tiers*: not-the-observer, an owner, a team admin,
# internal. Every privileged route in this API was gated on one of them, and the
# one it was almost always gated on was `require_write` — which admits every
# staff role there is. So `POST /users/{uid}/ban` was open to a marketing member,
# `POST /partner-ops/partners/{id}/approve` to a tech member, and
# `POST /users/{uid}/balance-request` to anyone who could sign in. The CRM greyed
# those buttons out per permission and the API behind them did not ask.
#
# `require_permission` is the missing question. It is **additive**: it is applied
# alongside whatever guard a route already carried, never instead of it, and it
# is mounted in the route decorator's `dependencies=[…]` rather than in the
# endpoint signature so that the existing guard stays literally where a reviewer
# and `tests/test_partner_session.py` both read it.
#
# ── What it refuses, in order ────────────────────────────────────────────────
#
#   1. An external partner, and the observer. `require_write` is reused verbatim
#      rather than re-implemented, so those two refusals keep their own wording
#      and cannot drift from the thirty-odd routes that rely on them.
#   2. A role the model does not recognise, and a machine credential — see
#      `_resolved_role`.
#   3. The permission itself.
#   4. §19 — the role, re-established against the authoritative record. See
#      `_confirm_role_on_record`.
#
# ── What the 403 says ────────────────────────────────────────────────────────
#
# The capability that is missing, by name, and nothing else. Not the role, not
# what the role does hold, not who does hold it. A refusal that printed the grant
# matrix would let anybody with one staff login enumerate the whole authority
# model from the outside; naming the one capability asked for tells the person
# what to ask their admin for and tells an attacker what they already knew.


def _resolved_role(user: dict) -> R.Role:
    """The caller's role as a `Role`, or a refusal. Never a guess.

    Two values reach here that are not members of the enum, and both are refused
    rather than being allowed to fall through `permissions_of` as "holds
    nothing":

      * a **machine credential**, which wears `SYSTEM_ROLE`. No route mounts
        `require_permission` as a dependency *and* accepts a service key — the
        three that check a capability with a machine in play call
        `enforce_permission`, which handles it explicitly — so this should be
        unreachable. "Unreachable" is a property of a route list that changes,
        though, and a credential is not a person with a capability list: if one
        ever does arrive here, the answer is no.
      * a **role string the model does not know**: a legacy value left by a
        migration, a hand-edited `staff` row, a token minted before a rename.
        `permissions_of` answers "nothing" for these, which would already refuse
        — but it refuses with "you do not hold can_ban_users", which sends
        somebody to ask for a permission they can never be granted. The refusal
        below says the real thing, and logs it, because a session carrying a role
        this process cannot name is an operational fault, not a user error.
    """
    raw = user.get("role")
    if R.is_system(raw):
        log.error(
            "A service actor (%s) reached a permission-gated route.",
            user.get("uid", ""),
        )
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="This action requires a person.",
        )
    try:
        return R.Role(str(raw))
    except ValueError:
        log.error(
            "Session %s carries role %r, which is not in the role model. "
            "Refusing every privileged action for it.",
            user.get("uid", ""),
            str(raw),
        )
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=(
                "Your account's role could not be established, so nothing "
                "privileged can be done with it. Sign in again; if this "
                "persists, your account needs repairing by an administrator."
            ),
        ) from None


async def _confirm_role_on_record(user: dict, claimed: R.Role) -> None:
    """§19 — re-establish the role from Mongo before anything sensitive happens.

    ── The state this exists for ────────────────────────────────────────────

    A staff account is two records and `services/staff.py` writes Mongo first,
    Firestore second. When the second write fails, `_carry_to_crm` raises,
    audits `staff.mirror_failed` and tells the caller — but **the Mongo change
    has already landed**, and the operator has just been shown an error. So the
    two stores disagree, and the person who would have to notice has been told
    the operation failed. The same divergence arrives by other doors too: a role
    changed by `scripts/repair_staff_accounts.py`, by a migration, or by hand in
    Atlas revokes no session at all, which `renew_session` already says out loud
    ("the role that was changed by a script, a migration or a hand edit").

    A session token carries its role as a claim. Between issue and expiry that
    claim is a snapshot, and `verify_session` — one indexed read, on the hot path
    of every request — deliberately does not re-check it.

    ── What this does about it ──────────────────────────────────────────────

    For a **permission-gated action only**, the role is read back from `staff`,
    which is the record `sign_in_with_firebase` authorises against and therefore
    the only thing entitled to answer the question. The request proceeds when the
    row exists, is active, and carries the same role the token does. Anything
    else is refused: a missing row, a deactivated one, or a role that has moved
    under the session.

    ── Why not everywhere, and why not a stored "out of step" flag ──────────

    **Not everywhere** because the instruction is to fail closed on a sensitive
    operation, not to break reading. Putting this in `current_user` would add a
    second database read to every request in the API, and would turn a
    half-repaired account into a person who cannot even open a screen to see
    what is wrong. Reads keep working; the writes that matter stop.

    **Not a flag** — the obvious alternative was for `_carry_to_crm` to stamp
    `crm_directory_out_of_step` on the row and to refuse anyone carrying it. It
    was rejected for three reasons: it needs a new field with no migration to
    write it onto existing rows, a clearing path in the repair script and in
    every success branch (a flag that is never cleared is a locked-out company),
    and it introduces a *second* opinion about whether a role is trustworthy
    beside the record that already holds the answer. Reading the authoritative
    record is the cheaper and less forgeable version of the same check, and it
    additionally covers the three divergence doors that never touch
    `_carry_to_crm` at all.

    **What it cannot do**: make a stale *Firestore* document stop granting
    access. `crmUsers.permissions` and `crmUsers.isActive` are read by
    `firestore.rules`, which is not in this process. A failed mirror still needs
    `REPAIR_COMMAND` run, and the audit entry still says so.
    """
    # Imported here rather than at module scope. `app/core/deps.py` is imported
    # by every router; `app/db/mongo.py` is where the client lives, and a module
    # that only some requests need should not be part of the import graph of the
    # ones that do not.
    from app.db.mongo import C, get_db

    uid = str(user.get("uid", "") or "")
    if not uid:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="This session names no account, so nothing can be done with it.",
        )

    row = await get_db()[C.STAFF].find_one({"uid": uid})
    if row is None:
        # Every internal session is minted from a `staff` row, so this means the
        # row went away underneath a live token — a reset, a deletion, a repair
        # that moved the uid. There is no record to establish a role from.
        log.warning(
            "Session %s (%s) has no staff row; refusing a privileged action.",
            uid,
            str(claimed),
        )
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=(
                "Your staff record could not be found, so your role could not "
                "be confirmed. Sign in again."
            ),
        )

    if not row.get("is_active", True):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="This account has been deactivated.",
        )

    on_record = str(row.get("role", ""))
    if on_record != str(claimed):
        log.warning(
            "Session %s carries %s; the staff record says %s. Refusing.",
            uid,
            str(claimed),
            on_record or "<nothing>",
        )
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Your role has changed. Sign in again.",
        )


async def enforce_permission(
    user: dict, *needed: R.Permission, any_of: bool = False
) -> None:
    """The same capability check, for a caller that is not a plain dependency.

    Three routes need this rather than `require_permission`:

      * `POST /partner-ops/partners` and
        `POST /partner-ops/agencies/{id}/commission-accruals` also accept an
        `X-Service-Key`. A dependency starts from `current_user`, which demands
        an `Authorization` header a machine does not send, so mounting one would
        refuse the Firestore trigger and the Sunday job with a 401 about a
        missing session. They call this from the body instead, **after** their
        own service branch.
      * `POST /users/reports/{id}/action` carries its verdict in the body, and
        the verdict is what decides how much authority it costs. A dependency
        cannot see a body, so the route declares the floor as a dependency and
        the rest here.

    A machine reaching here is let through rather than refused, and that is not
    a hole: it got here only by presenting a key whose `SERVICE_CREDENTIALS`
    entry names this exact operation, which is a tighter grant than any role
    holds. Deliberately not the same answer `_resolved_role` gives, because
    there the machine's presence is unexplained and here it is the documented
    path — and there is no `staff` row to re-establish a machine's role from,
    which is the other reason this branch returns early.
    """
    if R.is_system(user.get("role")):
        return
    role = _resolved_role(user)
    _check_permissions(user, role, tuple(needed), any_of)
    # §19 applies to a person here exactly as it does in the dependency. The
    # reports queue pays for a second read of the same row when a verdict needs
    # a second capability; that is one indexed lookup on a moderation decision,
    # and the alternative — a check that means one thing on most privileged
    # routes and something weaker on three of them — is not worth saving it.
    await _confirm_role_on_record(user, role)


def _check_permissions(
    user: dict, role: R.Role, wanted: tuple[R.Permission, ...], any_of: bool
) -> None:
    """Refuse unless the role holds what was asked for. Names only what is
    missing — see the section comment on why the refusal says nothing else."""
    missing = R.missing_permissions(role, wanted)
    if (len(missing) < len(wanted)) if any_of else not missing:
        return

    log.warning(
        "%s (%s) was refused %s: missing %s.",
        user.get("uid", ""),
        str(role),
        ("any of " if any_of else "") + ", ".join(str(p) for p in wanted),
        ", ".join(str(p) for p in missing),
    )
    joiner = " or " if any_of else " and "
    raise HTTPException(
        status_code=status.HTTP_403_FORBIDDEN,
        detail=(
            "Your account does not have the "
            + joiner.join(f"'{p}'" for p in missing)
            + " permission"
            + ("s" if len(missing) > 1 and not any_of else "")
            + ", which this action requires. Ask an administrator."
        ),
    )


def require_permission(
    *needed: R.Permission, any_of: bool = False
) -> Callable[..., Awaitable[dict]]:
    """Build a dependency that admits only a role holding these capabilities.

    Several may be named. By default **all** of them are required; `any_of=True`
    asks for at least one, which is what a route serving two kinds of record
    needs — `POST /partner-ops/partners/{id}/approve` approves an agency or a
    seller and the kind is on the record, not in the request, so it cannot
    demand the one that matches without reading the record first.

    Usage is in the decorator, not the signature:

        @router.post(
            "/{uid}/ban",
            dependencies=[Depends(require_permission(Permission.CAN_BAN_USERS))],
        )
        async def ban_user(uid: str, body: Reason, user: dict = Depends(require_write)):

    That placement is deliberate. The existing guard stays exactly where it was,
    so "permissions are additive" is visible in the diff rather than asserted in
    a comment — and `tests/test_partner_session.py` reads the endpoint signature
    out of the source to prove no partner-reachable route lost its guard, which a
    replacement would have quietly defeated.
    """
    if not needed:
        raise ValueError(
            "require_permission() with no capability admits everybody, which is "
            "the bug it exists to fix. Name at least one."
        )
    wanted = tuple(R.Permission(str(p)) for p in needed)

    async def dependency(user: dict = Depends(require_write)) -> dict:
        role = _resolved_role(user)
        _check_permissions(user, role, wanted, any_of)
        await _confirm_role_on_record(user, role)
        return user

    dependency.__name__ = "requires_" + ("_or_" if any_of else "_and_").join(
        str(p) for p in wanted
    )
    dependency.required_permissions = wanted  # type: ignore[attr-defined]
    dependency.requires_any = any_of  # type: ignore[attr-defined]
    return dependency


# ══════════════════════════════════════════════════════════════════════════════
# The machine door
# ══════════════════════════════════════════════════════════════════════════════
#
# Every dependency above resolves one thing: a session held by a person. The
# two built below also accept an `X-Service-Key`, and they are the *only* two
# in the API that do. `app/core/security.py` decides whether a presented key is
# real and whether the operation being attempted is inside that credential's
# allowlist; this file only decides which routes are allowed to ask.
#
# Note the shape: a key that is present and wrong is **refused**, not quietly
# ignored in favour of the `Authorization` header. A caller that sends a
# service key is asserting it is a machine, and a machine with a bad key gets
# 401 rather than a confusing 403 about team admins.


def _person_or_service(
    operation: str,
    person: Callable[[dict], Awaitable[dict]],
) -> Callable[..., Awaitable[dict]]:
    """Build a dependency that accepts a session **or** a service credential.

    `operation` is checked against the credential's allowlist, so widening a
    credential means editing `SERVICE_CREDENTIALS`, not adding a route.
    """

    async def dependency(
        request: Request = None,  # type: ignore[assignment]
        authorization: str = Header(default=""),
        x_service_key: str = Header(default="", alias=SERVICE_KEY_HEADER),
    ) -> dict:
        if x_service_key:
            try:
                return verify_service_key(x_service_key, operation)
            except AuthError as exc:
                raise HTTPException(
                    status_code=status.HTTP_401_UNAUTHORIZED, detail=str(exc)
                ) from exc
        # The request is carried through so the partner allowlist is applied on
        # these routes too. None of them is in it, and the person fallback below
        # refuses an external role in any case — but a dependency that dropped
        # the request would be the one place the allowlist did not run.
        return await person(await current_user(request, authorization))

    dependency.__name__ = f"allows_service_{operation.replace('.', '_')}"
    dependency.service_operation = operation  # type: ignore[attr-defined]
    return dependency


#: Commission accrual. A team admin as before, or the weekly accrual job.
team_admin_or_accrual_service = _person_or_service(
    Op.COMMISSION_ACCRUE, require_team_admin
)

#: The read-only preview of the same figure. Any internal account as before, or
#: the weekly accrual job — which previews first so the sanity bound is checked
#: against a figure before anything is credited from it.
internal_or_accrual_service = _person_or_service(
    Op.COMMISSION_PREVIEW, require_internal
)

# ── Part 8A — reporting, alerting and transactional email ────────────────────
#
# A different credential from the accrual one, with a different key. These four
# send mail and nothing else: no balance moves, no card is signed, no liability
# is created. The person fallback is a team admin (which includes owners), so
# anyone who can already read a business-wide report can also make it go out on
# demand — and cannot redirect it, because every recipient is resolved from the
# staff record by `services/notify.py`, never from the request.

#: 8A.3 — generate and email a scheduled report or a partner statement.
team_admin_or_reporting_service = _person_or_service(
    Op.REPORTS_SEND, require_team_admin
)

#: 8A.4 — run the exception detectors and send what is newly true.
team_admin_or_alerts_service = _person_or_service(Op.ALERTS_SCAN, require_team_admin)

#: 8A.2 — send transactional mail that a record says is owed and that the
#: delivery log says has not gone out.
team_admin_or_email_sweep_service = _person_or_service(
    Op.EMAIL_SWEEP, require_team_admin
)

#: 8A.7.5 — the SendGrid Event Webhook. Bounces and drops arrive here, so the
#: caller is a machine in practice; `require_internal` is the person fallback so
#: an operator can replay a batch by hand.
internal_or_email_events_service = _person_or_service(
    Op.EMAIL_EVENTS, require_internal
)

# ── Onboarding — registering a partner that already exists in Firestore ──────
#
# A third credential again, and for the same reason the reporting one is a
# second: what a leaked key can reach should be the smallest thing that makes
# the flow work. This one reaches exactly `POST /partner-ops/partners`.
#
# **The person side of this route is unchanged.** It was `require_team_admin`
# before and it is `require_team_admin` now — the same fallback, the same
# refusal, the same message. Nothing about a staff member's authority here moves;
# a machine door is added beside it, which is the same shape commission accrual
# has carried since Part 8.
#
# The browser cannot do this itself, and that is not an oversight to route
# around. `security.sign_in_with_firebase` resolves a role from the Mongo `staff`
# collection, and no agency or seller is ever written there — so an applicant
# holds a Firebase login and **no API session at all**. There is nobody at the
# keyboard with the authority to create the record, which is why an unattended
# credential has to.

#: The Firestore triggers `registerAgencyPartner` / `registerSellerPartner`, or a
#: team admin as before.
team_admin_or_partner_registration_service = _person_or_service(
    Op.PARTNER_REGISTER, require_team_admin
)

#: The app's "Join as …" callables, or a team admin filing on somebody's
#: behalf. Same key as registration; see `Op.PARTNER_APPLY`.
team_admin_or_partner_apply_service = _person_or_service(
    Op.PARTNER_APPLY, require_team_admin
)

#: The app's recharge-request callable, or a team admin. See `Op.RECHARGE_REQUEST`.
team_admin_or_recharge_request_service = _person_or_service(
    Op.RECHARGE_REQUEST, require_team_admin
)


def deny_service_actor(user: dict) -> None:
    """Belt and braces for a route that must never see a machine.

    Nothing needs this today — a service key reaches only the two dependencies
    above — but a route that hands a caller's actor to something dangerous can
    call it and stop depending on that fact staying true.
    """
    if is_service_actor(user):
        log.error(
            "A service actor (%s) reached a route that refuses machines.",
            user.get("uid", ""),
        )
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="This action requires a person.",
        )
