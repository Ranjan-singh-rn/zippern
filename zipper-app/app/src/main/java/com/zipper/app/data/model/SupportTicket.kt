package com.zipper.app.data.model

data class SupportTicket(
    val id: String = "",
    val userId: String = "",
    val subject: String = "",
    val body: String = "",
    val status: String = "open",          // "open" | "assigned" | "in_progress" | "resolved" | "closed"
    val statusMessage: String = "",
    val createdAt: Long = 0L,
    val updatedAt: Long = 0L,
) {
    companion object {
        /**
         * B2 — one ticket as the app's Feedback screen WRITES it to
         * `feedbackTickets` and the CRM's support page answers it there.
         *
         * The Messages "Feedback" tab used to read `supportTickets`, which no
         * client of this app ever writes, so it said "No feedback sent" to
         * everyone who had sent feedback. The fields are the writer's:
         *   - `message` is the body (FeedbackScreen); `body` is read as a fallback;
         *   - `response` is support's answer (zipper-crm app/feedback `resolve`);
         *     `adminReply` / `statusMessage` are older names, read as fallbacks;
         *   - the CRM stamps `statusChangedAt` on every move, so that is "updated";
         *     a ticket nobody has touched shows its creation time.
         */
        fun fromFeedbackTicket(
            id: String,
            userId: String?,
            subject: String?,
            message: String?,
            body: String?,
            status: String?,
            response: String?,
            adminReply: String?,
            statusMessage: String?,
            createdAt: Long,
            statusChangedAt: Long,
        ): SupportTicket = SupportTicket(
            id = id,
            userId = userId.orEmpty(),
            subject = subject.orEmpty(),
            body = message?.takeIf { it.isNotBlank() } ?: body.orEmpty(),
            status = status?.trim()?.takeIf { it.isNotEmpty() } ?: "open",
            statusMessage = listOf(response, adminReply, statusMessage)
                .firstOrNull { !it.isNullOrBlank() }?.trim().orEmpty(),
            createdAt = createdAt,
            updatedAt = statusChangedAt.takeIf { it > 0 } ?: createdAt,
        )
    }
}
