# ZIPPER — MASTER PRODUCT ROADMAP
> Complete reference: every feature, every technology, every phase — start to finish.
> Last updated: June 2026

---

## PART 1 — TECHNOLOGY STACK

Everything Zipper needs, what we use for each piece, and why.

---

### 1.1 — Core App Framework

| Layer | Technology | Version / Notes |
|---|---|---|
| Language | **Kotlin** | 100% Kotlin, no Java |
| UI Framework | **Jetpack Compose** + Material 3 | Declarative UI across all screens |
| Architecture | **MVVM** — ViewModel + StateFlow + UiState | Single source of truth per screen |
| Navigation | **Compose Navigation** (NavController) | Type-safe routes |
| Dependency Injection | **Hilt** | @HiltViewModel on every ViewModel |
| Async | **Kotlin Coroutines** + Flow | All network + IO on Dispatchers.IO |
| Image Loading | **Coil** | AsyncImage for remote photos |
| Build System | **Gradle (KTS)** | gradle.kts for all config |

---

### 1.2 — Backend & Database

| Service | Technology | What It Powers |
|---|---|---|
| Auth | **Firebase Authentication** | Phone OTP, Google Sign-In, Guest login |
| Database | **Firebase Firestore** | User profiles, rooms, messages, transactions |
| Storage | **Firebase Storage** | Profile photos, gift images, video thumbnails |
| Push Notifications | **Firebase Cloud Messaging (FCM)** | Calls, messages, live alerts, party alerts |
| Server Logic | **Firebase Cloud Functions** | Weekly agency payout, diamond billing, call auto-end |
| Crash Reporting | **Firebase Crashlytics** | Production crash tracking |
| Analytics | **Firebase Analytics** | User behaviour, funnel tracking |

---

### 1.3 — Real-Time Audio/Video

| Feature | Technology | How |
|---|---|---|
| **Live Streaming** (host video → viewers) | **Agora RTC SDK** | Host: `agoraEngine.startPreview()` + `joinChannel()`; Viewers join same channelId |
| **Party Room** (multi-mic audio) | **Agora RTC SDK** | Same SDK; host mutes/unmutes seat by UID; audience role for non-mic users |
| **1:1 Video/Audio Calls** | **Agora RTC SDK** | Unique channelId per call pair; timer ticks; Cloud Function ends call on low balance |
| **PK Battle** | **Agora RTC SDK** | Two hosts join same channel; score tracked in Firestore |
| **PiP Mode** (Picture-in-Picture) | Android `PictureInPicture` API + Agora | Service keeps Agora running; PiP window shows video surface |
| **Voice Pitch Effects** (chipmunk, deep) | **Agora SoundTouch extension** | `agoraEngine.setAudioEffectParameters()` — the .so is already in Agora SDK |
| **Video Clarity AI** | **Agora Clear Vision Extension** | Enable the `.so` from Agora package; one line to activate |
| **Agora Tokens** | Firebase Cloud Function generates tokens | Replace current `null` tokens for production security |

---

### 1.4 — Face Filters & Beauty

| Feature | Technology | How |
|---|---|---|
| AR face filters, beauty effects, skin smoothing | **Snap Camera Kit** | Already integrated; `LensRepository` loads effects; `CameraKitSession` applies them |
| Background blur | Android `RenderScript` toolkit or OpenCV | Simple Gaussian blur on camera frames |

---

### 1.5 — Payments

| Feature | Technology | How |
|---|---|---|
| UPI, cards, net banking, Paytm | **Razorpay Android SDK** | Replace current offline flow; `Checkout` class opens payment sheet |
| Subscription cards | Razorpay Subscriptions API | Monthly gem bundles (e.g. ₹499 = 5,000 gems/day for 30 days) |
| KYC for high-value top-ups | Razorpay KYC widget | Required by RBI above threshold |

**Diamond pricing logic:** ₹2,290 = 1,00,000 diamonds (base rate). All 6 tiers scale from this.

| Tier | Price | Diamonds | Bonus |
|---|---|---|---|
| 1 | ₹200 | 8,000 | — |
| 2 | ₹570 | 25,000 | 4% bonus |
| 3 | ₹1,140 | 50,000 | 4% bonus |
| 4 | ₹2,290 | 1,00,000 | 10% bonus |
| 5 | ₹4,580 | 2,10,000 | 15% bonus |
| 6 | ₹9,160 | 4,40,000 | 20% bonus |

---

### 1.6 — Animations

| Type | Technology | Usage |
|---|---|---|
| Gift animations, entrance effects, level-up celebrations | **Lottie** (`com.airbnb.android:lottie-compose`) | `.json` files in `assets/anim/`; `LottieAnimation()` composable |
| SVGA format files (from HiClub — 31 files) | **SVGA library** (`com.github.yyued:SVGAPlayer-Android`) | Some effects may come pre-designed in SVGA; player renders them |
| Simple UI transitions | Compose `AnimatedVisibility`, `animateFloatAsState` | Built-in, no extra library |
| Combo streak (x2, x3 rapid gifting) | Lottie — `anim_combo_particle.json` | Trigger when same gift sent 2+ times in 3 seconds |

---

### 1.7 — Local Storage & Caching

