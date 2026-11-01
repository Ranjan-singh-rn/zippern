package com.zipper.app.util

/**
 * B44 — does a `bannedDevices/{androidId}` document bar this handset?
 *
 * The server's answer (`resolveIdentity`, `claimGuestIdentity`, quick login) has
 * always been `exists && isActive != false`: a lifted bar is kept for the
 * record with `isActive: false` rather than deleted. The two client checks —
 * the cold-start read in SplashScreen and `AuthRepository.getDeviceBanReason`
 * — asked only whether the document existed, so a handset whose bar had been
 * lifted was still sent to the "This device is blocked" screen, and the
 * person was told the opposite of what the server would have said.
 *
 * A field that is absent counts as active, exactly as on the server: every bar
 * written before the field existed is a live one.
 */
object DeviceBan {
    fun applies(exists: Boolean, isActive: Boolean?): Boolean = exists && isActive != false

    /**
     * C6 (B31): `details.code` on `startMobileSession`'s refusal of a barred
     * handset, or of one that sent no device id. About the device, never the
     * connection — so never shown as "check your connection".
     */
    const val DEVICE_BARRED = "DEVICE_BARRED"

    /** Did the server refuse the session because of this device? */
    fun isDeviceBarred(detail: String?): Boolean = detail?.trim() == DEVICE_BARRED
}
