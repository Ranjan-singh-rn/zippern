# B2 — Broken screens and navigation: report (2026-10-23)

Branch `v5-scratch`, HEAD `1194e55`. The tree already had uncommitted and untracked work, including the B1 changes. All of it was preserved: nothing was reset, stashed, reverted, committed or pushed. Before-copies of every file edited here are in the session scratch folder (`b2-before/`).

## Audit method
1. Matched every `Screen` route against its `composable` and its callers.
2. Checked every Composable callback parameter for one that is declared but never used, or never passed by its caller.
3. Traced each person list to its click handler.
4. Checked loading, empty and error paths in the ViewModels.
5. Compared the fields each screen reads with the backend, Functions and CRM code that writes them.

Areas checked and found fine:
- All route arguments are parsed correctly, and typed arguments are declared.
- The `savedStateHandle` handoffs are consistent.
- The other person lists (call history, likes, blocked users, resellers, chat, home feed, live and party viewer sheets) are wired to the profile.
- Incoming calls are routed by `MainActivity`. So `MainScreen.onNavigateToIncomingCall` being unused is not a defect.

## 1. Confirmed defects and root causes (all fixed)
| # | Defect | Root cause |
|---|---|---|
| 1 | **Agency dashboard: tapping a host does nothing** | **Missing click handler and missing wiring.** The screen and the route both existed: `user_profile/{uid}`, `OtherUserProfileScreen`, which reads `publicProfiles` only. The host row had no `clickable`, and the dashboard had no callback for the nav graph to supply. No backend change was needed, and no private host data is reachable through it. |
| 2 | **Messages → Feedback tab is always "No feedback sent"** | It read `supportTickets`. The app writes `feedbackTickets` (FeedbackScreen), and the CRM's support page answers there (in `response`). It also ordered by `updatedAt`, which that collection never carries. |
| 3 | **The host's phone ignores a staff End or Mute** | `backend/app/services/live.py` writes `isActive:false` / `endedByStaff` / `endReason` and `hostMuted` / `hostMuteReason` to the room the host already listens to. `LiveRoom` didn't parse those fields, and `GoLiveViewModel` never reacted. The host kept publishing on Agora. Its later End also overwrote the staff `endedAt`. |
| 4 | **The no-face auto-end drops the host onto the pre-live setup form**, with no explanation and no summary | `startFaceCountdown()` calls `endLive()`, but nothing on the screen observes it. `!isLive` simply renders the setup form. |
| 5 | **Gift details shows "No gifts yet" while it is still loading** | The ViewModel has `isLoading`, but the nav graph never passed it, and the screen had no loading branch. |
| 6 | **Call history shows "No calls yet" when the read failed** | `getCallHistory` catches every exception and returns `emptyList()`. `CallHistoryUiState.error` was never set. |
| 7 | **Recharge form garbles a seller name that contains `%`, and shows "Paid -?" for a blank name** | The name was `Uri.decode`d a second time; Navigation had already decoded it. The `-` placeholder was also treated as a name. |

## 2. Files changed
- **`ui/screens/agency/AgencyDashboardScreen.kt`:** new `onOpenHost` callback. A host row is tappable, with a chevron, only when its uid fits the route.
- **`navigation/ZipperNavGraph.kt`:**
  - `onOpenHost` now opens `Screen.UserProfile` (the existing public profile route);
  - Gift details now receives `isLoading`.
- **`util/AgencyIdentity.kt`:** `canOpenProfile(uid)`.
- **`data/repository/ChatRepository.kt`:** the tickets feed reads `feedbackTickets`, with `userId` plus `createdAt desc` (an existing index) and a limit of 50.
- **`data/model/SupportTicket.kt`:** pure mapper `fromFeedbackTicket`. It reads `message` (falling back to `body`) and `response` (falling back to `adminReply`, then `statusMessage`). Updated time is `statusChangedAt`, otherwise `createdAt`.
- **`ui/screens/messages/MessagesScreen.kt`:** an "Assigned" status label (the CRM writes `assigned`).
- **`data/model/LiveRoom.kt`:** parses `endedByStaff`, `endReason`, `hostMuted`, `hostMuteReason`.
- **`ui/screens/live/GoLiveViewModel.kt`:**
  - **Staff End:** stops the broadcast with `endLive(roomAlreadyClosed = true)`, which skips the room write.
  - **Staff mute:** forces the mic off, and `toggleMic` refuses to unmute while the mute is in force.
  - **No-face auto-end:** now sets an explanation.