| Need | Technology | Notes |
|---|---|---|
| Fast key-value store (current: SharedPreferences) | **MMKV** (`com.tencent:mmkv`) | 10–100× faster than SharedPreferences; add in Phase 10 |
| Current sessions / logged-in state | SharedPreferences → migrate to MMKV | Small migration; backward compatible |

---

### 1.8 — Image Formats

| Format | Library | Why |
|---|---|---|
| GIF (gift animations) | `libanimation-decoder-gif` (already in Agora pkg) or **Coil GIF decoder** | Gift images in GIF format |
| AVIF (profile photos) | `com.linkedin.android.litr:litr` or Google AVIF support | Smaller file size, better quality |

---

### 1.9 — Number Formatting (Indian system)

All gem/bean counts use Indian number format throughout the app:

- < 1,000 → show as-is (e.g. 999)
- 1,000–99,999 → K format (e.g. 1.2K)
- 1,00,000–99,99,999 → L format (e.g. 1.5L)
- 1,00,00,000+ → Cr format (e.g. 1.2Cr)

Implement as a Kotlin extension function: `fun Long.toIndianShort(): String`

---

## PART 2 — FEATURE BREAKDOWN BY MODULE

Every feature, its status, and what to build.

---

### MODULE A — AUTHENTICATION

| # | Feature | Tech | Status | Notes |
|---|---|---|---|---|
| A1 | Phone OTP login | Firebase Auth | ✅ Done | |
| A2 | Google Sign-In | Firebase Auth + Google Identity | ✅ Done | |
| A3 | Guest login | Firebase Auth anonymous | ✅ Done | |
| A4 | Face verification | ML Kit (FaceDetector) | ✅ Done | |
| A5 | Auto-login on reopen | Firebase Auth `currentUser` persisted | ✅ Done | |
| A6 | Logout / account deletion | Firebase Auth `signOut()` + Firestore cleanup | ✅ Done | |

---

### MODULE B — USER PROFILES

| # | Feature | Tech | Status | Notes |
|---|---|---|---|---|
| B1 | My profile — photo, name, bio, city, hobbies | Firestore `users/{uid}` | ✅ Done | |
| B2 | Edit profile | Firestore update + Storage photo upload | ✅ Done | |
| B3 | Other user's profile screen | Firestore read | ✅ Done | |
| B4 | Follow / Unfollow | Firestore `follows` subcollection | ✅ Done | |
| B5 | Block / Report | Firestore `blocks` + `reports` | ✅ Done | |
| B6 | **Avatar frames** (animated border by wealth level) | Lottie animation on profile photo | ❌ Build | Unlocked at wealth Lv3/5/8/11/15 |
| B7 | **Entrance bubble** (small animation on room entry) | Lottie overlay triggered on join event | ❌ Build | Level 1 cosmetic tier |
| B8 | **Big entrance** (grand vehicle/effect for VIPs) | Full-screen Lottie — Lv3/4/5 entrance files | ❌ Build | Top spenders; huge retention |
| B9 | **Profile card** (custom card layout) | Firestore field `profileCardId` + render enum | ❌ Build | Custom card design per user |
| B10 | **Intimacy score** between two users | Firestore `intimacy/{uid1}_{uid2}` updated on calls/gifts | ❌ Build | Shown on each other's profile |
| B11 | **Wealth level system** (total gems spent → tier) | Firestore `users/{uid}.totalGemsSpent` + enum | ❌ Build | Lv1–15; unlocks frames/entrances |
| B12 | **Level upgrade celebration** animation | Lottie `anim_user_level_upgrade_1.json` fullscreen | ❌ Build | Trigger when `totalGemsSpent` crosses tier threshold |
| B13 | Gift received section on profile | Firestore `giftHistory` aggregated by giftId | ❌ Build | Shows top 6 gifts received publicly |

---

### MODULE C — HOME / DISCOVERY FEED

| # | Feature | Tech | Status | Notes |
|---|---|---|---|---|
| C1 | User grid (cards with photo, name, level badge) | Firestore `users` query + Compose LazyVerticalGrid | ✅ Done | |
| C2 | Online status dot | Firestore `users/{uid}.isOnline` realtime listener | ✅ Done | |
| C3 | LIVE badge on card | Firestore `users/{uid}.isLive` realtime | ✅ Done | |
| C4 | Search by name/city | Firestore `where` query on name prefix | ✅ Done | |
| C5 | Following tab | Firestore `follows` → filter profiles | ✅ Done | |
| C6 | Filter: city, hobbies, language | ViewModel `setDiscoveryFilters()` | ✅ Done | |
| C7 | **Filter: age range (18–60 slider)** | ViewModel `setDiscoveryFilters(ageMin, ageMax)` | ✅ Done | Fixed this session |
| C8 | **Filter: gender chips** (All/Male/Female) | ViewModel `setDiscoveryFilters(gender)` | ✅ Done | Fixed this session |
| C9 | **PARTY badge** on card (user is in a party room) | Firestore `users/{uid}.isInParty` field → show badge | ❌ Build | Low effort |
| C10 | **Global rankings button** (trophy icon in top nav) | Opens weekly leaderboard screen | ❌ Build | See Module K |

---

### MODULE D — LIVE STREAMING

#### D1 — Host / Broadcaster Side

