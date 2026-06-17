import * as functions from "firebase-functions";
import * as admin from "firebase-admin";

admin.initializeApp();
const db = admin.firestore();

// ─────────────────────────────────────────────────────────────────────────────
// AGORA TOKEN GENERATION
// Requires: npm install agora-access-token
// Set env: firebase functions:config:set agora.app_certificate="YOUR_CERT"
// App ID (public): 11b6145b01124ba6937a326f30c6850a
// ─────────────────────────────────────────────────────────────────────────────

export const generateAgoraToken = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError("unauthenticated", "Login required");
  }

  const { channelName, uid, role } = data;
  if (!channelName || typeof channelName !== "string") {
    throw new functions.https.HttpsError("invalid-argument", "channelName required");
  }

  const appId = "11b6145b01124ba6937a326f30c6850a";
  const appCertificate: string = functions.config().agora?.app_certificate ?? "";

  if (!appCertificate) {
    // Certificate not set — return a dev token warning
    throw new functions.https.HttpsError(
      "failed-precondition",
      "Agora App Certificate not configured. Run: firebase functions:config:set agora.app_certificate=YOUR_CERT"
    );
  }

  // Dynamic import so the build doesn't fail if the package isn't installed yet
  let RtcTokenBuilder: any;
  let RtcRole: any;
  try {
    const agoraToken = await import("agora-access-token");
    RtcTokenBuilder = agoraToken.RtcTokenBuilder;
    RtcRole = agoraToken.RtcRole;
  } catch {
    throw new functions.https.HttpsError(
      "internal",
      "agora-access-token package not installed. Run: npm install agora-access-token inside functions/"
    );
  }

  const agoraRole = role === "publisher" ? RtcRole.PUBLISHER : RtcRole.SUBSCRIBER;
  const expireTime = 3600; // 1 hour
  const currentTime = Math.floor(Date.now() / 1000);
  const privilegeExpireTime = currentTime + expireTime;

  const token: string = RtcTokenBuilder.buildTokenWithUid(
    appId,
    appCertificate,
    channelName,
    uid ?? 0,
    agoraRole,
    privilegeExpireTime,
  );

  // Log token generation for audit
  await db.collection("agora_tokens").add({
    uid: context.auth.uid,
    channelName,
    role,
    generatedAt: admin.firestore.FieldValue.serverTimestamp(),
    expiresAt: admin.firestore.Timestamp.fromMillis((currentTime + expireTime) * 1000),
  });

  return { token, appId, channelName, uid: uid ?? 0, expireTime };
});

// ─────────────────────────────────────────────────────────────────────────────
// ECONOMY CONSTANTS (server-side — these are the SOURCE OF TRUTH)
// The Android client reads display values; actual billing runs here only.
// ─────────────────────────────────────────────────────────────────────────────

/** 1 diamond → this many "gross beans" internally. Company profit lever. */
const INTERNAL_DIAMOND_TO_GROSS_BEAN_MULTIPLIER = 2.5;

/** Regular gift: host receives this % of gross beans. */
const REGULAR_GIFT_RECIPIENT_PERCENT = 50;

/** Lucky gift: host receives this % of gross beans. */
const LUCKY_GIFT_RECIPIENT_PERCENT = 5;

/** Rs per diamond (public rate: 2290 per lakh). */
const RS_PER_DIAMOND = 2290 / 100_000;

/** Rs per bean paid to host (public rate: 1000 per lakh). */
const RS_PER_BEAN = 1000 / 100_000;

/** Minimum beans needed before host can request payout. */
const PAYOUT_MINIMUM_BEANS = 100_000;

/** Agency commission Rs per lakh beans. */
const AGENCY_COMMISSION_RS_PER_LAKH = 25;

// ─────────────────────────────────────────────────────────────────────────────
// GIFT PROCESSING
// ─────────────────────────────────────────────────────────────────────────────

/**
 * processGift — triggered when a gift_send document is created.
 * Atomically:
 *   1. Deduct diamonds from sender
 *   2. Credit beans to recipient (per internal multiplier + gift split)
 *   3. Credit weeklyBeansEarned for payout tracking
 *   4. Mark gift_send document as COMPLETED
 */
