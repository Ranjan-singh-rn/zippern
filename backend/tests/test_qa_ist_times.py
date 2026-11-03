"""QA #54 (3 Nov 2026) — times a person reads are shown in India Standard Time.

The notices, the emails and the Host-role refusal printed UTC: an Indian user
read "until 03 Nov 2026, 22:21 UTC" for something that ends at 3:51 the next
morning. Stored values stay UTC; only the WORDS change, and they are the same
words the Cloud Functions (`hostEligibility.whenIst`) and the app
(`IstTime.format`) print, so a notice, an email and a screen agree.

REAL: `app.services.email.when`, `users._host_term`, `owner_mfa._lock_time`,
`notices.account_restriction`'s body. Stubbed I/O only (tests/harness.py).

    python3 -m tests.test_qa_ist_times
"""

from __future__ import annotations

import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from tests.harness import install_stubs  # noqa: E402

install_stubs()

from app.services import email as mail  # noqa: E402
from app.services import owner_mfa  # noqa: E402
from app.services import users  # noqa: E402

checks = 0
failures: list[str] = []


def eq(claim: str, got, want) -> None:
    global checks
    checks += 1
    if got != want:
        failures.append(f"{claim}\n        got  {got!r}\n        want {want!r}")


utc = timezone.utc

# The QA example: 22:21 UTC on 3 Nov is 3:51 am on 4 Nov in India.
eq("a UTC instant is read in IST, saying so", mail.when(datetime(2026, 11, 3, 22, 21, tzinfo=utc)),
   "4 Nov 2026, 3:51 am IST")
eq("…the afternoon", mail.when(datetime(2026, 11, 4, 10, 15, tzinfo=utc)), "4 Nov 2026, 3:45 pm IST")
eq("…midnight and noon in India", [mail.when(datetime(2026, 11, 3, 18, 30, tzinfo=utc)),
                                   mail.when(datetime(2026, 11, 4, 6, 30, tzinfo=utc))],
   ["4 Nov 2026, 12:00 am IST", "4 Nov 2026, 12:00 pm IST"])
eq("…a naive stamp is UTC, as stored", mail.when(datetime(2026, 11, 3, 22, 21)), "4 Nov 2026, 3:51 am IST")
eq("…another zone's stamp is converted", mail.when(datetime(2026, 11, 3, 17, 21, tzinfo=timezone(timedelta(hours=-5)))),
   "4 Nov 2026, 3:51 am IST")
eq("…the date alone", mail.when(datetime(2026, 12, 31, 23, 59, tzinfo=utc), with_time=False), "1 Jan 2027")
eq("…nothing is a dash, text is text", [mail.when(None), mail.when("soon")], ["—", "soon"])

eq("the Host-role sentence says the same words as the Functions and the app",
   users._host_term(datetime(2026, 11, 4, 10, 15, tzinfo=utc)), "until 4 Nov 2026, 3:45 pm IST")
eq("…indefinite", users._host_term(None), "until it is resumed")

eq("the Owner lock-out says when, in IST", owner_mfa._lock_time(datetime(2026, 11, 3, 10, 15, tzinfo=utc)),
   "3:45 pm IST")

print()
if failures:
    print(f"{len(failures)} of {checks} IST checks FAILED:")
    for f in failures:
        print("  ✗ " + f)
    sys.exit(1)
print(f"All {checks} IST time checks passed.")
print("  · QA #54: notices, emails, the Host-role refusal and the Owner lock-out read in IST")