| # | Feature | Tech | Status | Notes |
|---|---|---|---|---|
| D1.1 | Start live stream | Agora RTC `joinChannel()` + Firestore `isLive=true` | ✅ Done | |
| D1.2 | Camera toggle, mic toggle, flip camera | Agora `enableLocalVideo/Audio`, `switchCamera()` | ✅ Done | |
| D1.3 | End stream + cleanup | Agora `leaveChannel()` + Firestore `isLive=false` | ✅ Done | |
| D1.4 | PK Battle — invite opponent, score bars | Agora co-host + Firestore `pkSession` doc | ✅ Done | |
| D1.5 | Gift notifications in stream | Firestore listener on `giftEvents` sub-collection | ✅ Done | |
| D1.6 | **Snap Camera Kit beauty filters** | Snap `LensRepository` + `CameraKitSession` | ✅ Done | |
| D1.7 | **Agora Clear Vision** (AI video quality) | Enable `agora_clear_vision_extension.so` in Agora setup | ❌ Build | One-line activation |
| D1.8 | **Anchor tasks** — daily host challenges | Firestore `anchorTasks/{uid}/daily` + Cloud Function resets daily | ❌ Build | e.g. "Stream 2 hrs → +500 gems" |
| D1.9 | **Wish gift** — set gem goal, progress bar fills | Firestore `liveRooms/{roomId}.wishGiftTarget` + viewer contributions | ❌ Build | `anim_wish_gift_progress_bar.json` |
| D1.10 | **Free call mode** — toggle free calls window | Firestore `liveRooms/{roomId}.freeCallEnabled` flag | ❌ Build | Viewers can call free during this window |
| D1.11 | **Scrolling gift ticker** in host view | Firestore listener → `LazyColumn` with `AnimatedVisibility` | ❌ Build | "X won 65K 💎 by sending Rocket" |
| D1.12 | **PK countdown SVGA** — 4 stages | Lottie/SVGA: countdown → match → matching → start | ❌ Build | Replace current basic countdown |
| D1.13 | **Auto-welcome message** when stream starts | Cloud Function writes system chat message on `isLive` set to true | ❌ Build | LIVE-10 |

#### D2 — Viewer Side

| # | Feature | Tech | Status | Notes |
|---|---|---|---|---|
| D2.1 | Join live stream, watch video | Agora RTC `setClientRole(AUDIENCE)` + `joinChannel()` | ✅ Done | |
| D2.2 | Send chat messages | Firestore `liveRooms/{id}/messages` collection | ✅ Done | |
| D2.3 | Send gifts | Firestore write + Cloud Function validates balance | ✅ Done | |
| D2.4 | PiP mode | Android PiP API + Agora continues in Service | ✅ Done | |
| D2.5 | Viewer list | Firestore `liveRooms/{id}/viewers` sub-collection | ✅ Done | |
| D2.6 | **Gift animations** (Lottie overlays on gift receive) | Lottie `LottieAnimation` composable triggered by Firestore event | ❌ Build | Replace static icon |
| D2.7 | **Gift combo streak** (×2, ×3 rapid gifting) | Track gift timestamp in ViewModel; fire `anim_combo_particle.json` | ❌ Build | Same gift within 3s = combo |
| D2.8 | **Gifts sent counter in top bar** | Firestore listener on viewer's session total | ❌ Build | Running total in top of room |
| D2.9 | **Scrolling gift ticker** ("X won Y gems") | Same as host side | ❌ Build | |
| D2.10 | **TOP1/TOP2 gifter badge** in viewer list | Sort viewers by `gemsThisSession`; badge top 2 | ❌ Build | Drives gifting competition |
| D2.11 | **Viewer popup** — tap viewer → card with Message + Gift | BottomSheet with viewer profile + 2 action buttons | ❌ Build | |
| D2.12 | **Big entrance animation** on room entry | Lottie fullscreen triggered by join event; only for Lv3+ wealth users | ❌ Build | |
| D2.13 | **Stream ended animation** for viewers | Lottie `anim_watch_live_finished.json` shown when host ends | ❌ Build | |
| D2.14 | **First recharge celebration** | Lottie fullscreen `live_room_first_charge.json` on first payment success | ❌ Build | |
| D2.15 | **Incoming call overlay inside live room** | Overlay composable (zIndex > video) with accept/decline | ❌ Build | Same pattern as main app overlay |
| D2.16 | **1:1 video call from inside live** — host invites viewer | Agora separate channel + Firestore call invite | ❌ Build | |

---

### MODULE E — PARTY ROOM

#### E1 — Party Room List

| # | Feature | Tech | Status | Notes |
|---|---|---|---|---|
| E1.1 | Party room list with cards | Firestore `partyRooms` collection | ✅ Done | |
| E1.2 | Create party room | Firestore write + Agora channel create | ✅ Done | |
| E1.3 | Room thumbnail, name, host level, viewer count | Firestore fields | ✅ Done | |

#### E2 — Inside Party Room

