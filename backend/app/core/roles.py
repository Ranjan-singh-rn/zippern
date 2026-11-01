"""Roles and what each may do.

Mirrors Part 1 of CRM-FLOW.md. This module is the single place authority is
defined — nothing else should hardcode a role string.
"""

from __future__ import annotations

from app.core.compat import StrEnum


class Team(StrEnum):
    APP = "app"
    OPS = "ops"
    FINANCE = "finance"
    TECH = "tech"
    SUPPORT = "support"
    MARKETING = "marketing"


class Role(StrEnum):
    # Governance
    OBSERVER = "observer"            # 1.1 — reads everything, writes nothing
    OWNER = "owner"                  # 1.2 — the three business owners

    # Departments — 1.3 / 1.4
    APP_ADMIN = "app_admin"
    APP_MEMBER = "app_member"
    OPS_ADMIN = "ops_admin"
    OPS_MEMBER = "ops_member"
    FINANCE_ADMIN = "finance_admin"
    FINANCE_MEMBER = "finance_member"
    TECH_ADMIN = "tech_admin"
    TECH_MEMBER = "tech_member"
    SUPPORT_ADMIN = "support_admin"
    SUPPORT_MEMBER = "support_member"
    MARKETING_ADMIN = "marketing_admin"
    MARKETING_MEMBER = "marketing_member"

    # External — 1.6
    AGENCY = "agency"
    SELLER = "seller"


# ── The machine ───────────────────────────────────────────────────────────────
#
# `system` is deliberately **not** a member of `Role`. Nothing signs in as it,
# no session is ever issued carrying it, and no staff record may be given it —
# if it were an enum member, a row in `staff` with `role: "system"` would mint a
# real session with the machine's name on it. It is a label an unattended
# credential wears in the audit log, resolved in `app/core/security.py`, and
# every predicate below answers "no" for it by falling through: it is not
# internal, it is not an admin, it signs nothing and it reads nothing.
SYSTEM_ROLE = "system"


def is_system(role) -> bool:
    """Is this actor a machine credential rather than a person?"""
    return str(role) == SYSTEM_ROLE


ADMIN_ROLES: frozenset[Role] = frozenset(
    {
        Role.APP_ADMIN,
        Role.OPS_ADMIN,
        Role.FINANCE_ADMIN,
        Role.TECH_ADMIN,
        Role.SUPPORT_ADMIN,
        Role.MARKETING_ADMIN,
    }
)

MEMBER_ROLES: frozenset[Role] = frozenset(
    {
        Role.APP_MEMBER,
        Role.OPS_MEMBER,
        Role.FINANCE_MEMBER,
        Role.TECH_MEMBER,
        Role.SUPPORT_MEMBER,
        Role.MARKETING_MEMBER,
    }
)

STAFF_ROLES: frozenset[Role] = ADMIN_ROLES | MEMBER_ROLES
INTERNAL_ROLES: frozenset[Role] = STAFF_ROLES | {Role.OWNER, Role.OBSERVER}
EXTERNAL_ROLES: frozenset[Role] = frozenset({Role.AGENCY, Role.SELLER})

_TEAM_OF: dict[Role, Team] = {
    Role.APP_ADMIN: Team.APP,
    Role.APP_MEMBER: Team.APP,
    Role.OPS_ADMIN: Team.OPS,
    Role.OPS_MEMBER: Team.OPS,
    Role.FINANCE_ADMIN: Team.FINANCE,
    Role.FINANCE_MEMBER: Team.FINANCE,
    Role.TECH_ADMIN: Team.TECH,
    Role.TECH_MEMBER: Team.TECH,
    Role.SUPPORT_ADMIN: Team.SUPPORT,
    Role.SUPPORT_MEMBER: Team.SUPPORT,
    Role.MARKETING_ADMIN: Team.MARKETING,
    Role.MARKETING_MEMBER: Team.MARKETING,
}


def team_of(role: Role) -> Team | None:
    return _TEAM_OF.get(role)


def is_owner(role: Role) -> bool:
    return role == Role.OWNER


def is_observer(role: Role) -> bool:
    return role == Role.OBSERVER


def is_team_admin(role: Role) -> bool:
    return role in ADMIN_ROLES


def is_internal(role: Role) -> bool:
    return role in INTERNAL_ROLES


