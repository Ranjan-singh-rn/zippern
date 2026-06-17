# Zipper App — Master Product Plan & Feature Tracker
> Live social + dating app | Chamet/HiClub/Tango competitor | Firebase + Agora + Kotlin/Compose
> Last updated: June 2026

---

## STATUS KEY
- ✅ DONE — Implemented and wired in codebase
- ⚠️ PARTIAL — File exists but incomplete or not fully wired
- ❌ NOT DONE — Still needs implementation
- 🔧 DEPLOY ONLY — Code done, just needs deployment/config

---

## FEATURE CHECKLIST

### A. FOUNDATION & ARCHITECTURE

| # | Feature | Status | File / Notes |
|---|---------|--------|--------------|
| A1 | Data models (UserProfile, LiveStream, Gift, etc.) | ✅ | `data/Models.kt`, `data/UserProfile.kt` |
| A2 | Virtual economy math (formulas, rates, margins) | ✅ | `economy/VirtualEconomyMath.kt` |
| A3 | Economy: 2290 Rs/1L diamonds (public fixed rate) | ✅ | `VirtualEconomyMath.kt` |
| A4 | Economy: 1000 Rs/1L beans (host payout rate) | ✅ | `VirtualEconomyMath.kt` |
| A5 | Economy: 2.5× internal gross bean multiplier (secret company profit lever) | ✅ | `VirtualEconomyMath.kt` — server-side only |
| A6 | Economy: gift split — 50% regular / 5% lucky to host | ✅ | `VirtualEconomyMath.kt` |
| A7 | Economy: call billing — gender ratio (M→F 50%, same 40%, F→M 30%) | ✅ | `VirtualEconomyMath.kt` |
| A8 | Economy: host always gets beans (user or host calling them) | ✅ | `VirtualEconomyMath.kt` |
| A9 | AuthRepository — Phone OTP + Google Sign-In | ✅ | `auth/AuthRepository.kt` |
| A10 | Auth: HOST role requires agency referral code | ✅ | `auth/AuthRepository.kt` |
| A11 | Auth: city captured via Geocoder (locality, not area) | ✅ | `auth/AuthRepository.kt` |
| A12 | Firebase Firestore service (all CRUD ops) | ✅ | `service/FirebaseService.kt` |
| A13 | DatingViewModel — full central state (DatingUiState) | ✅ | `ui/DatingViewModel.kt` (6424 lines) |
| A14 | DatingViewModel — all business logic functions | ✅ | `ui/DatingViewModel.kt` |
| A15 | SentGiftHistoryEntry data model | ✅ | `data/Models.kt` |

---

### B. AUTHENTICATION & ONBOARDING

| # | Feature | Status | File / Notes |
|---|---------|--------|--------------|
| B1 | LoginScreen — phone OTP flow | ✅ | `ui/screens/LoginScreen.kt` |
| B2 | LoginScreen — Google Sign-In | ✅ | `ui/screens/LoginScreen.kt` |
| B3 | LoginScreen — Guest mode | ✅ | `ui/screens/LoginScreen.kt` |
| B4 | Registration — name, DOB, gender selection | ✅ | `ui/screens/LoginScreen.kt` (inline) |
| B5 | Registration — gender LOCKED after save (immutable) | ✅ | `ui/screens/EditProfileScreen.kt` |
| B6 | Registration — referral code → HOST role | ✅ | `auth/AuthRepository.kt` |
| B7 | FaceVerificationScreen — ML Kit face detection | ✅ | `ui/screens/FaceVerificationScreen.kt` |
| B8 | Face verification — TFLite gender classifier (must match registered gender) | ✅ | `ui/screens/FaceVerificationScreen.kt` |
| B9 | Face deduplication — prevent same person creating 2 host accounts | ✅ | `ui/screens/FaceVerificationScreen.kt` → `HostFaceDeduplicate` |
| B10 | Splash screen — holds until auth bootstrap complete | ✅ | `MainActivity.kt` |
| B11 | Guest mode — limited features, no hosting | ✅ | `DatingViewModel` + UI guards |

---

### C. SECURITY