| # | Feature | Tech | Status | Notes |
|---|---|---|---|---|
| E2.1 | Multi-mic audio seats | Agora RTC broadcaster/audience roles per seat | ✅ Done | |
| E2.2 | Host controls (mute/unmute seats, lock seat) | Firestore `partyRooms/{id}/seats` + Agora mute by UID | ✅ Done | |
| E2.3 | Chat messages in room | Firestore `partyRooms/{id}/messages` | ✅ Done | |
| E2.4 | Send gifts in party | Same gift flow as live stream | ✅ Done | |
| E2.5 | Welcome message on entry | Firestore write on join | ✅ Done | |
| E2.6 | **"[User] joined the room"** system chat message | Firestore trigger write on viewer join event | ⚠️ Fix | PARTY-07 |
| E2.7 | **Guest enters as listener** (not auto-seated on mic) | Default Agora role = AUDIENCE; only seated users = BROADCASTER | ❌ Fix | Bug |
| E2.8 | **Animated party room background** | Lottie looping background per room theme; unlocked by host level | ❌ Build | Castle, nature, luxury scenes |
| E2.9 | **Room mic mode label** in chat | System message: "Room mic mode: Free / Consent" on join | ❌ Build | Simple Firestore field + display |
| E2.10 | **Gifts sent counter in top bar** | Same as live stream | ❌ Build | |
| E2.11 | **Scrolling gift ticker** | Same Firestore listener pattern | ❌ Build | |
| E2.12 | **Big entrance animation** for Lv3+ users | Lottie fullscreen on entry | ❌ Build | |
| E2.13 | **Games button inside party room** — wire it | Navigate to Games tab or launch WebView from inside room | ❌ Fix | Button exists, broken wire |
| E2.14 | **Viewer list** — 3 tabs: Recent Chats / Follower / Member | Firestore query filters + TabRow composable | ❌ Build | |
| E2.15 | **Share button per viewer** in viewer list | Android ShareSheet with deep link to room | ❌ Build | |
| E2.16 | **Follower tasks** in party room | Tasks like "Follow 5 people → earn 100 gems"; Firestore task tracker | ❌ Build | |
| E2.17 | **PARTY badge on home feed** (user is in party) | Firestore `users/{uid}.isInParty` set on join/leave | ❌ Build | Low effort |

---

### MODULE F — GAMES CENTER

| # | Feature | Tech | Status | Notes |
|---|---|---|---|---|
| F1 | Games list screen (4-column grid, HOT/NEW badges) | Hardcoded list + `WebView` for each game | ✅ Done | |
| F2 | WebView game launcher | Android `WebView` + `AndroidJsBridge` for JS↔Native calls | ✅ Done | |
| F3 | **Fill game URLs** — all `webUrl=""` are empty | Add actual game URLs from your game provider | ❌ Fill | The architecture is ready |
| F4 | Rankings tab | Firestore `gameRankings` | ✅ Done | |
| F5 | Game history / transactions | Firestore `gameTransactions` | ✅ Done | |
| F6 | **Games from inside live/party room** | Pass room context to game; fix the broken navigation wire | ❌ Fix | Wire exists, broken |
| F7 | **Daily Claim button** — free gems from tasks | Firestore `dailyClaim/{uid}` with 24h cooldown; Cloud Function validates | ❌ Build | |
| F8 | **Game rank settlement animation** | Lottie `anim_game_rank_settle.json` shown when session ends | ❌ Build | |
| F9 | Game Store tab (buy power-ups) | In-app purchase flow via Razorpay or Play Billing | ❌ Build | |

---

### MODULE G — GIFT SYSTEM

| # | Feature | Tech | Status | Notes |
|---|---|---|---|---|
| G1 | Gift catalog (grid, gem prices) | Firestore `gifts` collection | ✅ Done | |
| G2 | Send gift (deduct gems, notify host) | Firestore transaction + Cloud Function validates | ✅ Done | |
| G3 | Lucky gift mechanic (0×/1×/2×/5× return) | Cloud Function random draw + Firestore update | ✅ Done | |
| G4 | Super Lucky gift | Cloud Function extended draw | ✅ Done | |
| G5 | Gift sent history | Firestore `giftHistory/{uid}` | ✅ Done | |
| G6 | **SVGA/Lottie gift animations** — full animated overlays | Add `com.airbnb.android:lottie-compose`; `.json` per gift | ❌ Build | Replaces static icon; biggest visual upgrade |
| G7 | **Gift combo streak** (×2, ×3 rapid gifting display) | ViewModel tracks last gift timestamp; same gift within 3s = combo; Lottie fires | ❌ Build | `anim_combo_particle.json` |
| G8 | **Wish gift** — host sets gem goal, viewers fill progress bar | Firestore `wishGift.target` + `wishGift.current`; progress bar composable | ❌ Build | `anim_wish_gift_progress_bar.json` |
| G9 | **Gift ticker** in live/party ("X won Y gems") | Firestore `giftEvents` listener → scrolling `Row` in room UI | ❌ Build | |
| G10 | **Gift received section** on other user's profile | Firestore `giftHistory` aggregated by gift type; show top 6 | ❌ Build | |
| G11 | Gift sent history — rich grid (gem value × quantity) | Enhance existing history screen | ❌ Build | |

---

### MODULE H — COSMETICS / MY BAG

