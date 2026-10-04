# ZIPPER APP — COMPLETE KNOWLEDGE BASE
> All decisions, credentials, economy logic, and design rules in one place.
> Reference this before building any feature.

---

## 1. CREDENTIALS & SERVICES

| Service | Key / Value |
|---|---|
| **Package name** | `com.zipper.app` |
| **Firebase** | Existing project (same google-services.json) |
| **Agora App ID** | `<AGORA_APP_ID>` — not secret, but not stored here. Build reads it from `agora.appId` in `zipper-app/local.properties` (gitignored) or the `AGORA_APP_ID` env var. Canonical copy: Agora Console → Project Management. |
| **Agora Primary Certificate** | `<AGORA_APP_CERTIFICATE>` — **secret, never in this repo.** It signs RTC tokens, so anyone holding it can mint a token for any channel and bill the account. Canonical copy: Agora Console → Project → Primary Certificate. Server copy used to mint tokens: `AGORA_APP_CERTIFICATE` in the Cloud Functions secret config (`functions/.env` locally, Secret Manager in production). Local builds may put it in `agora.appCertificate` in `zipper-app/local.properties`; it must not go into a release APK. |
| **Camera / Beauty filters** | Device camera only — no Snap Camera Kit. Use CameraX + ML Kit for basic beauty or a free open-source filter library (GPUImage) |
| **Payments** | Offline only. Coin sellers collect cash and manually top up diamonds. No Razorpay, no Play Billing. |
| **Games** | Web-based casino games hosted on Firebase Hosting. URLs stored in Firestore. User's diamonds are their casino chips. |
| **Min Android** | API 26 (Android 8.0 Oreo) |
| **Target Android** | API 34 |

---

## 2. ECONOMY MODEL

### 2.1 — Currency Overview

| Currency | Who Has It | Unit | Real Value |
|---|---|---|---|
| **Diamonds** 💎 | Users (viewers / callers) | Integer | ₹2,290 = 1,00,000 diamonds |
| **Beans** 🫘 | Hosts (earners) | Integer | 1,00,000 beans = ₹1,000 payout |

### 2.2 — Diamond Pricing (6 tiers, coin seller collects cash)

| Tier | Price (₹) | Diamonds | Bonus |
|---|---|---|---|
| 1 | ₹200 | 8,000 | — |
| 2 | ₹570 | 25,000 | +3% |
| 3 | ₹1,140 | 50,000 | +4% |
| 4 | ₹2,290 | 1,00,000 | +10% |
| 5 | ₹4,580 | 2,10,000 | +15% |
| 6 | ₹9,160 | 4,40,000 | +20% |

**Coin seller commission:** ₹290 per ₹2,290 transaction (~12.66%).
**Company net per 1,00,000 diamonds sold:** ₹2,000.

### 2.3 — Gifting: Diamond → Bean Conversion

```
1 diamond gifted = 0.5 beans credited to host
```

**Why this rate:**
- 1L diamonds gifted → host earns 50,000 beans → host earns ₹500
- Viewers spent ₹2,290 for those 1L diamonds; company net = ₹2,000
- Company profit after host payout = ₹2,000 − ₹500 = ₹1,500 (75% margin) ✅
- A mid-tier host receiving 20L diamonds/week earns ≈ ₹10,000/week ✅

### 2.4 — Host Payout

- **Rate:** 1,00,000 beans = ₹1,000 payout
- **Minimum threshold:** 1,00,000 beans before payout is allowed
- **Agency commission:** 5% of payout goes to the host's agency
  - Host receives: ₹950 per 1,00,000 beans
  - Agency receives: ₹50 per 1,00,000 beans
- **Payout cycle:** Weekly (every Sunday midnight, Cloud Function triggers)
- **Payout method:** Bank transfer / UPI — host adds bank details in app

### 2.5 — Call Rate System (VIDEO CALL ONLY — no audio calls)

**Host sets their call rate in beans/minute (minimum: 375 beans/min, default: 375 beans/min)**

#### Diamonds charged to caller per minute:

| Scenario | Formula | At default 375 beans |
|---|---|---|
| **Male → Female host** | `callRateBeans × 4` diamonds/min | 1,500 💎/min |
| **Female → Male host** | `callRateBeans × 5` diamonds/min | 1,875 💎/min |
| **Same gender** | `callRateBeans × 6.67` diamonds/min | 2,500 💎/min |

