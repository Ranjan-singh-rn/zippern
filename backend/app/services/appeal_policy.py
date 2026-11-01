"""RC (confirmed) — another appeal after a decision needs new evidence or a valid reason.

    "Preserve prior appeal and decision history. Permit another appeal after a
    decision only with new evidence or a valid reason."

One rule, applied on every server path that files an appeal or a
reinstatement request (the same rule is in `firestore.rules` for the app's own
writes and in `functions/src/appealIds.ts` for the device-key path):

  * no earlier DECIDED appeal for the same restriction (or role) → allowed,
    exactly as before;
  * otherwise allowed only with NEW EVIDENCE (at least one file this time), or
    a REASON that is not one already decided — a statement that repeats a
    decided one, word for word once case and spacing are ignored, is neither
    new evidence nor a new reason.

The decided appeals themselves are never touched: they are the history the
new one is read against.
"""

from __future__ import annotations

import re
from typing import Iterable

REAPPEAL_REFUSAL = (
    "This was already decided. To appeal again, add new evidence, or explain what is new "
    "since the decision — repeating the earlier statement is not enough."
)


def normalise(text: str) -> str:
    return re.sub(r"\s+", " ", str(text or "")).strip().lower()


def reappeal_problem(previous_decided: Iterable[str], statement: str, evidence_count: int = 0) -> str:
    """'' when this appeal may be filed; otherwise the refusal sentence.

    `previous_decided` are the statements of the DECIDED appeals for the same
    restriction or role (pending ones are refused elsewhere, as before).
    """
    decided = [normalise(s) for s in previous_decided]
    if not decided:
        return ""
    if int(evidence_count or 0) > 0:
        return ""
    if normalise(statement) in decided:
        return REAPPEAL_REFUSAL
    return ""