def is_external(role) -> bool:
    """Is this an outside business — an agency or a coin seller? Spec 1.6.

    Deliberately **not** ``not is_internal(role)``. A machine credential wears
    `SYSTEM_ROLE`, which is internal to nothing and external to nothing, and a
    negation would quietly file it as a partner and hand it a partner's route
    allowlist. This is an allowlist of the two roles that really are outside
    businesses, and a role that is neither internal nor external answers "no"
    to both — which is the only safe answer to a question about an actor the
    role model does not recognise.
    """
    try:
        return Role(role) in EXTERNAL_ROLES
    except ValueError:
        return False


def partner_role_for(kind) -> Role:
    """The session role an external partner of this `partners.kind` holds.

    The only place a partner record's kind becomes a role. Three kinds map onto
    two roles — a sub-agency is an agency, because it is paid commission and
    reads an agency statement — and **anything else is refused rather than
    guessed**. A partner record with a corrupt or unknown `kind` is not given a
    session on the strength of whatever string it happens to carry.
    """
    text = str(kind or "").strip().lower()
    if text == "seller":
        return Role.SELLER
    if text in {"agency", "sub_agency"}:
        return Role.AGENCY
    raise ValueError(
        f"'{kind}' is not a partner kind this system issues sessions for. "
        "A session role is one of agency or seller and is never taken from an "
        "unrecognised value on a record."
    )


def can_write(role: Role) -> bool:
    """The observer never writes. Spec 1.1.4."""
    return role != Role.OBSERVER


def can_sign_money(role: Role) -> bool:
    """Only owners sign money. Spec 1.2.1 / 1.3.6 — verification is not approval."""
    return role == Role.OWNER


def can_verify_money(role: Role, card_team: Team | None) -> bool:
    """Who may verify a card before it reaches an owner for signature.

    * Finance admin — any card, whoever raised it (spec 3.5.8 / 9.3)
    * Team admin    — their own team's cards only (spec 5.5.1)
    * Owner         — any card

    Owners are included deliberately. They hold more authority than a team
    admin, so excluding them made no sense, and it left the system unable to
    process anything before staff were hired. Separation of duties is preserved
    a different way: whoever verifies a card cannot also sign it, enforced in
    `cards.sign`. So two different people are always involved.

    OWNER_DECISION_PENDING (spec §9, B2): the master specification says
    "Finance is the only non-Owner role permitted to verify money cards where
    defined". The accepted flow (spec 5.5.1) also lets a department admin
    verify their OWN department's cards, and that is what this predicate still
    does. Narrowing it to Finance alone is a one-line change here — made only
    on the Owner's word, because it changes who can move a card towards
    signature in every department.
    """
    if role == Role.OWNER:
        return True
    if role == Role.FINANCE_ADMIN:
        return True
    if not is_team_admin(role):
        return False
    return card_team is not None and team_of(role) == card_team


def can_read_all(role: Role) -> bool:
    """Observer and owners see the whole business. Spec 1.1.1 / 6.3."""
    return role in {Role.OBSERVER, Role.OWNER}


def audit_scope(role: Role) -> str:
    """How much of the audit log this role may read. Spec 6.3.

    ``"all"`` | ``"team"`` | ``"self"`` | ``"none"``. Anything `audit.query`
    does not recognise reads nothing, so ``"none"`` is a statement of intent
    rather than a new code path.
    """
    if is_system(role):
        # A machine credential is a *subject* of the audit log, never a reader
        # of it. It cannot reach `/audit` in any case — that route is
        # `require_internal`, which needs a session, and the service key is
        # accepted on two routes neither of which is this one. Stated here so
        # the answer does not depend on that being true elsewhere.
        return "none"
    if role in {Role.OBSERVER, Role.OWNER}:
        return "all"
    if is_team_admin(role):
        return "team"
    return "self"


