"""QA #54 — the words for a moment a PERSON reads: India Standard Time.

Every timestamp is stored in UTC and stays UTC. Notices, emails and refusals
used to print UTC ("04 Nov 2026, 10:15 UTC"), which every recipient — in India
— had to convert. They now print "4 Nov 2026, 3:45 pm IST": the same words as
`functions/src/hostEligibility.ts::whenIst` and the app's `IstTime.format`,
written out by hand (no locale) so the three cannot drift.

Pure: no I/O, no settings — imported by `services.email.when`,
`services.users._host_term` and `services.owner_mfa`.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

#: UTC+05:30 all year — India has no daylight saving.
IST = timezone(timedelta(hours=5, minutes=30), "IST")
_MONTHS = ("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")


def _local(value: datetime) -> datetime:
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.astimezone(IST)


def clock(value: datetime) -> str:
    """'3:45 pm IST' — the clock time in IST."""
    local = _local(value)
    hour = local.hour % 12 or 12
    return f"{hour}:{local.minute:02d} {'am' if local.hour < 12 else 'pm'} IST"


def when(value: Any, *, with_time: bool = True) -> str:
    """'4 Nov 2026, 3:45 pm IST' (or '4 Nov 2026'); '—' for None; other values as text."""
    if value is None:
        return "—"
    if not isinstance(value, datetime):
        return str(value)
    local = _local(value)
    date = f"{local.day} {_MONTHS[local.month - 1]} {local.year}"
    return f"{date}, {clock(value)}" if with_time else date
