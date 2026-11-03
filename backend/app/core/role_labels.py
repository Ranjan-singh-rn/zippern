"""QA #39 (3 Nov 2026) — a staff role, in the words the CRM uses.

The invitation email said "Support Member" (the role id with underscores
replaced) while every CRM screen says "Support Team", so a new colleague was
told one title and shown another. These are the CRM's own labels
(`zipper-crm/app/team/page.tsx` → `ROLE_LABEL`); `zipper-crm/lib/staffInvite.spec.ts`
checks the two lists agree whenever the backend sits beside the CRM.

Pure: no I/O, no settings.
"""

from __future__ import annotations

STAFF_ROLE_LABELS: dict[str, str] = {
    "owner": "Business Owner",
    "observer": "Observer",
    "app_admin": "App Admin",
    "app_member": "App Team",
    "ops_admin": "Ops Admin",
    "ops_member": "Ops Team",
    "finance_admin": "Finance Admin",
    "finance_member": "Finance Team",
    "tech_admin": "Tech Admin",
    "tech_member": "Tech Team",
    "support_admin": "Support Admin",
    "support_member": "Support Team",
    "marketing_admin": "Marketing Admin",
    "marketing_member": "Marketing Team",
}


def staff_role_label(role: object) -> str:
    """"Support Team" for `support_member`; an unknown role, tidied, as before."""
    key = str(getattr(role, "value", role) or "").strip()
    return STAFF_ROLE_LABELS.get(key) or key.replace("_", " ").title()