| # | Feature | Status | File / Notes |
|---|---------|--------|--------------|
| C1 | FLAG_SECURE — no screenshots, no screen recording | ✅ | `MainActivity.kt` line 226 |
| C2 | Device fingerprinting — SHA-256(Android ID + model + manufacturer) | ✅ | `security/DeviceTracker.kt` |
| C3 | Device ban — check at app startup, show ban screen | ✅ | `MainActivity.kt` + `security/DeviceTracker.kt` |
| C4 | Device ban — request stored in Firestore, approved by super admin | ✅ | `security/BanManager.kt` + Cloud Functions |
| C5 | Single-device login — new login auto-logs out old device | ✅ | `MainActivity.kt` + `security/DeviceTracker.kt` |
| C6 | Login suspension — check after login, auto-logout if suspended | ✅ | `MainActivity.kt` + `security/BanManager.kt` |
| C7 | Report system — users can report others | ✅ | `security/BanManager.kt` + `ui/screens/FeedbackScreen.kt` |
| C8 | Report workflow — PENDING → UNDER_REVIEW → WARNING/PENALTY/SUSPENDED/DISMISSED | ✅ | `security/BanManager.kt` |
| C9 | DeviceBanScreen — full-screen block with ban details | ✅ | `ui/screens/DeviceBanScreen.kt` |

---

### D. HOME SCREEN & DISCOVERY

| # | Feature | Status | File / Notes |
|---|---------|--------|--------------|
| D1 | HomeScreen — user discovery grid | ✅ | `ui/screens/HomeScreen.kt` |
| D2 | HomeScreen — online/live badges on cards | ✅ | `ui/screens/HomeScreen.kt` |
| D3 | HomeScreen — search by ID | ✅ | `ui/screens/HomeScreen.kt` |
| D4 | HomeScreen — filter by city, age, level | ✅ | `ui/screens/HomeScreen.kt` |
| D5 | HomeScreen — tap card → profile bottom sheet | ✅ | `ui/screens/HomeScreen.kt` |
| D6 | Profile card — photo, name, age, city, badges | ✅ | `ui/components/ProfileCard.kt` |
| D7 | Profile card — level ring around avatar | ✅ | `ui/components/ProfileCard.kt` |
| D8 | Profile card — verified badge (blue tick) | ✅ | `ui/components/VerifiedBadge.kt` |
| D9 | Live entry effect when joining live (based on user level) | ⚠️ | `DatingUiState` has field, animation needs Lottie assets |

---

### E. LIVE STREAMING

| # | Feature | Status | File / Notes |
|---|---------|--------|--------------|
| E1 | LiveScreen — two tabs (Live List + Party Rooms) | ✅ | `ui/screens/LiveScreen.kt` |
| E2 | LiveScreen — Go Live button for hosts | ✅ | `ui/screens/LiveScreen.kt` |
| E3 | LiveScreen — Go Party button | ✅ | `ui/screens/LiveScreen.kt` |
| E4 | LiveScreen — filter by city/language/hobby | ✅ | `ui/screens/LiveScreen.kt` |
| E5 | LiveBroadcastScreen — host controls (mute, end, PK, gifts) | ✅ | `ui/screens/LiveBroadcastScreen.kt` |
| E6 | LiveBroadcastScreen — real-time chat overlay | ✅ | `ui/screens/LiveBroadcastScreen.kt` |
| E7 | LiveBroadcastScreen — viewer list with kick power | ✅ | `ui/screens/LiveBroadcastScreen.kt` |
| E8 | LiveBroadcastScreen — Agora SDK integration | ✅ | `ui/screens/AgoraLiveScreen.kt` |
| E9 | LiveViewerScreen — watch host video + chat | ✅ | `ui/screens/LiveViewerScreen.kt` |
| E10 | LiveViewerScreen — gift sending from viewer | ✅ | `ui/screens/LiveViewerScreen.kt` |
| E11 | LiveViewerScreen — mute speaker button | ✅ | `ui/screens/LiveViewerScreen.kt` |
| E12 | PIP mode — live minimises to floating window | ✅ | `ui/components/GlobalLivePip.kt` |
| E13 | Live tab — active PK banners on stream cards | ✅ | `DatingUiState.activeLivePkBanners` |
| E14 | Auto-stop live if no camera for 2 min | ⚠️ | Compliance banner exists, timer logic needs verification |

---

### F. PARTY ROOM

