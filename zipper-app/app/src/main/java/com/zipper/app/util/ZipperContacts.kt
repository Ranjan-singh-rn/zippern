package com.zipper.app.util

/**
 * QA #47 (3 Nov 2026) — Zipper's email identities, in one place in the app.
 *
 * Owner decision, final: the domain is zipperlive.org, with exactly three
 * addresses. [NO_REPLY] sends every automated message and is never shown as
 * somewhere to write; [SUPPORT] is where a person writes for help (support,
 * appeals, privacy requests); [INFO] is general business information.
 *
 * The app used to name addresses on domains Zipper does not use, on the Banned
 * screen, in the Privacy Policy and in the map lookup's required contact (the
 * list is in qa/QA-FINDINGS.md, #47). The same three addresses live in
 * `backend/app/core/contacts.py`, `functions/src/mail.ts` and
 * `zipper-crm/lib/contacts.ts`; `ZipperContactsTest` checks they agree.
 */
object ZipperContacts {
    const val DOMAIN = "zipperlive.org"
    const val NO_REPLY = "no-reply@$DOMAIN"
    const val SUPPORT = "support@$DOMAIN"
    const val INFO = "info@$DOMAIN"
}