- **`ui/screens/live/GoLiveScreen.kt`:** a "Live ended" dialog with the reason. OK goes to the existing session summary.
- **`util/LiveModeration.kt` (new):** the pure rules and messages for the above.
- **`ui/screens/profile/GiftDetailsScreen.kt`:** loading state.
- **Call history:**
  - `data/repository/CallRepository.kt`: new `loadCallHistory()` returns a `Result`; `getCallHistory` is kept and delegates to it.
  - `ui/screens/call/CallHistoryViewModel.kt` and `CallHistoryScreen.kt`: show an error state with "Try again".
- **Recharge form:**
  - `util/RouteArgs.kt` (new): decodes the seller name once and treats `-` as blank.
  - `ui/screens/partner/RechargeRequestScreen.kt`: uses it.
- **Tests:** `app/src/test/java/com/zipper/app/util/BrokenScreensB2Test.kt` (new), with 11 tests.

No backend, rules, index, CRM, pricing, ledger or approval code was changed. The only new client write is none: the staff-End path makes one *fewer* write.

## 3. Tests executed
| Command | Result |
|---|---|
| Source-string assertions of `BrokenScreensB2Test` and `AgencyIdentityTest`, checked against the edited files with a Python harness | 0 mismatches |
| `./gradlew :app:testDebugUnitTest` | **Not run.** This sandbox has no Android SDK, and the network allowlist blocks Gradle and Kotlin downloads. |
| `./gradlew :app:assembleDebug` | **Not run** (same reason). |
| CRM / backend | Not affected by B2; not re-run. |

Run on the Mac:

```
cd zipper-app && ./gradlew :app:testDebugUnitTest :app:assembleDebug
```

## 4. Remaining defects and blocked validation
**Blocked runtime checks.** These need suitable test data. A build passing is not evidence of any of them.
- An agency with roster hosts: tap a host and confirm their profile opens.
- A user with an existing `feedbackTickets` doc, ideally one resolved in the CRM: confirm it appears in Messages → Feedback with the reply.
- A live host, with staff using End or Mute from the CRM: confirm the broadcast stops, the dialog shows, and the mic is held off. This needs a test host account and a staff login. The app talks to **production**, so do it only with test accounts.
- Call-history failure path: try it in airplane mode on a fresh install.

**Not fixed (product or media decision, or a later phase):**
- **Weekly payout card.** It queries `agencyOwnerUid`, which the generator never writes, so the card can never show a report and "Submit report" is unreachable. A fix needs a decision on the data model (parity R12 / row 11). Left untouched.
- **Viewer "Stream quality" picker.** It only stores the choice (`WatchLiveViewModel.setStreamQuality`). Applying it needs Agora dual-stream on the broadcaster, which is a media change. Options: hide it, or implement it.
- **`DiamondHistory` and `PrivacyPolicy` routes are unreachable.** `PrivacyPolicy` is superseded by `LegalDoc`. `DiamondHistory` needs a product decision on where it should be entered from.
- **Suspected, not changed:**
  - Home can briefly flash its empty state before the feed's first snapshot.
  - A failed live-rooms query shows as "no rooms".
  - Live comment pills don't open a profile.
- **Agency host detail beyond the public profile.** Earnings, level and verification are not on any data the app may read. This needs the B3 mobile API session.
- **Seller coin-purchase status list.** Missing feature, out of scope.

## 5. Confirmation
- Existing uncommitted and untracked work was preserved. The two `JoinAgencyScreen` deletions were already present before this work.
- Nothing was deployed, committed or pushed.
- No production data was read or written, and no financial operation or migration was run.
- Authentication, authorization and role checks are unchanged.