| # | Feature | Status | File / Notes |
|---|---------|--------|--------------|
| F1 | Audio party room — Agora multi-seat voice | ✅ | `ui/screens/AgoraAudioPartyRtcLayer.kt` |
| F2 | Party room stage layout — visual seat arrangement | ✅ | `ui/screens/AudioPartyStageLayout.kt` (873 lines) |
| F3 | Party room — FREE mode (instant seat join) | ✅ | `ui/screens/AudioPartyStageLayout.kt` |
| F4 | Party room — CONSENT mode (request → owner approve) | ✅ | `ui/screens/AudioPartyStageLayout.kt` |
| F5 | Party room — 10/12/15 seat options | ✅ | `DatingUiState.audioPartySeatCount` |
| F6 | Party room — owner/admin: lock seat, kick, mute | ✅ | `ui/screens/AudioPartyStageLayout.kt` |
| F7 | Party room — admin grant system | ✅ | `ui/screens/AudioPartyStageLayout.kt` |
| F8 | Party room — gifts to owner or seated person | ✅ | Gift system wired to party |
| F9 | Party room — real-time chat | ✅ | `ui/screens/AudioPartyItzoExtras.kt` |

---

### G. PK BATTLE

| # | Feature | Status | File / Notes |
|---|---------|--------|--------------|
| G1 | PK matchmaking — search for available host | ✅ | `ui/screens/BattleLobbyScreen.kt` |
| G2 | PK match found — both accept popup | ✅ | `ui/screens/PkBattleScreen.kt` |
| G3 | PK — split screen (host left, opponent right) | ✅ | `ui/screens/AgoraPkBattleScreen.kt` |
| G4 | PK — support diamond bar (animated, fills showing winner) | ✅ | `ui/screens/PkBattleScreen.kt` |
| G5 | PK — 3-minute countdown timer | ✅ | `ui/screens/PkBattleScreen.kt` |
| G6 | PK — viewer gifts counted as support | ✅ | Cloud Function `processGift` |
| G7 | PK — winner declared on timer end | ✅ | `ui/screens/PkBattleScreen.kt` |
| G8 | PK ended interstitial → continue solo live or end | ✅ | `DatingUiState.showHostPkEndedInterstitial` |
| G9 | PK — CreateBattle screen | ✅ | `ui/screens/CreateBattleScreen.kt` |

---

### H. GIFTS

| # | Feature | Status | File / Notes |
|---|---------|--------|--------------|
| H1 | Gift catalog (Firestore + local cache) | ✅ | `data/GiftVisuals.kt`, `service/FirebaseService.fetchGiftCatalog` |
| H2 | Gift selection sheet (UI) | ✅ | `ui/components/GiftSelectionSheet.kt` |
| H3 | Gift overlay — plays on send | ✅ | `ui/components/GiftOverlay.kt` |
| H4 | Lucky gift — 5% to host, 95% to company | ✅ | `economy/VirtualEconomyMath.kt` |
| H5 | Regular gift — 50% to host, 50% to company | ✅ | `economy/VirtualEconomyMath.kt` |
| H6 | Lucky jackpot celebration dialog | ✅ | `ui/components/LuckyJackpotCelebrationDialog.kt` |
| H7 | Gift sound playback | ✅ | `ui/media/GiftSoundPlayback` |
| H8 | CRM gift media URLs | ✅ | `data/CrmGiftMediaUrls.kt` |
| H9 | Lottie gift animations | ⚠️ | Code ready to play `lottieUrl`; need actual Lottie asset URLs in Firestore |

---

### I. VIDEO & AUDIO CALLS

| # | Feature | Status | File / Notes |
|---|---------|--------|--------------|
| I1 | VideoCallScreen — Agora RTC video call | ✅ | `ui/screens/VideoCallScreen.kt` |
| I2 | Audio call — Agora RTC audio only | ✅ | `ui/screens/VideoCallScreen.kt` |
| I3 | Incoming call — FCM push + in-app overlay | ✅ | `service/CallFirebaseMessagingService.kt` |
| I4 | Call billing — per-minute diamond deduction | ✅ | Cloud Function `billCall` |
| I5 | Call billing — gender ratio (M→F 50%, same 40%, F→M 30%) | ✅ | `economy/VirtualEconomyMath.kt` |
| I6 | Host sets custom call rate per minute | ✅ | `ui/screens/EditProfileScreen.kt` (level 4+ unlock) |
| I7 | Call rate range locked by host level | ✅ | `economy/VirtualEconomyMath.kt` |
| I8 | Call history screen | ✅ | `ui/screens/CallHistoryScreen.kt` |
| I9 | Declined / missed call handling | ✅ | `DatingViewModel` + Cloud Function |