> If either party is a HOST, that host always gets the host benefit (beans credit).
> Host-to-host or user-to-user: use the appropriate gender formula above.

#### Beans distribution per minute:

| Scenario | Host earns | Company earns |
|---|---|---|
| Male → Female host | `callRateBeans` (50%) | `callRateBeans` (50%) |
| Female → Male host | `callRateBeans` (40%) | `callRateBeans × 1.5` (60%) |
| Same gender | `callRateBeans` (30%) | `callRateBeans × 2.33` (70%) |

**Minimum call balance required to START a call:** 1,500 diamonds (covers 1 min of M→F default rate).

#### Implementation formula (use this in Cloud Function):

```
Given: callerGender, hostGender, callRateBeans

if (callerGender == MALE && hostGender == FEMALE):
    totalBeans = callRateBeans * 2
    hostBeans = callRateBeans
    companyBeans = callRateBeans
    diamondsPerMin = callRateBeans * 4

elif (callerGender == FEMALE && hostGender == MALE):
    totalBeans = callRateBeans / 0.4
    hostBeans = callRateBeans
    companyBeans = callRateBeans * 1.5
    diamondsPerMin = callRateBeans * 5

else (same gender or user-to-user):
    totalBeans = callRateBeans / 0.3
    hostBeans = callRateBeans
    companyBeans = callRateBeans * 2.33
    diamondsPerMin = callRateBeans * 6.67

diamondsDeductedPerMin = ceil(diamondsPerMin)
```

### 2.6 — Company Revenue Streams Summary

| Source | Company Share |
|---|---|
| Diamond sales (via coin sellers) | ₹2,000 per 1L diamonds (after ₹290 coin seller cut) |
| Gifting margin | 75% of diamond value spent on gifts |
| M→F calls | 50% of call value |
| F→M calls | 60% of call value |
| Same-gender calls | 70% of call value |
| Casino games | 100% (no host involved; house edge built into game logic) |

### 2.7 — Casino Game Logic

- User's diamonds are their chips directly (no separate currency)
- All games hosted as WebViews pointing to Firebase Hosting URLs
- House edge: minimum 60% return to player (RTP), meaning company keeps 40% on average
- Games are designed to be addictive: near-misses, streak bonuses, visual rewards
- Diamond wins/losses written to Firestore by server-side game logic (not client)

---

## 3. DESIGN SYSTEM

### 3.1 — Theme

Both light and dark themes. App auto-follows system setting, user can override in settings.

**Color Palette (designed for a premium social/entertainment app):**

```
Primary:        #FF4081  (vibrant pink-red — energy, excitement)
Secondary:      #7C4DFF  (deep purple — premium, mystery)
Tertiary:       #FFD700  (gold — wealth, rewards, diamonds)

Background Dark:   #0D0D0D  (near-black)
Surface Dark:      #1A1A2E  (deep navy-black)
Card Dark:         #16213E  (slightly lighter navy)

Background Light:  #F8F0FF  (soft lavender-white)
Surface Light:     #FFFFFF
Card Light:        #F0E8FF  (light purple tint)

Success:        #00E676  (bright green — accept, earn, win)
Error:          #FF1744  (vivid red — decline, lose, danger)
Warning:        #FFAB00  (amber — alerts, low balance)

Text Primary Dark:    #FFFFFF
Text Secondary Dark:  rgba(255,255,255,0.65)
Text Primary Light:   #1A0033
Text Secondary Light: rgba(26,0,51,0.60)

Diamond color:  #4FC3F7  (light blue — iconic for gems)
Bean color:     #A5D6A7   (soft green — earnings)
Gold accent:    #FFD700  (for levels, rankings, top gifters)
```

**Typography:** Poppins (primary) + Roboto (fallback). Both available from Google Fonts — embed in assets.

**Corner radius:** Cards = 16dp, Buttons = 12dp, Bottom sheets = 24dp top corners, Chips = 20dp.

**Elevation:** Use color elevation (no shadows in dark theme). Surfaces get lighter as they go higher.

### 3.2 — Animation Strategy