| # | Feature | Tech | Status | Notes |
|---|---|---|---|---|
| H1 | My Bag screen | Firestore `inventory/{uid}` | ✅ Done | |
| H2 | Equipped item shown with "Wearing" tag | Firestore `users/{uid}.equippedFrame` etc. | ✅ Done | |
| H3 | **Avatar frames** — animated borders per wealth level | Lottie looping on profile photo + `CircleShape` clip | ❌ Build | Wealth Lv3/5/8/11/15 unlock new frames |
| H4 | **Entrance bubble** — small animation on room entry | Lottie short animation triggered by Firestore join event | ❌ Build | Level 1 cosmetic |
| H5 | **Big entrance** — grand vehicle/effect (VIP) | Fullscreen Lottie; 3 tiers (Lv3/4/5) different animations | ❌ Build | Top revenue cosmetic |
| H6 | **Chat style** — custom message bubble look | Enum `chatStyleId` in Firestore; `UserChatBubble` composable switches style | ❌ Build | |
| H7 | **Profile card** — custom card layout | Enum `profileCardId`; different `UserCard` composable variants | ❌ Build | |
| H8 | **Item expiry system** — Eternal / 7-day / 30-day | Firestore `inventory/{uid}/items/{id}.expiresAt` timestamp; Cloud Function removes expired | ❌ Build | Time-limited items = re-purchase revenue |
| H9 | **Wealth level** (Lv1–15 by total gems spent) | Firestore `users/{uid}.totalGemsSpent`; thresholds enum in code | ❌ Build | Each level unlocks new cosmetics |
| H10 | **Level upgrade celebration** | Lottie fullscreen on threshold cross; observed by gift Cloud Function | ❌ Build | `anim_user_level_upgrade_1/2.json` |

---

### MODULE I — DIAMOND SHOP & PAYMENTS

| # | Feature | Tech | Status | Notes |
|---|---|---|---|---|
| I1 | Diamond packages display | Hardcoded tiers from `DiamondPackage` sealed class | ✅ Done | |
| I2 | Offline coin sellers flow (current placeholder) | WhatsApp deep link | ✅ Done | Temporary |
| I3 | **Razorpay integration** — UPI, cards, Paytm, net banking | Razorpay Android SDK `Checkout` | ❌ Build | Replace offline flow |
| I4 | **6 correct price tiers** | ₹2,290 = 1L diamonds; align all 6 tiers | ❌ Fix | See Part 1.5 pricing table |
| I5 | **"Boost Your Gems Today!"** event header | Firestore `activeEvents` doc → conditional banner in shop | ❌ Build | Time-limited 20% bonus events |
| I6 | **First recharge celebration** | Firestore `users/{uid}.hasRecharged`; set on first payment; triggers Lottie | ❌ Build | |
| I7 | **"We'll credit it back in 3 days"** failed payment message | UI string in payment failure state | ❌ Build | Trust signal; 5-minute task |
| I8 | **Monthly subscription card** | Razorpay Subscriptions; ₹499/month = 5,000 gems/day | ❌ Build | |
| I9 | **KYC for high-value top-ups** | Razorpay KYC flow; trigger above RBI threshold | ❌ Build | Compliance |
| I10 | Payment success/pending/failure states | UI states in ViewModel | ✅ Done | |

---

### MODULE J — 1:1 CALLS

| # | Feature | Tech | Status | Notes |
|---|---|---|---|---|
| J1 | Initiate video/audio call | Agora RTC + Firestore call invite | ✅ Done | |
| J2 | Incoming FCM notification for call | Firebase Cloud Messaging | ✅ Done | |
| J3 | **In-app incoming call overlay** (over any screen) | Compose `Box` with zIndex 3000f in MainActivity | ✅ Done | Already implemented |
| J4 | Accept / Decline from overlay | `viewModel.acceptIncomingCall()` / `declineIncomingCall()` | ✅ Done | |
| J5 | Diamond billing per minute | Cloud Function ticks every 60s; ends call on low balance | ✅ Done | |
| J6 | Auto-end call on low balance | Cloud Function + FCM notification | ✅ Done | |
| J7 | PiP during calls | Android PiP + Agora service | ✅ Done | |
| J8 | Free teaser call | `isFreeTeaserCall` flag; skips billing | ✅ Done | |
| J9 | **Private call animation** (top + bottom decorations) | Lottie `anim_private_call_top/bottom.json` inside call screen | ❌ Build | Visual polish |
| J10 | **Incoming call inside live room** | Overlay composable inside live room (same pattern as MainActivity overlay) | ❌ Build | `live_room_incoming_call.json` |
| J11 | **Intimacy score grows with calls** | Cloud Function adds intimacy points on call end | ❌ Build | |
| J12 | **Agora token from server** (replace null) | Cloud Function `generateAgoraToken` called before every channel join | ❌ Build | Security for production |

---

### MODULE K — RANKINGS & SOCIAL