---

### J. GAMES

| # | Feature | Status | File / Notes |
|---|---------|--------|--------------|
| J1 | Games tab (Tab 3) — wired correctly | ✅ | `MainActivity.kt` tab 3 = GamesScreen |
| J2 | GamesScreen — 12 games catalog | ✅ | `ui/screens/GamesScreen.kt` |
| J3 | Games: Aviator, Fishing Star, Teen Patti, Slots | ✅ | `GamesScreen.kt` — GAME_CATALOG |
| J4 | Games: Lucky Wheel, Rocket Crash, Roulette, Blackjack | ✅ | `GamesScreen.kt` — GAME_CATALOG |
| J5 | Games: Dice, Baccarat, Plinko, Mines | ✅ | `GamesScreen.kt` — GAME_CATALOG |
| J6 | Games — HOT / NEW pill badges on cards | ✅ | `GamesScreen.kt` — GameCard |
| J7 | Games — full-screen WebView with back navigation | ✅ | `GamesScreen.kt` — GameWebViewScreen |
| J8 | Games — in-game leaderboard/ranking tab | ✅ | `GamesScreen.kt` — RankingTabContent |
| J9 | Games — actual WebView URLs (real game providers) | ❌ | Placeholder URLs — needs real game provider integration |

---

### K. ECONOMY OPERATIONS

| # | Feature | Status | File / Notes |
|---|---------|--------|--------------|
| K1 | Diamond shop — buy diamond packages | ✅ | `ui/screens/DiamondShopScreen.kt` |
| K2 | Diamond history screen | ✅ | `ui/screens/DiamondHistoryScreen.kt` |
| K3 | Beans center — host bean balance + withdrawal request | ✅ | `ui/screens/BeansCenterScreen.kt` |
| K4 | Earnings screen — host earnings breakdown | ✅ | `ui/screens/EarningsScreen.kt` |
| K5 | Weekly payout — Mon 12am → Sun 11:59pm IST cycle | ✅ | Cloud Function `weeklyPayoutReset` |
| K6 | Weekly payout — resets weeklyBeansEarned + records payout | ✅ | Cloud Function `weeklyPayoutReset` |
| K7 | Transaction history | ✅ | `service/FirebaseService.fetchTransactionHistory` |
| K8 | Cloud Function: processGift (atomic diamond deduct + bean credit) | ✅ | `functions/index.ts` |
| K9 | Cloud Function: billCall (per-minute billing on call end) | ✅ | `functions/index.ts` |
| K10 | Cloud Function: generateAgoraToken | ⚠️ | Placeholder — needs real Agora token builder |
| K11 | Agora token real implementation | ❌ | Install `agora-access-token` npm package + set AGORA_APP_ID + AGORA_APP_CERTIFICATE env vars |

---

### L. PROFILE & SOCIAL

| # | Feature | Status | File / Notes |
|---|---------|--------|--------------|
| L1 | ProfileScreen (settings tab — MY profile) | ✅ | `ui/screens/ProfileScreen.kt` |
| L2 | MyProfileScreen (full-screen own profile viewer) | ✅ | `ui/screens/MyProfileScreen.kt` |
| L3 | EditProfileScreen — edit name, bio, city, photos | ✅ | `ui/screens/EditProfileScreen.kt` |
| L4 | EditProfileScreen — gender LOCKED after first save | ✅ | `ui/screens/EditProfileScreen.kt` |
| L5 | View other user's profile (from HomeScreen) | ✅ | `ui/screens/ProfileScreen.kt` (viewer variant) |
| L6 | Follow / unfollow users | ✅ | `DatingViewModel.toggleFollow` |
| L7 | Like / unlike users | ✅ | `DatingViewModel.toggleLike` |
| L8 | LikesScreen — I Like tab + Like Me tab | ✅ | `ui/screens/LikesScreen.kt` |
| L9 | BlockedUsersScreen | ✅ | `ui/screens/BlockedUsersScreen.kt` |
| L10 | FollowedScreen | ✅ | `ui/screens/FollowedScreen.kt` |
| L11 | My sent gift history (My Profile → Gifts Sent) | ✅ | `DatingUiState.mySentGiftHistory` + `FirebaseService` |
| L12 | My received gift history (My Profile → Gifts Received) | ✅ | `DatingUiState.myReceivedGiftHistory` + `FirebaseService` |