| Asset type | Format | When to use |
|---|---|---|
| Gift send/receive animations | **Lottie JSON** | Triggered on gift event; plays for 2–3 seconds over room UI |
| Entrance animations (small bubble) | **Lottie JSON** | Short (1–2s) plays when user enters room |
| Big entrance (VIP, Lv3+) | **Lottie JSON** | Full-screen 3–4s animation; only for high spenders |
| Gift combo streak (×2, ×3) | **Lottie JSON** | Triggered on rapid repeat gifts; shows multiplier |
| Level-up celebration | **Lottie JSON** | Full-screen confetti/burst |
| Avatar frames (animated borders) | **Lottie JSON** looping | On profile photo; subtle looping glow/sparkle |
| Background in party room | **Lottie JSON** looping | Ambient background motion |
| Simple UI transitions | **Compose AnimatedVisibility** | Built-in; no file needed |
| GIF gifts (simple ones) | **GIF via Coil** | Simple shimmer/sparkle gifts |

**Asset folder structure:**
```
assets/
  anim/
    gifts/
      gift_rose.json
      gift_sports_car.json
      gift_rocket.json
      gift_castle.json
      ... (one per gift type)
    combo/
      combo_x2.json
      combo_x3.json
      combo_x5.json
    entrances/
      entrance_bubble.json       (Level 1–2)
      entrance_level3.json       (Level 3)
      entrance_level4.json       (Level 4 — bigger)
      entrance_level5.json       (Level 5 — grandest)
    frames/
      frame_level3.json          (avatar frame looping)
      frame_level5.json
      frame_level8.json
      frame_level11.json
      frame_level15.json
    celebrations/
      level_up.json
      first_recharge.json
      wish_gift_complete.json
      stream_ended.json
    calls/
      incoming_call.json
      private_call_top.json
      private_call_bottom.json
    pk/
      pk_countdown.json
      pk_match.json
      pk_start.json
    party/
      party_background_default.json
      party_background_castle.json
      party_background_luxury.json
    games/
      game_rank_settle.json
      pick_me_result.json
```

**Design inspiration:** Premium, dark-first aesthetic. Animations should feel expensive — gold particles, glowing trails, color bursts. NOT cartoon/flat. Reference: dramatic casino-style reveals, luxury app entrances.

---

## 4. FEATURE DECISIONS

### Camera / Beauty
- Use **CameraX** for camera
- Use **GPUImage for Android** (free, MIT license) for basic beauty: skin smoothing, brightness, contrast
- No Snap Camera Kit (removed)

### Gifts
- Each gift has: name, diamond price, bean value (= diamondPrice × 0.5), Lottie animation file, image
- Stored in Firestore `gifts` collection + seeded by Cloud Function
- Lucky gift: random multiplier 0×/1×/2×/5×
- Super lucky gift: random multiplier 0×/1×/10×/100×

### Games
- WebView-based, URLs in Firestore `games` collection
- House edge: 40% (60% RTP)
- Diamond balance synced real-time via Firestore
- Game results written server-side to prevent cheating

### Notifications
- FCM high-priority for calls
- FCM normal priority for messages, live, party alerts

### Moderation
- Block / Report built in from day one
- Admin can ban users via Firestore `bannedUsers` collection
- Banned users see BanScreen on app open

---

## 5. TECH STACK QUICK REFERENCE

```
Language:           Kotlin
UI:                 Jetpack Compose + Material 3
Architecture:       MVVM (ViewModel + StateFlow)
Navigation:         Compose Navigation
DI:                 Hilt
Images:             Coil (AsyncImage)
Animations:         Lottie (com.airbnb.android:lottie-compose)
Camera:             CameraX
Beauty filters:     GPUImage for Android
Audio/Video:        Agora RTC SDK
Database:           Firebase Firestore
Auth:               Firebase Authentication (Phone OTP + Google)
Storage:            Firebase Storage
Notifications:      Firebase Cloud Messaging (FCM)
Functions:          Firebase Cloud Functions (Node.js / TypeScript)
Analytics:          Firebase Analytics
Crash:              Firebase Crashlytics
Local storage:      DataStore (replaces SharedPreferences)
Build:              Gradle KTS
Min SDK:            26 (Android 8)
Target SDK:         34
```

---

## 6. FIRESTORE DATA MODEL (top-level collections)