export const processGift = functions.firestore
  .document("gift_sends/{giftSendId}")
  .onCreate(async (snap, context) => {
    const data = snap.data();
    if (data.status !== "PENDING") return;

    const { senderId, recipientId, diamondCost, quantity, isLucky } = data;
    const totalDiamonds: number = diamondCost * quantity;

    // Internal: diamonds → gross beans
    const grossBeans = Math.floor(totalDiamonds * INTERNAL_DIAMOND_TO_GROSS_BEAN_MULTIPLIER);
    const recipientPercent = isLucky ? LUCKY_GIFT_RECIPIENT_PERCENT : REGULAR_GIFT_RECIPIENT_PERCENT;
    const beansToRecipient = Math.floor((grossBeans * recipientPercent) / 100);

    const senderBalRef = db.collection("balances").doc(senderId);
    const recipientBalRef = db.collection("balances").doc(recipientId);
    const recipientUserRef = db.collection("users").doc(recipientId);
    const giftSendRef = snap.ref;

    try {
      await db.runTransaction(async (tx) => {
        const senderBal = await tx.get(senderBalRef);
        const currentDiamonds: number = senderBal.data()?.diamonds ?? 0;

        if (currentDiamonds < totalDiamonds) {
          throw new Error("Insufficient diamonds");
        }

        // Deduct diamonds from sender
        tx.update(senderBalRef, {
          diamonds: admin.firestore.FieldValue.increment(-totalDiamonds),
          totalDiamondsSpent: admin.firestore.FieldValue.increment(totalDiamonds),
        });

        // Credit beans to recipient
        tx.update(recipientBalRef, {
          beans: admin.firestore.FieldValue.increment(beansToRecipient),
        });

        // Track weekly and total beans earned (for level + payout)
        tx.update(recipientUserRef, {
          totalBeansEarned: admin.firestore.FieldValue.increment(beansToRecipient),
          weeklyBeansEarned: admin.firestore.FieldValue.increment(beansToRecipient),
        });

        // Mark gift as processed
        tx.update(giftSendRef, {
          status: "COMPLETED",
          beansAwarded: beansToRecipient,
          processedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      });
    } catch (err: any) {
      await giftSendRef.update({
        status: "FAILED",
        failureReason: err.message ?? "Transaction failed",
      });
    }
  });

// ─────────────────────────────────────────────────────────────────────────────
// CALL BILLING
// ─────────────────────────────────────────────────────────────────────────────

/**
 * billCall — called when a call document is updated with status=ENDED.
 * Charges caller diamonds, credits callee beans.
 * Uses gender-based ratio for caller charge; callee always gets their set rate.
 */
export const billCall = functions.firestore
  .document("calls/{callId}")
  .onUpdate(async (change, context) => {
    const before = change.before.data();
    const after = change.after.data();

    if (before.status === after.status) return;
    if (after.status !== "ENDED") return;
    if (after.billed) return; // idempotency guard

    const { callerId, calleeId, durationSeconds, calleeBeansPerMin,
            callerGender, calleeGender, isVideoCall } = after;

    const durationMinutes = durationSeconds / 60.0;
    const beansPerMin: number = calleeBeansPerMin ?? (isVideoCall ? 500 : 200);

    // Gender ratio
    let ratio = 0.40;
    if (callerGender === "MALE" && calleeGender === "FEMALE") ratio = 0.50;
    else if (callerGender === "FEMALE" && calleeGender === "MALE") ratio = 0.30;

    const diamondRate = Math.ceil(beansPerMin / ratio);
    const totalDiamonds = Math.ceil(diamondRate * durationMinutes);
    const beansToCallee = Math.ceil(beansPerMin * durationMinutes);

    const callerBalRef = db.collection("balances").doc(callerId);
    const calleeBalRef = db.collection("balances").doc(calleeId);
    const calleeUserRef = db.collection("users").doc(calleeId);

    await db.runTransaction(async (tx) => {
      const callerBal = await tx.get(callerBalRef);
      const currentDiamonds: number = callerBal.data()?.diamonds ?? 0;

      const actualDiamonds = Math.min(totalDiamonds, currentDiamonds);
      const actualBeans = Math.ceil(actualDiamonds * ratio);

      tx.update(callerBalRef, {
        diamonds: admin.firestore.FieldValue.increment(-actualDiamonds),
        totalDiamondsSpent: admin.firestore.FieldValue.increment(actualDiamonds),
      });

      tx.update(calleeBalRef, {
        beans: admin.firestore.FieldValue.increment(actualBeans),
      });

      tx.update(calleeUserRef, {
        totalBeansEarned: admin.firestore.FieldValue.increment(actualBeans),
        weeklyBeansEarned: admin.firestore.FieldValue.increment(actualBeans),
      });

      tx.update(change.after.ref, {
        billed: true,
        diamondsCharged: actualDiamonds,
        beansAwarded: actualBeans,
        billedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    });
  });

// ─────────────────────────────────────────────────────────────────────────────
// WEEKLY PAYOUT RESET
// ─────────────────────────────────────────────────────────────────────────────

/**
 * weeklyPayoutReset — runs every Sunday at 11:59 PM IST (18:29 UTC).
 *
 * For every HOST with weeklyBeansEarned > 0:
 *   1. Record payout in `payouts` collection
 *   2. Reset weeklyBeansEarned = 0
 *   3. Reset host level to 0 (level is recalculated from cumulative beans,
 *      but the WEEKLY display level resets — stored as weeklyLevel)
 *
 * NOTE: totalBeansEarned is NOT reset — that's the cumulative career total.
 *       Only the weekly counter resets.
 *       Host level displayed in-app = hostLevelFromBeans(weeklyBeansEarned)
 *       which will show 0 after reset until they earn more that week.
 */
export const weeklyPayoutReset = functions.pubsub
  .schedule("59 18 * * 0")   // Sunday 18:29 UTC = 11:59 PM IST
  .timeZone("UTC")
  .onRun(async () => {
    const weekEndMs = Date.now();
    const weekStartMs = weekEndMs - (7 * 24 * 3600 * 1000);

    const hostsSnapshot = await db.collection("users")
      .where("role", "==", "HOST")
      .where("weeklyBeansEarned", ">", 0)
      .get();

    if (hostsSnapshot.empty) {
      console.log("weeklyPayoutReset: no hosts with earnings this week.");
      return;
    }

    const BATCH_SIZE = 400; // Firestore batch limit is 500
    let batch = db.batch();
    let opCount = 0;

    const payoutDocs: admin.firestore.DocumentReference[] = [];

    for (const hostDoc of hostsSnapshot.docs) {
      const uid = hostDoc.id;
      const data = hostDoc.data();
      const weeklyBeans: number = data.weeklyBeansEarned ?? 0;
      const agencyId: string | null = data.agencyId ?? null;

      // Rs payout to host
      const hostPayoutRs = (weeklyBeans / 100_000) * 1000;
      // Agency commission
      const agencyPayoutRs = agencyId ? (weeklyBeans / 100_000) * AGENCY_COMMISSION_RS_PER_LAKH : 0;

      // 1. Write payout record
      const payoutRef = db.collection("payouts").doc();
      batch.set(payoutRef, {
        uid,
        agencyId,
        weeklyBeansEarned: weeklyBeans,
        hostPayoutRs,
        agencyPayoutRs,
        weekStartMs,
        weekEndMs,
        status: "PENDING_TRANSFER",
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      opCount++;

      // 2. Reset weeklyBeansEarned + clear weeklyLevel
      batch.update(hostDoc.ref, {
        weeklyBeansEarned: 0,
        weeklyLevelAtReset: data.currentLevel ?? 0,
        lastPayoutAt: admin.firestore.FieldValue.serverTimestamp(),
        lastPayoutBeans: weeklyBeans,
      });
      opCount++;

      // Commit batch before hitting limit
      if (opCount >= BATCH_SIZE) {
        await batch.commit();
        batch = db.batch();
        opCount = 0;
      }
    }

    if (opCount > 0) {
      await batch.commit();
    }

    console.log(`weeklyPayoutReset: processed ${hostsSnapshot.size} hosts.`);
  });

// ─────────────────────────────────────────────────────────────────────────────
// AGORA TOKEN GENERATOR
// ─────────────────────────────────────────────────────────────────────────────

/**
 * generateAgoraToken — HTTPS callable function.
 * Returns a short-lived RTC token for the requesting user.
 *
 * Client calls: functions.httpsCallable("generateAgoraToken")({ channelName, uid, role })
 *
 * NOTE: Install @agora-io/token-builder for production.
 * For now returns a placeholder — swap in real Agora token generation.
 */
export const generateAgoraToken = functions.https.onCall(async (data, context) => {
  if (!context.auth) throw new functions.https.HttpsError("unauthenticated", "Login required");

  const { channelName, uid, role } = data;
  if (!channelName || !uid) {
    throw new functions.https.HttpsError("invalid-argument", "channelName and uid required");
  }

  // TODO: Replace with real Agora token builder:
  // const { RtcTokenBuilder, RtcRole } = require("agora-access-token");
  // const token = RtcTokenBuilder.buildTokenWithUid(
  //   process.env.AGORA_APP_ID, process.env.AGORA_APP_CERTIFICATE,
  //   channelName, uid, role === "publisher" ? RtcRole.PUBLISHER : RtcRole.SUBSCRIBER,
  //   Math.floor(Date.now() / 1000) + 3600
  // );

  // PLACEHOLDER — remove in production and use real token above
  const token = `placeholder_token_${channelName}_${uid}_${Date.now()}`;

  return { token, channelName, uid };
});

// ─────────────────────────────────────────────────────────────────────────────
// APPLY PENALTY (called from CRM admin app)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * applyPenalty — HTTPS callable, admin-only.
 * Actions: "warning" | "deduct_beans" | "deduct_diamonds" | "suspend" | "device_ban_request"
 */
export const applyPenalty = functions.https.onCall(async (data, context) => {
  if (!context.auth) throw new functions.https.HttpsError("unauthenticated", "Login required");

  // Verify caller is a CRM admin
  const callerDoc = await db.collection("users").doc(context.auth.uid).get();
  const callerRole = callerDoc.data()?.crmRole;
  if (!["ADMIN", "SUPER_ADMIN"].includes(callerRole)) {
    throw new functions.https.HttpsError("permission-denied", "CRM access required");
  }

  const { reportId, targetUid, action, amount, durationHours, reason } = data;

  const userRef = db.collection("users").doc(targetUid);
  const balRef = db.collection("balances").doc(targetUid);
  const reportRef = db.collection("reports").doc(reportId);

  switch (action) {
    case "warning":
      await userRef.update({ lastWarningAt: admin.firestore.FieldValue.serverTimestamp(), lastWarningReason: reason });
      await reportRef.update({ status: "WARNING_ISSUED", reviewedBy: context.auth.uid, reviewedAt: admin.firestore.FieldValue.serverTimestamp() });
      break;

    case "deduct_beans":
      await db.runTransaction(async (tx) => {
        const balSnap = await tx.get(balRef);
        const currentBeans: number = balSnap.data()?.beans ?? 0;
        const deduction = Math.min(amount, currentBeans);
        tx.update(balRef, { beans: admin.firestore.FieldValue.increment(-deduction) });
        tx.update(reportRef, { status: "PENALTY_APPLIED", action: "deduct_beans", actionDetails: { amount: deduction }, reviewedBy: context.auth.uid, reviewedAt: admin.firestore.FieldValue.serverTimestamp() });
      });
      break;

    case "deduct_diamonds":
      await db.runTransaction(async (tx) => {
        const balSnap = await tx.get(balRef);
        const currentDiamonds: number = balSnap.data()?.diamonds ?? 0;
        const deduction = Math.min(amount, currentDiamonds);
        tx.update(balRef, { diamonds: admin.firestore.FieldValue.increment(-deduction) });
        tx.update(reportRef, { status: "PENALTY_APPLIED", action: "deduct_diamonds", actionDetails: { amount: deduction }, reviewedBy: context.auth.uid, reviewedAt: admin.firestore.FieldValue.serverTimestamp() });
      });
      break;

    case "suspend":
      const suspendUntilMs = Date.now() + (durationHours * 3_600_000);
      await userRef.update({ suspendedUntilMs: suspendUntilMs, suspensionReason: reason, lastSuspendedBy: context.auth.uid, lastSuspendedAt: admin.firestore.FieldValue.serverTimestamp() });
      await reportRef.update({ status: "SUSPENDED", action: "suspend", actionDetails: { durationHours, suspendedUntilMs }, reviewedBy: context.auth.uid, reviewedAt: admin.firestore.FieldValue.serverTimestamp() });
      break;

    case "device_ban_request":
      const { deviceFingerprint, deviceModel } = data;
      await db.collection("device_ban_requests").add({
        deviceFingerprint, deviceModel,
        uid: targetUid,
        reason,
        requestedBy: context.auth.uid,
        reportId,
        requestedAt: admin.firestore.FieldValue.serverTimestamp(),
        isActive: false,
        status: "PENDING_APPROVAL",
      });
      await reportRef.update({ status: "DEVICE_BAN_REQUESTED", reviewedBy: context.auth.uid, reviewedAt: admin.firestore.FieldValue.serverTimestamp() });
      break;

    default:
      throw new functions.https.HttpsError("invalid-argument", `Unknown action: ${action}`);
  }

  return { success: true, action, targetUid };
});

// ─────────────────────────────────────────────────────────────────────────────
// APPROVE DEVICE BAN (super admin only)
// ─────────────────────────────────────────────────────────────────────────────

export const approveDeviceBan = functions.https.onCall(async (data, context) => {
  if (!context.auth) throw new functions.https.HttpsError("unauthenticated", "Login required");

  const callerDoc = await db.collection("users").doc(context.auth.uid).get();
  if (callerDoc.data()?.crmRole !== "SUPER_ADMIN") {
    throw new functions.https.HttpsError("permission-denied", "Super admin access required");
  }

  const { requestId, deviceFingerprint, reason } = data;

  const batch = db.batch();

  // Activate the ban in device_bans (checked at every app startup)
  batch.set(db.collection("device_bans").doc(deviceFingerprint), {
    isActive: true,
    reason,
    bannedAt: admin.firestore.FieldValue.serverTimestamp(),
    bannedBy: context.auth.uid,
    requestId,
  });

  // Mark request as approved
  batch.update(db.collection("device_ban_requests").doc(requestId), {
    status: "APPROVED",
    isActive: true,
    approvedBy: context.auth.uid,
    approvedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  await batch.commit();
  return { success: true, deviceFingerprint };
});