| # | Feature | Tech | Status | Notes |
|---|---|---|---|---|
| K1 | Follow/Unfollow | Firestore `follows` | ✅ Done | |
| K2 | Block/Report | Firestore `blocks` / `reports` | ✅ Done | |
| K3 | **Global weekly ranking** — top gifters/hosts/earners | Firestore `weeklyRank` collection; Cloud Function aggregates every hour; resets Sunday midnight | ❌ Build | Trophy icon opens leaderboard screen |
| K4 | **Hourly ranking inside live/party rooms** | Firestore `liveRooms/{id}/hourlyRank`; Cloud Function resets every hour | ❌ Build | "This Hour" / "Last Hour" tabs |
| K5 | **"Pick Me"** — host randomly picks one viewer | Cloud Function random pick from viewers list; Firestore event → Lottie overlay | ❌ Build | `anim_pick_me_result.json` |
| K6 | **Level upgrade visible to room** | When user crosses wealth level in room, broadcast Firestore event; room shows Lottie | ❌ Build | |
| K7 | **Intimacy score** between two users | Firestore `intimacy/{uid1}_{uid2}` updated by Cloud Function on calls/gifts/time | ❌ Build | Shown on profile |
| K8 | **Follower tasks** | Firestore task definitions; user progress tracked per task | ❌ Build | "Follow 5 people → earn 100 gems" |

---

### MODULE L — ME TAB / SETTINGS

| # | Feature | Tech | Status | Notes |
|---|---|---|---|---|
| L1 | My profile stats (I Like, Like Me) | Firestore `users/{uid}` | ✅ Done | |
| L2 | Gem balance | Firestore `users/{uid}.gems` | ✅ Done | |
| L3 | Beans Center (earnings) | Firestore `users/{uid}.beans` | ✅ Done | |
| L4 | My Level | Firestore `users/{uid}.level` | ✅ Done | |
| L5 | My Bag | Firestore `inventory/{uid}` | ✅ Done | |
| L6 | Settings (blocked users, feedback, rewards) | Various Firestore reads | ✅ Done | |
| L7 | **Reward → task-based free gems** | Firestore `tasks` + `userTasks/{uid}`; button gives gems on completion | ❌ Build | Make it actually give gems via task completion |
| L8 | **Payment details** (bank account / UPI for payout) | Firestore `users/{uid}.payoutDetails`; encrypted storage | ❌ Build | Needed before real payouts |
| L9 | **Agency payout** — Sunday midnight Cloud Function | Cloud Function cron `0 0 * * 0`; transfer beans → agency | ✅ Done | Verify it fires correctly |
| L10 | **Update checker** — compare Play Store version | Play Core API `AppUpdateManager.checkForUpdateAvailability()` | ❌ Build | Force-update on critical releases |
| L11 | **Daily check-in reward** | Firestore `dailyCheckin/{uid}` with streak; claim button | ❌ Build | 7-day streak = bonus |

---

### MODULE M — NOTIFICATIONS

| # | Feature | Tech | Status | Notes |
|---|---|---|---|---|
| M1 | Incoming call FCM notification | Firebase Cloud Messaging + high-priority FCM | ✅ Done | |
| M2 | New message notification | FCM | ✅ Done | |
| M3 | Live stream started notification | FCM to followers | ✅ Done | |
| M4 | Party room created notification | FCM to followers | ✅ Done | |
| M5 | In-app notification banner | `SnackbarHostState` + custom overlay | ✅ Done | |
| M6 | **Notification deep links** | FCM data payload → NavController navigate on tap | ✅ Done | |
| M7 | **Gift received notification** | FCM from Cloud Function on gift event | ✅ Done | |

---

### MODULE N — MATCH TAB (Big Future Feature)

| # | Feature | Tech | Notes |
|---|---|---|---|
| N1 | Match tab in bottom nav | Add to NavController + BottomBar | Build after Phase 5 |
| N2 | Random match queue | Cloud Function pairs users; Agora channel created on-the-fly | |
| N3 | 60-second video chat window | Agora RTC + countdown timer | |
| N4 | Like/Skip controls | Firestore `matchSession` doc | |
| N5 | If both Like → open DM | Firestore conversation created | |
| N6 | Diamond cost per match | Cloud Function deducts before joining queue | |
| N7 | Gender/age preference filter | Firestore `matchPreferences/{uid}` | |
| N8 | Report during match | Same report flow as block/report | |

---

## PART 3 — PHASE-BY-PHASE BUILD ORDER

Do these in order. Each phase is shippable before moving to the next.

---

### PHASE 0 — Foundation ✅ COMPLETE

All core screens built: auth, home feed, profiles, live stream, PK battle, party room, calls, messages, games, gifts, diamond shop, beans/payout, PiP, FCM, settings.

---

### PHASE 1 — Core Fixes (Now)

Fix broken wires before building anything new. App must work end-to-end.

| # | Task | Files to Touch | Effort |
|---|---|---|---|
| 1 | Age + gender filter wired to ViewModel | `DatingViewModel.kt`, `HomeScreen.kt` | ✅ Done |
| 2 | Incoming call overlay in-app | `MainActivity.kt` | ✅ Already existed |
| 3 | Viewer join messages in party chat | `AudioPartyStageLayout.kt` | ✅ Already existed |
| 4 | Auto-welcome message when host starts live | Cloud Function + `LiveStreamActivity.kt` | ⏳ Pending |
| 5 | Guest enters party as listener, not auto-seated | `AudioPartyStageLayout.kt` — default Agora role fix | ⏳ Pending |
| 6 | Fix games button inside party room | `AudioPartyStageLayout.kt` — navigation wire | ⏳ Pending |
| 7 | PARTY badge on home feed cards | `HomeScreen.kt` `UserCard` composable + Firestore `isInParty` | ⏳ Pending |
| 8 | Mark ECON-08 as by-design in crosscheck | `ZIPPER_APP_CROSSCHECK.md` | ⏳ Pending |
| 9 | Correct diamond pricing tiers | `DiamondPackage` sealed class or equivalent | ⏳ Pending |