# ══════════════════════════════════════════════════════════════════════════════
#  Permissions — the twenty capabilities, made authoritative here
# ══════════════════════════════════════════════════════════════════════════════
#
# These twenty existed only in the browser. `zipper-crm/lib/auth.ts` defined
# them, `createCrmUser` wrote them onto a `crmUsers` document, `hasPermission`
# read them back, and every screen greyed a button out accordingly — while the
# API behind that button asked one question, "are you not the observer and not a
# partner", and let a marketing member ban any account on the platform.
#
# So the table moved here, to the module that already owns the role model, and
# the CRM's copy became the replica: `services/crm_directory.DEFAULT_PERMISSIONS`
# is DERIVED from what is below (see `_crm_permission_table` there) rather than
# transcribed beside it. A permission written onto a Firestore document and a
# permission enforced on a route are now the same fact read twice, and the only
# way to widen a role is to widen it here, in a diff, for both.
#
# ── Why this table and not a predicate per capability ────────────────────────
#
# `can_write`, `can_sign_money` and `can_verify_money` above are predicates
# because each encodes a *rule* — the observer never writes, only owners sign,
# a team admin verifies their own team's cards. These twenty are not rules; they
# are a grant matrix that the business edits, and sixteen roles times twenty
# capabilities written as functions would be three hundred branches nobody could
# diff against the front end. A table can be compared to `lib/auth.ts` by a
# test, and `tests/test_permissions.py` does exactly that.
#
# ── Why the values are the CRM's strings ─────────────────────────────────────
#
# `Permission.CAN_BAN_USERS` is the string `"can_ban_users"`, which is what is
# stored in `crmUsers.permissions`, what `hasPermission` compares against and
# what `firestore.rules` reads. Inventing a second spelling would mean a
# translation layer between two vocabularies for one concept, which is the exact
# shape of bug `CRM_ROLE` already has to carry for the two governance roles.


class Permission(StrEnum):
    """One capability. Declaration order matches the `Permission` union in
    `zipper-crm/lib/auth.ts`, because that order is what is written into the
    `permissions` array on a `crmUsers` document."""

    # User management
    CAN_VIEW_USERS = "can_view_users"
    CAN_BAN_USERS = "can_ban_users"
    CAN_ADJUST_BALANCE = "can_adjust_balance"
    # Agency & KYC
    CAN_VIEW_AGENCIES = "can_view_agencies"
    CAN_APPROVE_KYC = "can_approve_kyc"
    # Seller management
    CAN_VIEW_SELLERS = "can_view_sellers"
    CAN_APPROVE_SELLER = "can_approve_seller"
    CAN_COIN_OPERATIONS = "can_coin_operations"
    # Finance
    CAN_VIEW_FINANCE = "can_view_finance"
    CAN_PROCESS_PAYOUT = "can_process_payout"
    # Config
    CAN_ECONOMY_CONFIG = "can_economy_config"
    CAN_COMMISSION_SLABS = "can_commission_slabs"
    CAN_APP_CONFIG = "can_app_config"
    # Tickets
    CAN_CREATE_TICKETS = "can_create_tickets"
    CAN_ASSIGN_TICKETS = "can_assign_tickets"
    CAN_CLOSE_TICKETS = "can_close_tickets"
    # Admin
    CAN_APPROVE_REQUESTS = "can_approve_requests"
    CAN_MANAGE_TEAM = "can_manage_team"
    CAN_MONITOR_LIVE = "can_monitor_live"
    # Marketing
    CAN_SEND_BROADCASTS = "can_send_broadcasts"


#: Every capability, in declaration order. `Role.OWNER` holds this set whole.
ALL_PERMISSIONS: tuple[Permission, ...] = tuple(Permission)


