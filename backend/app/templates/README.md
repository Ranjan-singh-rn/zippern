# Email templates — spec 8A.7.2

Marketing owns the wording in this directory. Tech owns delivery, which is
`app/services/email.py`. Changing a sentence here needs no Python change and no
deploy of the send path.

## The token syntax

There is no template engine and no new dependency. Two tokens, handled by
`email.render()`:

| Token | Meaning |
|---|---|
| `{{ name }}` | The value, **HTML-escaped**. Use this for anything a person typed — a rejection reason, a partner name, a UTR. |
| `{{{ name }}}` | The value inserted **raw**. Only for HTML fragments this codebase built itself. |

A token with no value supplied raises `TemplateError` and the mail is not sent.
That is deliberate: an email that reads "Your payout of None has been paid" is
worse than an email that did not go out, because the second one is recorded as
a failure someone sees (8A.2.15).

## Rules the wording must keep

* **State the fact, the figure, the reason and what happens next.** A rejection
  or an overdue notice is how a partner learns where they stand (Part 0).
* **Every figure states its currency.** `email.money()` renders minor units as
  `₹1,250.05 INR`. Never write a bare number.
* **Never say ₹0 when the answer is "nothing happened".** Report bodies are
  built by `email.report_body()`, which withholds the totals table entirely on
  an empty report and prints the explanation instead (8A.6.5).
* **Say which rate was used** when a report is provisional. `report_body()`
  renders that banner from the report's own `rates` block.
* **No hedging, no blame.**

## Previewing before it goes live — 8A.7.3

    GET /api/notifications/email-templates                 → every template and its spec point
    GET /api/notifications/email-templates/{name}/preview  → the rendered HTML, sample data

Nothing is sent by a preview.