---

### M. COSMETICS & MY BAG

| # | Feature | Status | File / Notes |
|---|---------|--------|--------------|
| M1 | My Bag screen — HiClub-style cosmetics bag | ✅ | `ui/screens/MyBagScreen.kt` |
| M2 | My Bag — Avatar Frame tab | ✅ | `MyBagScreen.kt` — SAMPLE_FRAMES |
| M3 | My Bag — Chat Style tab | ✅ | `MyBagScreen.kt` — SAMPLE_CHAT_STYLES |
| M4 | My Bag — Profile Card tab | ✅ | `MyBagScreen.kt` — SAMPLE_PROFILE_CARDS |
| M5 | My Bag — Entrance Bubble tab | ✅ | `MyBagScreen.kt` — SAMPLE_BUBBLES |
| M6 | My Bag — Big Entrance tab | ✅ | `MyBagScreen.kt` — SAMPLE_BIG_ENTRANCES |
| M7 | My Bag accessible from Profile tab menu | ✅ | `ProfileScreen.kt` → `onMyBagClick` |
| M8 | My Bag — Wear / Get / Wearing state buttons | ✅ | `MyBagScreen.kt` — CosmeticItemCard |
| M9 | Cosmetics actually applied to live/party (visual effect) | ❌ | UI exists, Firestore write on Wear exists; avatar frame etc. need rendering in live/party screens |

---

### N. MESSAGES

| # | Feature | Status | File / Notes |
|---|---------|--------|--------------|
| N1 | MessagesScreen — DM inbox | ✅ | `ui/screens/MessagesScreen.kt` (1059 lines) |
| N2 | MessagesScreen — CRM announcements tab | ✅ | `ui/screens/MessagesScreen.kt` |
| N3 | Real-time chat (Firebase Realtime Database) | ✅ | `service/FirebaseService.observeChatMessages` |
| N4 | Send text + image in DM | ✅ | `service/FirebaseService.sendChatMessage` |
| N5 | Unread message badge | ✅ | `DatingUiState.messages` |

---

### O. FEEDBACK & SUPPORT

| # | Feature | Status | File / Notes |
|---|---------|--------|--------------|
| O1 | FeedbackScreen — Submit Issue (payment / login types) | ✅ | `ui/screens/FeedbackScreen.kt` Tab 0 |
| O2 | FeedbackScreen — My Tickets tab (check ticket status + staff response) | ✅ | `ui/screens/FeedbackScreen.kt` Tab 1 |
| O3 | FeedbackScreen — My Reports tab (check report outcomes) | ✅ | `ui/screens/FeedbackScreen.kt` Tab 2 |
| O4 | FeedbackScreen accessible from Profile tab | ✅ | `ProfileScreen.kt` → `onFeedbackClick` |
| O5 | Staff can respond to tickets (staffNote field) | ✅ | Firestore `feedback` collection, `staffNote` field |

---

### P. ADMIN / CRM

| # | Feature | Status | File / Notes |
|---|---------|--------|--------------|
| P1 | Cloud Function: applyPenalty (warning / deduct / suspend / device ban request) | ✅ | `functions/index.ts` |
| P2 | Cloud Function: approveDeviceBan (super admin only) | ✅ | `functions/index.ts` |
| P3 | Device ban requests stored in Firestore (isActive=false until approved) | ✅ | `security/BanManager.kt` |
| P4 | Report manual review workflow (PENDING → UNDER_REVIEW → action) | ✅ | `security/BanManager.kt` |
| P5 | Decoy/dummy profiles (10 seeded profiles, isDecoy=true) | ✅ | `data/DecoyProfileSeeder.kt` |
| P6 | CRM web admin panel | ❌ | Not built — separate project, post-mobile |
| P7 | Push notification campaigns | ❌ | FCM service exists for call notifications; broadcast campaigns not built |

---

## WHAT NEEDS TO BE DONE BEFORE LAUNCH

### ❌ Must-Do (Blockers)