#: Role → what it may do. Keyed by the **Mongo** `Role`, which is the vocabulary
#: every session, every dependency and every audit entry in this process speaks.
#: `crm_directory.CRM_ROLE` is what translates a key here into the CRM's spelling
#: for the Firestore replica; nothing translates in the other direction, because
#: authority is decided here and mirrored there.
#:
#: Two roles hold nothing, for two different reasons:
#:
#:   * `OBSERVER` — read-only by design (1.1.4). It is listed explicitly rather
#:     than left out of the table, so that "the observer has no permissions" is
#:     a statement in the source and not a `.get(role, ())` default that would
#:     look identical for a role somebody forgot to add.
#:   * `AGENCY` / `SELLER` — an external partner is authorised by the record it
#:     owns (`own_partner_id_or_403`), never by a capability list. The CRM says
#:     the same thing with its two empty arrays.
PERMISSIONS: dict[Role, frozenset[Permission]] = {
    # The CRM's `hasPermission` short-circuits on `superadmin`; this is that
    # sentence written as data, so the two cannot disagree by omission.
    Role.OWNER: frozenset(ALL_PERMISSIONS),
    Role.OBSERVER: frozenset(),
    # ── App ───────────────────────────────────────────────────────────────────
    Role.APP_ADMIN: frozenset(
        {
            Permission.CAN_VIEW_USERS,
            Permission.CAN_BAN_USERS,
            Permission.CAN_ADJUST_BALANCE,
            Permission.CAN_VIEW_AGENCIES,
            Permission.CAN_VIEW_SELLERS,
            Permission.CAN_VIEW_FINANCE,
            Permission.CAN_APP_CONFIG,
            Permission.CAN_CREATE_TICKETS,
            Permission.CAN_ASSIGN_TICKETS,
            Permission.CAN_CLOSE_TICKETS,
            Permission.CAN_MANAGE_TEAM,
            Permission.CAN_MONITOR_LIVE,
        }
    ),
    Role.APP_MEMBER: frozenset(
        {
            Permission.CAN_VIEW_USERS,
            Permission.CAN_BAN_USERS,
            Permission.CAN_CREATE_TICKETS,
            Permission.CAN_MONITOR_LIVE,
        }
    ),
    # ── Operations ────────────────────────────────────────────────────────────
    Role.OPS_ADMIN: frozenset(
        {
            Permission.CAN_VIEW_USERS,
            Permission.CAN_VIEW_AGENCIES,
            Permission.CAN_APPROVE_KYC,
            Permission.CAN_VIEW_SELLERS,
            Permission.CAN_APPROVE_SELLER,
            Permission.CAN_VIEW_FINANCE,
            Permission.CAN_CREATE_TICKETS,
            Permission.CAN_ASSIGN_TICKETS,
            Permission.CAN_CLOSE_TICKETS,
            Permission.CAN_MANAGE_TEAM,
        }
    ),
    Role.OPS_MEMBER: frozenset(
        {
            Permission.CAN_VIEW_AGENCIES,
            Permission.CAN_VIEW_SELLERS,
            Permission.CAN_CREATE_TICKETS,
        }
    ),
    # ── Finance ───────────────────────────────────────────────────────────────
    Role.FINANCE_ADMIN: frozenset(
        {
            Permission.CAN_VIEW_USERS,
            Permission.CAN_ADJUST_BALANCE,
            Permission.CAN_VIEW_AGENCIES,
            Permission.CAN_VIEW_SELLERS,
            Permission.CAN_COIN_OPERATIONS,
            Permission.CAN_VIEW_FINANCE,
            Permission.CAN_PROCESS_PAYOUT,
            Permission.CAN_CREATE_TICKETS,
            Permission.CAN_ASSIGN_TICKETS,
            Permission.CAN_CLOSE_TICKETS,
            # Every department admin runs their own department. Finance and Tech
            # were the two that did not hold this, and the omission read as a
            # considered decision rather than a gap — so the CRM showed them an
            # Invite button that answered 403, and the attempted fix was to take
            # the button away. Both were wrong: the organisation model is that a
            # department admin creates members of their department, all six of
            # them. The narrowing that stops this becoming anything more lives in
            # `services/staff.assignable_roles`, which returns ONLY this role's
            # own team at member tier — never another department, never an admin,
            # never owner or observer.
            Permission.CAN_MANAGE_TEAM,
        }
    ),
    Role.FINANCE_MEMBER: frozenset(
        {
            Permission.CAN_VIEW_AGENCIES,
            Permission.CAN_VIEW_SELLERS,
            Permission.CAN_COIN_OPERATIONS,
            Permission.CAN_VIEW_FINANCE,
            Permission.CAN_PROCESS_PAYOUT,
            Permission.CAN_CREATE_TICKETS,
        }
    ),
    # ── Tech ──────────────────────────────────────────────────────────────────
    Role.TECH_ADMIN: frozenset(
        {
            Permission.CAN_ECONOMY_CONFIG,
            Permission.CAN_COMMISSION_SLABS,
            Permission.CAN_APP_CONFIG,
            Permission.CAN_CREATE_TICKETS,
            Permission.CAN_ASSIGN_TICKETS,
            Permission.CAN_CLOSE_TICKETS,
            # See the note on FINANCE_ADMIN. Tech is a department like any other
            # and its admin creates `tech_member`, and only `tech_member`.
            Permission.CAN_MANAGE_TEAM,
        }
    ),
    Role.TECH_MEMBER: frozenset(
        {
            Permission.CAN_ECONOMY_CONFIG,
            Permission.CAN_COMMISSION_SLABS,
            Permission.CAN_APP_CONFIG,
            Permission.CAN_CREATE_TICKETS,
        }
    ),
    # ── Support ───────────────────────────────────────────────────────────────
    Role.SUPPORT_ADMIN: frozenset(
        {
            Permission.CAN_VIEW_USERS,
            Permission.CAN_CREATE_TICKETS,
            Permission.CAN_ASSIGN_TICKETS,
            Permission.CAN_CLOSE_TICKETS,
            Permission.CAN_MANAGE_TEAM,
        }
    ),
    Role.SUPPORT_MEMBER: frozenset(
        {
            Permission.CAN_VIEW_USERS,
            Permission.CAN_CREATE_TICKETS,
            Permission.CAN_ASSIGN_TICKETS,
        }
    ),
    # ── Marketing ─────────────────────────────────────────────────────────────
    Role.MARKETING_ADMIN: frozenset(
        {
            Permission.CAN_SEND_BROADCASTS,
            Permission.CAN_CREATE_TICKETS,
            Permission.CAN_ASSIGN_TICKETS,
            Permission.CAN_CLOSE_TICKETS,
            Permission.CAN_MANAGE_TEAM,
        }
    ),
    Role.MARKETING_MEMBER: frozenset(
        {
            Permission.CAN_SEND_BROADCASTS,
            Permission.CAN_CREATE_TICKETS,
        }
    ),
    # ── External — 1.6 ────────────────────────────────────────────────────────
    Role.AGENCY: frozenset(),
    Role.SELLER: frozenset(),
}


