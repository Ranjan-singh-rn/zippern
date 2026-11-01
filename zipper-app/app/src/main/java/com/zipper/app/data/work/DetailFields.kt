package com.zipper.app.data.work

/*
 * Detail layouts shared by several modules. Kept in their own file on purpose:
 * Kotlin initialises a file's top-level values in order, so a module list that
 * referenced a value declared further down the same file would read null.
 */

internal val cardDetail = listOf(
    Field("Title", "title"), Field("Type", "type"), Field("Team", "team"),
    Field("Stage", "stage", FieldKind.Status), Field("Amount", "amount", FieldKind.Count), Field("Currency", "currency"),
    Field("Reason", "reason", FieldKind.LongText),
    Field("Subject", "subject", FieldKind.Json),
    Field("Raised by", "requested_by.name"), Field("Raised", "created_at", FieldKind.Date),
    Field("Verified by", "verified_by.name"), Field("Verified", "verified_at", FieldKind.Date),
    Field("Verification note", "verification_note", FieldKind.LongText),
    Field("Signed by", "signed_by.name"), Field("Signed", "signed_at", FieldKind.Date),
    Field("Executed", "executed_at", FieldKind.Date), Field("Result", "execution_result", FieldKind.Json),
    Field("Rejected", "rejected_at", FieldKind.Date), Field("Rejection reason", "rejection_reason", FieldKind.LongText),
    Field("Warning", "warning", FieldKind.LongText), Field("Details", "payload", FieldKind.Json),
)

internal val partnerDetail = listOf(
    Field("Name", "name"), Field("Partner ID", "id"), Field("Kind", "kind"),
    Field("Status", "status", FieldKind.Status), Field("Active", "is_active", FieldKind.Bool),
    Field("Main agency", "parent_name"), Field("Main agency ID", "parent_id"),
    Field("Created", "created_at", FieldKind.Date), Field("Approved", "approved_at", FieldKind.Date),
    Field("Rejection reason", "rejection_reason", FieldKind.LongText),
    Field("Revocation reason", "revocation_reason", FieldKind.LongText),
    Field("Credit standing", "credit_standing", FieldKind.Status),
    Field("Credit outstanding", "credit.outstanding", FieldKind.Count), Field("Credit due", "credit.due_at", FieldKind.Date),
    Field("Coins on hand", "coins_on_hand", FieldKind.Count), Field("Coins sold", "total_coins_sold", FieldKind.Count),
    Field("Commission outstanding", "commission_outstanding", FieldKind.Money),
    Field("Can buy inventory", "can_take_inventory", FieldKind.Json),
    Field("Activation", "activation", FieldKind.Json),
)

internal val auditDetail = listOf(
    Field("Action", "action"), Field("When", "at", FieldKind.Date),
    Field("By", "actor.name"), Field("Role", "actor.role"), Field("Team", "actor.team"),
    Field("Subject", "subject", FieldKind.Json), Field("Reason", "reason", FieldKind.LongText),
    Field("Before", "before", FieldKind.Json), Field("After", "after", FieldKind.Json),
    Field("Card", "card_id"), Field("Details", "meta", FieldKind.Json),
)
