"""Turning a missing Firestore index into an answer somebody can act on.

── WHY THIS EXISTS ─────────────────────────────────────────────────────────

`GET /api/users/appeals` filtered on `status` and ordered by `createdAt`. That
needs a composite index, and the one for `appeals` was never declared — every
comparable CRM queue (`reports`, `coinPurchaseRequests`, `withdrawalRequests`,
`approvalRequests`) had its own, appeals did not. Firestore raised
`FailedPrecondition`, the route did not catch it, there is no global exception
handler, and FastAPI returned a bare

    500 {"detail": "Internal Server Error"}

The CRM showed "Could not load this — Internal Server Error" on four of its
five tabs, with nothing on the screen or in the response to say that the cause
was a one-line JSON file and a deploy. The fifth tab worked, which made it look
like a data problem rather than a schema one.

── WHY 503 AND NOT 500 ─────────────────────────────────────────────────────

The request was well-formed and the caller can do nothing about it, so it is
not a 4xx. The service is temporarily unable to answer and will be able to once
the index finishes building, which is the definition of 503. It also reads
correctly on a dashboard: a burst of 503s is infrastructure, a burst of 500s is
a bug.

── WHY THE CONSOLE URL IS PASSED THROUGH ───────────────────────────────────

Firestore puts a direct "create this index" link in the exception message. That
link is the entire fix. Dropping it to avoid leaking internals would be a
false economy — these routes are behind `current_user`, the link names a
project id that every CRM operator already knows, and without it the next
person has to reconstruct the query by hand.
"""

from __future__ import annotations

import logging
import re

from fastapi import HTTPException, status

log = logging.getLogger(__name__)

#: Firestore embeds the remedy in the message. Pulled out so the detail can
#: carry the link without carrying the rest of the gRPC noise around it.
_INDEX_URL = re.compile(r"https://console\.firebase\.google\.com/\S+")


def index_unavailable(exc: Exception, what: str) -> HTTPException:
    """503 for a query whose composite index is missing or still building.

    `what` names the thing the operator was trying to read, in words that make
    sense on a CRM screen — "the appeals queue", not "list_appeals".
    """
    text = str(exc)
    link = _INDEX_URL.search(text)

    # Logged in full, including the query shape, because the response
    # deliberately carries only the sentence and the link.
    log.error("Firestore index missing for %s: %s", what, text)

    detail = (
        f"{what.capitalize()} cannot be read right now: the database index it "
        "needs has not finished building. Nothing is wrong with the request, "
        "and no data is affected — try again once the index is ready."
    )
    if link:
        detail += f" Create or check it here: {link.group(0)}"

    return HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=detail)