---

### PHASE 2 — Gift System Upgrade

Primary revenue driver. Make gifting feel powerful and rewarding.

| # | Task | Key Tech |
|---|---|---|
| 1 | Add Lottie dependency; create `GiftAnimationOverlay` composable | `lottie-compose` |
| 2 | Replace static gift icon with Lottie animation per gift type | Lottie `.json` files in `assets/anim/gifts/` |
| 3 | Gift combo streak animation (×2, ×3) | Lottie `anim_combo_particle.json`; ViewModel tracks timestamp |
| 4 | Scrolling gift ticker in live + party rooms | Firestore `giftEvents` listener → custom `TickerRow` composable |
| 5 | Gifts sent counter in room top bar | Firestore listener on session total |
| 6 | Wish gift — host sets goal, progress bar fills | Firestore `wishGift` sub-doc; `LinearProgressIndicator`; celebration Lottie on reach |
| 7 | Gift received section on other user's profile | Firestore `giftHistory` aggregated query |
| 8 | Super Lucky gift big win animation | Lottie `super_lucky_big_win.json` fullscreen |

---

### PHASE 3 — Live Room Upgrades

Make the live room feel premium and competitive.

| # | Task | Key Tech |
|---|---|---|
| 1 | Enable Agora Clear Vision Extension | One-line SDK enable in Agora init |
| 2 | Stream ended animation for viewers | Lottie `anim_watch_live_finished.json` |
| 3 | Viewer popup — tap viewer → card with Message + Gift | `BottomSheet` composable |
| 4 | TOP1/TOP2 gifter badge in viewer list | Sort by `gemsThisSession`; badge composable |
| 5 | Incoming call overlay inside live room | Same zIndex overlay pattern as MainActivity |
| 6 | 1:1 video call from inside live (host invites viewer) | Agora separate channel + Firestore invite |
| 7 | First recharge celebration fullscreen | Lottie `live_room_first_charge.json`; `users/{uid}.hasRecharged` flag |
| 8 | PK countdown with 4 Lottie stages | State machine: countdown → match → matching → start |
| 9 | Anchor tasks — daily host missions | Firestore daily tasks + Cloud Function reset + display in host overlay |

---

### PHASE 4 — Party Room Upgrades

Make party rooms feel alive and customisable.

| # | Task | Key Tech |
|---|---|---|
| 1 | Animated backgrounds by host level | Lottie looping background; enum by `hostLevel` |
| 2 | Room mic mode label in chat | Firestore `micMode` field; system message composable |
| 3 | Viewer list with 3 tabs (Recent / Follower / Member) | `TabRow` + filtered Firestore queries |
| 4 | Share button per viewer | Android `ShareSheet` + deep link |
| 5 | Follower task system in party | Firestore task definitions; task progress tracker |
| 6 | Gifts sent counter in party top bar | Same as live room |

---

### PHASE 5 — Cosmetics / My Bag

Build the cosmetic economy — this is recurring revenue.

| # | Task | Key Tech |
|---|---|---|
| 1 | Wealth level system (Lv1–15 by total gems spent) | Firestore `totalGemsSpent`; threshold enum; Cloud Function updates on gift |
| 2 | Avatar frames (Lottie animated borders) | Lottie on profile photo; `Box` with `CircleShape` clip |
| 3 | Entrance bubble (small Lottie on room entry) | Firestore join event → `LaunchedEffect` → Lottie |
| 4 | Big entrance (VIP Lottie, 3 tiers) | Firestore `equippedEntrance`; fullscreen Lottie on entry |
| 5 | Chat style (custom message bubbles) | `chatStyleId` enum in Firestore; switch in `UserChatBubble` |
| 6 | Profile card (custom card design) | `profileCardId` enum; variant `UserCard` composables |
| 7 | Item expiry system | Firestore `expiresAt` timestamp; Cloud Function purges expired items daily |
| 8 | Level upgrade celebration | Lottie fullscreen; trigger when `totalGemsSpent` crosses threshold |

---

### PHASE 6 — Engagement Loops

Daily and weekly systems that bring users back every day.

| # | Task | Key Tech |
|---|---|---|
| 1 | Daily check-in reward | Firestore `dailyCheckin/{uid}` + streak tracking |
| 2 | Daily Claim in Games | Firestore `dailyClaim/{uid}` 24h cooldown; Cloud Function validates |
| 3 | Task-based free gems (follow, gift, watch → earn) | Firestore `tasks` + `userTaskProgress/{uid}` |
| 4 | Intimacy score between two users | Cloud Function increments on calls/gifts/time; shown on profile |
| 5 | Boost Gems event header in diamond shop | Firestore `activeEvents` doc; banner in shop screen |
| 6 | Agency payout verification | Test Cloud Function cron `0 0 * * 0` end-to-end |
| 7 | Payment details screen (bank/UPI for hosts) | Firestore `payoutDetails`; encrypted with Android Keystore |

---

### PHASE 7 — Rankings & Social Proof

Competition drives spending.