```
users/{uid}
  - name, photoUrl, bio, city, age, gender
  - diamonds, beans
  - isOnline, isLive, isInParty, isHost
  - level, wealthLevel, totalGemsSpent
  - equippedFrame, equippedEntrance, equippedChatStyle
  - callRateBeans (host setting)
  - agencyId
  - hasRecharged (bool)
  - createdAt, lastSeen

liveRooms/{roomId}
  - hostId, hostName, hostPhotoUrl
  - title, thumbnailUrl
  - viewerCount, totalGiftsThisStream
  - isActive, startedAt
  - wishGift: { target, current, isActive }
  - messages/{msgId}: { senderId, name, text, type, timestamp }
  - viewers/{uid}: { name, photoUrl, gemsThisSession, joinedAt }
  - giftEvents/{id}: { senderId, senderName, giftId, giftName, diamonds, beans, quantity, timestamp }

partyRooms/{roomId}
  - hostId, title, backgroundTheme
  - micMode (FREE / CONSENT)
  - seats[8]: { userId, displayName, photoUrl, isMuted }
  - viewerCount, totalGiftsThisSession
  - messages/{msgId}
  - viewers/{uid}
  - giftEvents/{id}

gifts/{giftId}
  - name, imageUrl, lottiePath
  - diamondPrice, beanValue
  - isLucky, isSuperLucky
  - sortOrder

games/{gameId}
  - name, iconUrl, webUrl
  - isHot, isNew
  - houseEdge (0.40)
  - sortOrder

weeklyRank/{weekId}
  - topGifters: [{uid, name, photoUrl, totalGems, rank}]
  - topHosts: [{uid, name, photoUrl, totalBeans, rank}]
  - resetAt

transactions/{txId}
  - uid, type (GIFT_SENT / GIFT_RECEIVED / CALL / GAME_WIN / GAME_LOSS / RECHARGE / PAYOUT)
  - diamonds, beans, description
  - createdAt

agencies/{agencyId}
  - name, ownerUid
  - hosts: [uid]
  - totalEarnings, pendingPayout

bannedUsers/{uid}
  - reason, bannedAt, bannedBy
```

---

## 7. CLOUD FUNCTIONS LIST

| Function | Trigger | What It Does |
|---|---|---|
| `onGiftSent` | Firestore write on giftEvents | Deducts diamonds from sender, credits beans to host, updates agency, logs transaction |
| `onCallTick` | Scheduled every 60s | Deducts diamonds from caller, credits beans to host, ends call if balance < 1 min |
| `onCallEnd` | Firestore write | Final tick, clean up call session |
| `weeklyRankUpdate` | Cron every hour | Aggregates top gifters/hosts for current week |
| `weeklyPayout` | Cron Sunday midnight | Transfers beans → payout queue for all hosts above threshold; deducts agency cut |
| `dailyClaimReset` | Cron midnight daily | Resets daily claim eligibility |
| `generateAgoraToken` | HTTPS callable | Generates Agora RTC token for channel join |
| `onUserWealthUpdate` | Firestore trigger on totalGemsSpent | Updates wealthLevel when threshold crossed; sends level-up event |
| `gameBet` | HTTPS callable | Validates bet, runs house-edge algorithm, returns result, updates diamonds |

---

## 8. BUILD ORDER (PHASES)

**Phase 0 (now):** Project skeleton — Gradle setup, theme, navigation shell, Hilt, Firebase init
**Phase 1:** Auth — Phone OTP, Google, Guest, profile setup
**Phase 2:** Home feed — user cards, filters, search
**Phase 3:** User profile + My profile + Edit profile
**Phase 4:** Live streaming — host + viewer (Agora)
**Phase 5:** Gift system + animations
**Phase 6:** Party room (multi-mic audio)
**Phase 7:** 1:1 Video calls + billing
**Phase 8:** Messages / DM chat
**Phase 9:** Games (WebView + diamond betting)
**Phase 10:** Diamond shop (coin seller flow)
**Phase 11:** Beans center + payout
**Phase 12:** Cosmetics (frames, entrances, My Bag)
**Phase 13:** Rankings + social
**Phase 14:** Notifications (FCM)
**Phase 15:** Admin + moderation
**Phase 16:** Polish (fonts, animations, number formatting)