| # | Task | Detail |
|---|------|--------|
| 1 | **Agora token generation** | Replace placeholder in Cloud Functions with real `agora-access-token` npm package. Set `AGORA_APP_ID` and `AGORA_APP_CERTIFICATE` environment variables. Without this, all live/call/party features won't connect. |
| 2 | **Deploy Cloud Functions** | Run `npm install` in `/functions`, then `firebase deploy --only functions`. All economy (gifts, calls, payouts, bans) runs server-side. |
| 3 | **Real game URLs** | `GamesScreen.kt` has placeholder `webUrl` for each game. Need real WebView-compatible URLs from game providers (Aviator, Teen Patti, etc.) |
| 4 | **Lottie gift animation assets** | Gift catalog in Firestore needs real `lottieUrl` values for gift overlay animations. |
| 5 | **Cosmetics applied in live/party** | When a user wears an avatar frame/entrance effect from My Bag, it needs to render in LiveBroadcastScreen / PartyRoom. Currently only saved to Firestore, not visually applied. |

### ⚠️ Nice-To-Have (Pre-Launch Polish)

| # | Task | Detail |
|---|------|--------|
| 6 | Live entry animation | User's entry effect (from their level) should animate when they join a live stream. Lottie file needed. |
| 7 | Auto-stop live (no camera 2 min) | Compliance banner exists. Need to wire the 2-minute timer that ends the broadcast. |
| 8 | Level progression UI animations | Level-up celebration (Lottie) when host/user crosses a level threshold. |
| 9 | CRM web admin panel | Separate web project. Needs: user search, ticket resolution, report review, ban approval, penalty application, payout history. |
| 10 | Push notification campaigns | CRM-initiated broadcast notifications to segments of users. |
| 11 | Google Play / App Store release build | Sign with release keystore, set `minifyEnabled true`, test on real devices. |

---

## ECONOMY SUMMARY (For Reference)

```
Public-facing fixed rates (never shown as ratio):
  ₹2,290 per 1,00,000 diamonds  (what platform charges coin sellers)
  ₹1,000 per 1,00,000 beans     (what platform pays hosts)

Internal (CONFIDENTIAL — never shown to users):
  1 diamond spent → 2.5 gross beans generated internally
  Host gets X% of gross beans depending on gift type / call gender ratio
  Company profit = difference between diamond value and beans paid out

Gift math example (regular gift, 1000 diamonds):
  Gross beans = 1000 × 2.5 = 2500
  Host gets   = 2500 × 50% = 1250 beans = ₹12.50
  User paid   = 1000 diamonds = ₹22.90
  Company keeps = ₹22.90 − ₹12.50 = ₹10.40 (45.4% margin)

Weekly payout cycle:
  Monday 12:00 AM → Sunday 11:59 PM IST
  Cloud Function cron: "59 18 * * 0" (UTC = Sunday 11:59 PM IST)
  After payout: weeklyBeansEarned resets to 0
```

---

## FIRESTORE COLLECTIONS

| Collection | Purpose | Status |
|------------|---------|--------|
| `users/{uid}` | User profiles | ✅ |
| `live_streams/{id}` | Active/past live streams | ✅ |
| `party_rooms/{id}` | Audio party rooms | ✅ |
| `messages/{chatId}` | DM threads | ✅ |
| `messages/{chatId}/messages` | DM messages | ✅ |
| `calls/{id}` | Call sessions | ✅ |
| `gifts` | Gift catalog | ✅ |
| `gift_transactions/{id}` | Gift sends | ✅ |
| `transactions/{id}` | All economy transactions | ✅ |
| `battles/{id}` | PK battle sessions | ✅ |
| `agencies/{id}` | Host agencies | ✅ |
| `payouts/{id}` | Weekly host payouts | ✅ |
| `feedback/{id}` | User support tickets | ✅ |
| `reports/{id}` | User reports | ✅ |
| `user_sessions/{uid}` | Single-device session tracking | ✅ |
| `device_bans/{fingerprint}` | Banned device records | ✅ |
| `device_ban_requests/{id}` | Pending ban requests (super admin approves) | ✅ |
| `host_face_embeddings/{uid}` | Face vectors for deduplication | ✅ |
| `bean_withdrawal_requests/{id}` | Host payout withdrawal requests | ✅ |
| `crm_announcements/{id}` | CRM broadcast messages | ✅ |

---

*This document is the single source of truth for the Zipper app.*
*Updated June 2026 — reflects full implementation status.*
