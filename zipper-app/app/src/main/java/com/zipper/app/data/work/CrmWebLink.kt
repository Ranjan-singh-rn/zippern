package com.zipper.app.data.work

/**
 * The full CRM, opened from the Work tab (5 Nov 2026).
 *
 * The Work tab's own screens cover the daily partner and staff work natively. Everything else the CRM offers — an
 * agency inviting a host, filing a salary request, adding a sub-agency, updating KYC and payment details — is one
 * tap away in the CRM itself, which on a phone opens as a browser tab over the app. The CRM signs the person in and
 * decides what they may see exactly as on a computer: this only picks the page to start on.
 *
 * Pure (no Android), so `CrmWebLinkTest` runs it on the JVM.
 */
object CrmWebLink {

    /** The CRM page a session starts on: a single-role partner's own dashboard, otherwise the CRM's front door. */
    fun path(caps: Caps): String = when {
        caps.isAgencyPartner && !caps.isSellerPartner -> "/agency-dashboard/"
        caps.isSellerPartner && !caps.isAgencyPartner -> "/seller-dashboard/"
        // Both roles: the CRM's own role switcher. An applicant: the CRM sends them to their waiting page.
        else -> "/"
    }

    /**
     * The address to open, or null when this build has no CRM address (a build without one shows no entry).
     * Only http(s) — the value comes from the build, but a typo must not become an intent for another scheme.
     */
    fun url(base: String, caps: Caps): String? {
        val b = base.trim().trimEnd('/')
        if (!(b.startsWith("https://") || b.startsWith("http://"))) return null
        if (b.removePrefix("https://").removePrefix("http://").isBlank()) return null
        return b + path(caps)
    }

    /** Whether the Work hub offers the entry: any signed-in work account (staff or partner, approved or applying). */
    fun offered(caps: Caps): Boolean = caps.isInternal || caps.isExternal
}
