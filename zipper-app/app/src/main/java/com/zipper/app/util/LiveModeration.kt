package com.zipper.app.util

/**
 * B2 — how the host's phone honours a staff End or Mute on its live room.
 *
 * Staff act through the API (backend/app/services/live.py), which writes the
 * room document the host is already listening to:
 *   End  → `isActive: false`, `endedByStaff: true`, `endReason`
 *   Mute → `hostMuted: true|false`, `hostMuteReason`
 *
 * Viewers already drop out on `isActive: false`; the host's app ignored both,
 * so a stream staff had ended kept publishing on the media channel and a
 * muted host stayed audible. These rules are the host side. Pure, so
 * `LiveModerationTest` runs them on the JVM.
 */
object LiveModeration {

    /** The room was closed by someone other than this host, while this host is live. */
    fun closedRemotely(isLive: Boolean, alreadyHandled: Boolean, roomIsActive: Boolean): Boolean =
        isLive && !alreadyHandled && !roomIsActive

    /** A staff mute is in force and the host's mic is still open: close it. */
    fun mustForceMicOff(hostMuted: Boolean, micOn: Boolean): Boolean = hostMuted && micOn

    /** The host may open their own mic only while no staff mute is in force. */
    fun mayUnmute(hostMuted: Boolean): Boolean = !hostMuted

    const val FACE_TIMEOUT_MESSAGE = "Your live ended because no face was seen on camera for 2 minutes."

    fun endedMessage(endedByStaff: Boolean, reason: String?): String {
        val why = reason?.trim().orEmpty()
        val head = if (endedByStaff) "Zipper ended this live." else "This live room was closed."
        return if (why.isNotEmpty()) "$head Reason: $why" else head
    }

    fun mutedMessage(reason: String?): String {
        val why = reason?.trim().orEmpty()
        val head = "Zipper muted your microphone. You can't unmute until it is lifted."
        return if (why.isNotEmpty()) "$head Reason: $why" else head
    }
}