| # | Task | Key Tech |
|---|---|---|
| 1 | Global weekly ranking screen | Firestore `weeklyRank`; Cloud Function aggregates hourly; resets Sunday |
| 2 | Trophy icon in home nav | Opens `WeeklyRankScreen` |
| 3 | Hourly ranking inside live/party rooms | Firestore `hourlyRank` sub-doc; Cloud Function resets each hour |
| 4 | "Pick Me" — host randomly selects a viewer | Cloud Function random pick; Lottie `anim_pick_me_result.json` |
| 5 | Level upgrade visible to whole room | Firestore event broadcast; room viewers see Lottie |
| 6 | Follower tasks | Firestore task definitions + progress tracker |

---

### PHASE 8 — Payments & Monetisation

Full payment flow before public launch.

| # | Task | Key Tech |
|---|---|---|
| 1 | Razorpay integration (UPI, cards, Paytm, net banking) | Razorpay Android SDK |
| 2 | All 6 diamond tiers at correct prices | See pricing table in Part 1.5 |
| 3 | Monthly subscription card | Razorpay Subscriptions API |
| 4 | KYC for high-value top-ups | Razorpay KYC widget |
| 5 | "We'll credit it back in 3 days" message | UI string only |
| 6 | GIF gift animations | Coil GIF decoder or Agora's included decoder |
| 7 | AVIF image format for profile photos | Android AVIF decoder library |

---

### PHASE 9 — Match Tab

The viral user acquisition feature. Build this once core is solid.

| # | Task | Key Tech |
|---|---|---|
| 1 | Match tab in bottom nav | NavController + BottomBar |
| 2 | Random match queue + pairing | Cloud Function pairs two users; Agora channel on-the-fly |
| 3 | 60-second video chat | Agora RTC + countdown `LaunchedEffect` |
| 4 | Like/Skip controls | Firestore `matchSession` |
| 5 | Both Like → open DM | Firestore conversation creation |
| 6 | Diamond cost per match | Cloud Function deducts before queue join |
| 7 | Gender/age filter for matching | Firestore `matchPreferences/{uid}` |
| 8 | Report during match | Same report flow |

---

### PHASE 10 — Polish & Production Hardening

Before public launch.

| # | Task | Key Tech |
|---|---|---|
| 1 | Voice pitch effects (chipmunk, deep voice) | Agora SoundTouch extension — enable `.so` |
| 2 | MMKV — replace SharedPreferences | `com.tencent:mmkv` — drop-in replacement |
| 3 | OOM monitoring | Check KOOM free tier or LeakCanary |
| 4 | Code obfuscation | ProGuard R8 (built into Gradle) + DexGuard if budget allows |
| 5 | Agora tokens from server | Cloud Function `generateAgoraToken`; replace `null` in all channel joins |
| 6 | Rate limiting on gifts + calls | Cloud Function rate-check before write |
| 7 | Custom emoji pack | `assets/emoji/` folder + `EmojiCompat` |
| 8 | K/L/Cr number formatting everywhere | Kotlin extension `Long.toIndianShort()` applied to all stat displays |
| 9 | Custom font set | Add to `assets/fonts/`; apply via `FontFamily` in theme |
| 10 | App version check + force update | Play Core `AppUpdateManager` |
| 11 | Admin panel (web dashboard) | Firebase Admin SDK + simple Next.js or React web app |
| 12 | Final QA — all flows on low-end device | Test on Android Go device (2GB RAM) |

---

## PART 4 — SUMMARY TABLE

| Phase | Theme | Items | Status |
|---|---|---|---|
| 0 | Foundation | All core screens | ✅ Done |
| 1 | Core fixes | 9 items | 🔄 In progress |
| 2 | Gift system upgrade | 8 items | ⏳ |
| 3 | Live room upgrades | 9 items | ⏳ |
| 4 | Party room upgrades | 6 items | ⏳ |
| 5 | Cosmetics / My Bag | 8 items | ⏳ |
| 6 | Engagement loops | 7 items | ⏳ |
| 7 | Rankings & social proof | 6 items | ⏳ |
| 8 | Payments & monetisation | 7 items | ⏳ |
| 9 | Match tab | 8 items | ⏳ |
| 10 | Polish & production hardening | 12 items | ⏳ |

**Total remaining: ~80 items across 10 phases.**

---

## PART 5 — KEY RULES

1. **One phase at a time.** Don't jump to Phase 3 until Phase 1 is fully cleared.
2. **Firestore is the source of truth.** All state (who's online, who's live, gem balances) lives in Firestore. UI reads it.
3. **Cloud Functions handle money.** Never deduct gems from the client. Always go through a Cloud Function that validates balance before writing.
4. **Agora handles all audio/video.** Don't try to roll your own RTC. Every live, party, and call feature uses Agora.
5. **Lottie for all animations.** Use `.json` files from `assets/anim/`. Name them clearly (e.g. `gift_rocket.json`, `entrance_level3.json`).
6. **Snap Camera Kit for all beauty/AR filters.** Already integrated. Don't add Faceunity or any other beauty SDK.
7. **Razorpay for all payments.** Add in Phase 8 when ready to go live. Don't touch Play Billing.
8. **Firebase Auth tokens secure every request.** Cloud Functions verify `context.auth.uid` before any write.
