# Zipper — Video Call UI & Billing Patch

## Repo & Branch

| Field        | Value                                   |
|--------------|-----------------------------------------|
| Remote       | https://github.com/Gotu12/zippern.git   |
| Branch       | `main`                                  |
| Patch file   | `zipper-video-call-ui-billing.patch`    |

---

## How to Apply

```bash
# 1. Clone the repo (skip if already cloned)
git clone https://github.com/Gotu12/zippern.git
cd zippern

# 2. Create a new feature branch (recommended)
git checkout -b feature/video-call-ui-billing-fix

# 3. Apply the patch
git apply zipper-v4-production-FINAL/dating-app-production/Datingapp/patches/zipper-video-call-ui-billing.patch

# 4. Check applied files
git diff --stat

# 5. Build and test on device
```

If `git apply` reports whitespace warnings, use:
```bash
git apply --whitespace=nowarn zipper-v4-production-FINAL/dating-app-production/Datingapp/patches/zipper-video-call-ui-billing.patch
```

---

## Files Changed

| File | What changed |
|------|-------------|
| `agora/AgoraManager.kt` | Removed debug toasts (`✅ Agora joined!`, `❌ Agora error`) that were popping during calls |
| `MainActivity.kt` | Cancel incoming-call notification (ID 2001) the moment user accepts call in-app |
| `LiveStreamActivity.kt` | • Cancel incoming-call notification on Activity open<br>• Billing delay `60_500ms → 59_000ms` (Chamet model: charge up-front, next attempt at 59 s)<br>• Wire `onLikePartner` + `partnerIsLiked` state to top bar<br>• `bottomSheetComposer = false` (replaced by inline composer) |
| `ui/webrtc/WebRtcVideoOverlays.kt` | **Top bar** — removed back (←) and chevron (v) buttons; avatar + name (capped 12 chars) + green timer + pink ❤ like + gold 💎 balance chip<br>**Bottom dock** — new Chamet-style itzoDock layout: scrollable message list → control row (mic/speaker/gift/flip/diamond/🔴 end-call) → inline WhatsApp-style composer; dark opaque message bubbles; compliance banner always pinned above messages |
| `service/FirebaseService.kt` | `chargeOneCallMinute()` — per-minute Firestore transaction; returns `-1` sentinel when balance is insufficient |
| `ui/DatingViewModel.kt` | `callActiveStartedAtMs` timestamp; `endCall()` computes elapsed from it |
| `ui/screens/VideoCallScreen.kt` | Chamet-style VideoCallScreen rich UI redesign |

---

## Key Behaviours After Patch

### Billing (Chamet model)
- Minute 1 is charged **immediately** when Agora `onJoinChannelSuccess` fires
- Every subsequent minute is charged at **t = 59 s** intervals
- If balance < rate → Firestore transaction returns `-1` → call ends with a toast
- Example: 2 000 💎 calling 1 500/min → call ends at ~59 s; 3 000 💎 → ~1 m 59 s

### Incoming call notification
- Notification (ID 2001, `.setOngoing(true)`) is **cancelled** the instant the call is accepted from either the notification action button or in-app — no lingering heads-up during the active call

### Debug toasts removed
- `AgoraManager` no longer shows `✅ Agora joined!` or `❌ Agora error:` toasts

### 1:1 Video call UI
- **Top bar**: avatar | name (≤ 12 chars) + green timer | ❤ like | 💎 balance
- **Message bubbles**: solid dark backgrounds (purple self / charcoal partner) — readable in bright & dark environments
- **Compliance banner**: always visible above the message list
- **Composer**: always-visible inline text field + pink send button — no bottom sheet
- **Controls**: mic · speaker · gift · flip-cam · diamond-shop · 🔴 end-call (64 dp)