def permissions_of(role) -> frozenset[Permission]:
    """Everything this role may do, or the empty set for anything unrecognised.

    **Fail closed.** A value that is not a `Role` member — a legacy string left
    on a hand-edited `staff` row, `SYSTEM_ROLE`, `None`, a role invented by a
    migration — answers "nothing" rather than raising. Raising here would turn a
    corrupt record into a 500 on a read; answering "nothing" turns it into a
    refusal on a write, which is the direction a permission check should fail in.
    Callers that need to *distinguish* "no permissions" from "no such role" ask
    `deps._resolved_role`, which refuses the request by name.
    """
    try:
        return PERMISSIONS.get(Role(str(role)), frozenset())
    except ValueError:
        return frozenset()


def has_permission(role, perm: Permission) -> bool:
    """May this role do this?

    `Role.OWNER` holds everything, asserted here as well as in the table. That
    mirrors `hasPermission` in `zipper-crm/lib/auth.ts`, which opens with
    `if (user.role === 'superadmin') return true` — an owner is not a role with
    a long permission list, it is the role the list does not apply to, and a
    capability added tomorrow belongs to them before anybody writes it down.
    """
    if is_owner_value(role):
        return True
    return perm in permissions_of(role)


def is_owner_value(role) -> bool:
    """`is_owner` for a value that may not be a `Role` — a raw session claim.

    Kept separate from `is_owner` above, which is typed for a `Role` and is
    called in a dozen places where the caller already has one. This one is for
    the boundary, where the value came out of a token.
    """
    try:
        return Role(str(role)) is Role.OWNER
    except ValueError:
        return False


def missing_permissions(role, needed) -> tuple[Permission, ...]:
    """Which of `needed` this role does NOT hold, in declaration order.

    Returned rather than a bare boolean so a refusal can name what is missing
    without the caller re-deriving it — and in a stable order, so the same
    refusal reads the same way twice.
    """
    wanted = {Permission(str(p)) for p in needed}
    return tuple(p for p in ALL_PERMISSIONS if p in wanted and not has_permission(role, p))


# ── What a session may do, said to the client that holds it (mobile parity) ──
#
# `GET /api/auth/me` answers with this, so a client — the Android app — decides
# which screens to OFFER from the server's own table instead of a copy of it.
# It decides nothing: every route still runs its own dependency, and a screen
# offered here that a route refuses is answered 403 exactly as before.
#
# Only the caller's own facts. A partner's ids are the ones already on their
# session (and on their sign-in response); an internal session is given none.
def capability_profile(role_value, partner_ids=None, partner_status=None) -> dict:
    try:
        role = Role(str(role_value))
    except ValueError:
        role = None
    internal = role is not None and is_internal(role)
    external = role is not None and is_external(role)
    return {
        "permissions": [str(p) for p in ALL_PERMISSIONS if role is not None and p in PERMISSIONS.get(role, frozenset())],
        "is_internal": internal,
        "is_external": external,
        "is_owner": role == Role.OWNER,
        "is_observer": role == Role.OBSERVER,
        "is_team_admin": role is not None and is_team_admin(role),
        "can_write": internal and can_write(role),
        "partner_ids": {str(k): str(v) for k, v in dict(partner_ids or {}).items()} if external else {},
        "partner_status": (str(partner_status) if partner_status is not None else None) if external else None,
    }
