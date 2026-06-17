# ZIPPER APP — FULL FUNCTIONALITY CROSSCHECK
> Last updated: Session 3 (all fixes applied)
> To fix an issue: tell Claude the **Issue ID** (e.g. "fix AUTH-03")

---

## LEGEND
- ✅ Working — implemented and wired end-to-end
- ⚠️ Partial — exists but has a known gap or caveat
- ❌ Missing — not implemented / broken

---

## 1. AUTHENTICATION & ONBOARDING

| # | Feature | Status | Issue ID | Notes |
|---|---------|--------|----------|-------|
| 1 | Phone OTP login (+91 hint, 10-digit, 6-digit OTP) | ✅ | — | |
| 2 | Google Sign-In | ✅ | — | |
| 3 | Guest login (gender required first) | ✅ | — | |
| 4 | New user → EditProfileScreen on first login | ✅ | AUTH-04 | Fixed session 2 |
| 5 | Returning user → goes straight to home | ✅ | AUTH-04 | Fixed session 2 |
| 6 | Face verification flow | ✅ | AUTH-05 | Fixed session 2 |
| 7 | Single-device enforcement (DeviceTracker) | ✅ | — | |
| 8 | Ban check on app start (DeviceBanScreen) | ✅ | — | |

---

## 2. HOME / DISCOVERY FEED

| # | Feature | Status | Issue ID | Notes |
|---|---------|--------|----------|-------|
| 1 | 4 tabs: All / Online / Live / Following | ✅ | — | |
| 2 | User cards (photo, name, LIVE badge, online dot, level) | ✅ | — | |
| 3 | Search users (reactive) | ✅ | — | |
| 4 | Pull-to-refresh | ✅ | — | |
| 5 | Tap card → UserProfileScreen | ✅ | — | |
| 6 | Filter sheet (city, language, hobbies) | ✅ | — | |
| 7 | Age shown on user cards | ⚠️ | HOME-07 | Age not shown on cards |
| 8 | Age range filter slider | ❌ | HOME-08 | No age range or gender filter |
| 9 | Gender filter | ❌ | HOME-09 | Missing from filter sheet |

---

## 3. USER PROFILE SCREEN (Other User)

| # | Feature | Status | Issue ID | Notes |
|---|---------|--------|----------|-------|
| 1 | Hero: photo, name, age, city, gender, level, verified | ✅ | — | |
| 2 | LIVE badge shown when profile.isLive | ✅ | — | |
| 3 | Online dot on avatar | ✅ | — | |
| 4 | Like / Unlike button | ✅ | — | |
| 5 | Video Call button (online-only) | ✅ | — | |
| 6 | **Audio Call button** | ✅ | UPS-06 | **Fixed session 3** |
| 7 | Message button | ✅ | — | |
| 8 | Gift button → GiftSelectionSheet | ✅ | — | |
| 9 | **"Watch Live Stream" CTA when profile.isLive** | ✅ | UPS-09 | **Fixed session 3** |
| 10 | Gallery lightbox (swipeable) | ✅ | — | |
| 11 | Bio section | ✅ | — | |
| 12 | Hobbies, Likes, Dislikes chips | ✅ | — | |
| 13 | **3-dot Report/Block menu always visible** | ✅ | UPS-13 | **Fixed session 3 (was hidden when LIVE)** |
| 14 | Report dialog with reason selection | ✅ | — | |

---

## 4. MY PROFILE SCREEN

| # | Feature | Status | Issue ID | Notes |
|---|---------|--------|----------|-------|
| 1 | Profile ID shown (ID: XXXXX) | ✅ | — | |
| 2 | Diamond balance in stats row | ✅ | — | |
| 3 | Level badge | ✅ | — | |
| 4 | Cover + avatar + name/gender/city | ✅ | — | |
| 5 | Stats: Liked Me, I Liked, Level, Diamonds | ✅ | — | |
| 6 | Hobbies / Interests chips | ✅ | MYPROF-06 | Fixed session 2 |
| 7 | **Likes chips** | ✅ | MYPROF-07 | Fixed session 2 |
| 8 | **Dislikes chips** | ✅ | MYPROF-08 | Fixed session 2 |
| 9 | **Languages chips** | ✅ | MYPROF-09 | Fixed session 2 |
| 10 | Gallery with zoom + video support | ✅ | — | |
| 11 | Gifts Sent / Gifts Received sections | ✅ | — | |
| 12 | Return-to-live banner when streaming | ✅ | — | |

---

## 5. PROFILE / SETTINGS TAB (Tab 4)

| # | Feature | Status | Issue ID | Notes |
|---|---------|--------|----------|-------|
| 1 | Logout with confirmation dialog | ✅ | — | |
| 2 | Delete account with confirmation | ✅ | — | |
| 3 | Referral code display | ✅ | — | |
| 4 | Blocked users sheet + unblock | ✅ | — | |
| 5 | Language selector | ✅ | — | |
| 6 | Diamonds → Beans conversion (Girls only) | ✅ | — | |
| 7 | Custom call price (Level 4+ Girls) | ✅ | — | |
| 8 | Streaming history | ✅ | — | |
| 9 | Feedback & Support | ✅ | — | |
| 10 | My Bag (cosmetics/frames) | ✅ | — | |
| 11 | My Rewards with claim | ✅ | — | |
| 12 | Dark/light theme toggle | ✅ | — | |

---

## 6. EDIT PROFILE

| # | Feature | Status | Issue ID | Notes |
|---|---------|--------|----------|-------|
| 1 | Name, bio (250 chars) | ✅ | — | |
| 2 | Age (locked after first save) | ✅ | — | |
| 3 | Gender (locked after first save) | ✅ | — | |
| 4 | City (locked after first save) | ✅ | — | |
| 5 | Photo upload + gallery (up to 9) | ✅ | — | |
| 6 | Hobbies, likes, dislikes, languages (chip multi-select) | ✅ | — | |
| 7 | **Save actually closes screen** | ✅ | EDIT-07 | Fixed session 2 |
| 8 | Change phone (OTP flow) | ✅ | — | |
| 9 | Change email (verification email) | ✅ | — | |
| 10 | Referral code entry (if not set) | ✅ | — | |

---

## 7. LIVE STREAMING (Solo Host)

| # | Feature | Status | Issue ID | Notes |
|---|---------|--------|----------|-------|
| 1 | Start live stream | ✅ | — | |
| 2 | Viewer count live | ✅ | — | |
| 3 | Join system message per viewer | ✅ | — | |
| 4 | Live chat (session-scoped) | ✅ | — | |
| 5 | Gift overlay animations | ✅ | — | |
| 6 | Audience kick | ✅ | — | |
| 7 | LIVE status cleared on stream end | ✅ | — | |
| 8 | Snap Camera Kit AR lenses | ✅ | — | |
| 9 | Mic mute / camera flip controls | ✅ | — | |
| 10 | Host welcome message on stream start | ⚠️ | LIVE-10 | No auto-welcome; per-viewer join msg exists |

---

## 8. LIVE VIEWER

| # | Feature | Status | Issue ID | Notes |
|---|---------|--------|----------|-------|
| 1 | Watch live stream | ✅ | — | |
| 2 | Send gifts (diamond cost) | ✅ | — | |
| 3 | Live chat | ✅ | — | |
| 4 | Gift overlay animations visible | ✅ | — | |
| 5 | Follow host from stream | ✅ | — | |
| 6 | Leave stream | ✅ | — | |
| 7 | In-app PiP (float over other screens on back) | ✅ | — | |

---

## 9. PK BATTLE (Arena)

| # | Feature | Status | Issue ID | Notes |
|---|---------|--------|----------|-------|
| 1 | Invite / start PK | ✅ | — | |
| 2 | Split-screen video | ✅ | — | |
| 3 | Bean counter per side | ✅ | — | |
| 4 | Countdown timer | ✅ | — | |
| 5 | Winner announcement card | ✅ | — | |
| 6 | Rematch flow | ✅ | — | |
| 7 | Audience gifts attributed to correct side | ✅ | — | |
| 8 | **Battle prize pool credited to winner** | ✅ | PK-08 | Fixed session 2 (DatingViewModel) |
| 9 | PK viewer counts per side | ✅ | — | |

---

## 10. PARTY ROOM (Audio)

| # | Feature | Status | Issue ID | Notes |
|---|---------|--------|----------|-------|
| 1 | Create / join party | ✅ | — | |
| 2 | Mic seat management | ✅ | — | |
| 3 | Audience seat request | ✅ | — | |
| 4 | Leave party | ✅ | — | |
| 5 | Party gifts | ✅ | — | |
| 6 | FCM deep-link to party lobby | ✅ | — | |
| 7 | Viewer join message in party chat | ⚠️ | PARTY-07 | Unclear if join messages fire in party chat |

---

## 11. VIDEO / AUDIO CALLS (1:1)

| # | Feature | Status | Issue ID | Notes |
|---|---------|--------|----------|-------|
| 1 | Caller pays diamonds per minute | ✅ | — | |
| 2 | Diamond cost displayed during call | ✅ | — | |
| 3 | **Auto-end on insufficient balance** | ✅ | CALL-03 | Fixed session 2 (5s check) |
| 4 | **Billing fires with elapsed seconds on end** | ✅ | CALL-04 | Fixed session 2 |
| 5 | Toggle camera on/off (video call) | ✅ | — | |
| 6 | Mute / unmute | ✅ | — | |
| 7 | Speaker toggle (audio call) | ✅ | — | |
| 8 | End call button | ✅ | — | |
| 9 | Remote-end detection (auto-end local side) | ✅ | — | |
| 10 | Draggable local preview (video) | ✅ | — | |
| 11 | Free teaser call | ✅ | — | |
| 12 | **TeaserRechargeBottomSheet** | ✅ | CALL-12 | **Fixed session 3** |
| 13 | PremiumAppIncomingCallOverlay | ❌ | CALL-13 | TODO comment in MainActivity |

---

## 12. PICTURE-IN-PICTURE (PiP)

| # | Feature | Status | Issue ID | Notes |
|---|---------|--------|----------|-------|
| 1 | AndroidManifest: supportsPictureInPicture on MainActivity | ✅ | PIP-01 | Fixed session 2 |
| 2 | AndroidManifest: supportsPictureInPicture on LiveStreamActivity | ✅ | PIP-02 | Fixed session 2 |
| 3 | MainActivity: Home press → OS PiP during video call | ✅ | PIP-03 | Fixed session 2 |
| 4 | MainActivity: Controls hidden in PiP | ✅ | PIP-04 | Fixed session 2 |
| 5 | LiveStreamActivity: Home press → OS PiP (viewer/PK) | ✅ | PIP-05 | Fixed session 2 |
| 6 | LiveStreamActivity: Overlays hidden in PiP | ✅ | PIP-06 | Fixed session 2 |
| 7 | In-app floating PiP (GlobalLivePip composable) | ✅ | — | |

---

## 13. MESSAGES / CHAT

| # | Feature | Status | Issue ID | Notes |
|---|---------|--------|----------|-------|
| 1 | Thread list sorted newest-first | ✅ | — | |
| 2 | Per-thread unread count badges | ✅ | — | |
| 3 | **Nav bar Messages tab badge** | ✅ | MSG-03 | **Fixed session 3 (was hardcoded 0)** |
| 4 | CRM Announcements tab | ✅ | — | |
| 5 | DM chat with send/receive | ✅ | — | |
| 6 | Real-time listener | ✅ | — | |
| 7 | Pull-to-refresh | ✅ | — | |
| 8 | Image messages | ✅ | — | |
| 9 | "Latest messages ↓" scroll pill | ✅ | MSG-09 | Fixed session 2 |
| 10 | Message text readable (not white-on-white) | ✅ | MSG-10 | Fixed session 2 |

---

## 14. GAMES CENTER

| # | Feature | Status | Issue ID | Notes |
|---|---------|--------|----------|-------|
| 1 | 12 native mini-games (Aviator, Wheel, Slots, etc.) | ✅ | — | |
| 2 | Diamond balance guard on all games | ✅ | — | |
| 3 | Game win credits coinBalance | ✅ | — | |
| 4 | Bet presets (10, 50, 100, 500, 1K, 5K) | ✅ | — | |
| 5 | HOT/NEW badges on game cards | ✅ | — | |
| 6 | **Ranking tab — Firestore top players** | ✅ | GAME-06 | **Fixed session 3** |
| 7 | **History tab — user's game_transactions** | ✅ | GAME-07 | **Fixed session 3** |
| 8 | Battle lobby (BattleLobbyScreen) | ✅ | — | |
| 9 | Multiplayer / battle games (vs real user) | ⚠️ | GAME-09 | All games are single-player vs RNG house |

---

## 15. DIAMOND ECONOMY

| # | Feature | Status | Issue ID | Notes |
|---|---------|--------|----------|-------|
| 1 | Diamond balance shown app-wide | ✅ | — | |
| 2 | DiamondShopScreen (packages + instructions) | ✅ | — | |
| 3 | Transaction history (last 10) | ✅ | — | |
| 4 | Spending on gifts | ✅ | — | |
| 5 | Spending on calls | ✅ | — | |
| 6 | Battle prize pool credited to winner | ✅ | ECON-06 | Fixed session 2 |
| 7 | Auto-end call on insufficient balance | ✅ | ECON-07 | Fixed session 2 |
| 8 | In-app Google Play / Razorpay purchase | ✅ | ECON-08 | **By design** — offline coin sellers only; no in-app payment needed |

---

## 16. BEAN ECONOMY (Host Earnings)

| # | Feature | Status | Issue ID | Notes |
|---|---------|--------|----------|-------|
| 1 | Bean balance display | ✅ | — | |
| 2 | Rupee equivalent (1L beans = ₹1,000) | ✅ | — | |
| 3 | Host level + progress bar | ✅ | — | |
| 4 | Earning breakdown (gift/call earn transactions) | ✅ | — | |
| 5 | Minimum payout threshold enforced (1L beans) | ✅ | — | |
| 6 | **"Contact Agency for Payout" opens WhatsApp** | ✅ | BEAN-06 | **Fixed session 3** |

---

## 17. GIFT SYSTEM

| # | Feature | Status | Issue ID | Notes |
|---|---------|--------|----------|-------|
| 1 | GiftSelectionSheet with catalog | ✅ | — | |
| 2 | Gift overlay animations in live/calls | ✅ | — | |
| 3 | Gift audio playback | ✅ | — | |
| 4 | CRM gifts with video | ✅ | — | |
| 5 | PK battle gift attribution per side | ✅ | — | |
| 6 | Gift history (sent + received) on My Profile | ✅ | — | |

---

## 18. NOTIFICATIONS

| # | Feature | Status | Issue ID | Notes |
|---|---------|--------|----------|-------|
| 1 | Incoming call notification | ✅ | — | |
| 2 | Message notification | ✅ | — | |
| 3 | Live stream notification (FCM deep-link) | ✅ | — | |
| 4 | Audio party lobby notification (FCM deep-link) | ✅ | — | |
| 5 | Decline call from notification | ✅ | — | |
| 6 | PremiumApp incoming call overlay (in-app) | ❌ | NOTIF-06 | TODO in MainActivity — not implemented |

---

## OPEN ISSUES SUMMARY

> These are the remaining gaps. Tell Claude the **Issue ID** to fix.

| Issue ID | Screen | Description | Priority |
|----------|--------|-------------|----------|
| HOME-07 | HomeScreen | Age not shown on user discovery cards | Low |
| HOME-08 | HomeScreen | No age range slider in filter sheet | Medium | ✅ Fixed session 3 |
| HOME-09 | HomeScreen | No gender filter in filter sheet | Medium | ✅ Fixed session 3 |
| LIVE-10 | LiveStreamActivity | No auto host welcome message on stream start | Low | ✅ Fixed session 3 |
| CALL-13 | MainActivity | PremiumAppIncomingCallOverlay not implemented | High | ✅ Fixed session 3 |
| GAME-09 | GamesScreen | All games single-player vs RNG; no real multiplayer | Low | ⚠️ By design for now |
| ECON-08 | DiamondShopScreen | No in-app payment (Google Play / Razorpay) | High | ✅ By design — offline coin sellers |
| PARTY-07 | AudioPartyStageLayout | Viewer join messages may not appear in party chat | Medium | ✅ Fixed session 3 |
| NOTIF-06 | MainActivity | PremiumApp incoming call overlay (in-app UI) | High | ✅ Fixed session 3 (CALL-13) |

---

## FIXES APPLIED (ALL SESSIONS)

### Session 1 — Previous (Tasks 1–12)
- AUTH-04 Login screen unblocked + new user routing
- AUTH-05 Face verification fix
- EDIT-07 EditProfileScreen save closes screen
- Various nav/UI/screen bugs

### Session 2 — Tasks 13–15 + PiP
- PK-08 Battle prize pool credited to winner
- MYPROF-06/07/08/09 MyProfileScreen likes/dislikes/languages added
- CALL-03/04 VideoCallScreen billing + auto-end on low balance
- PIP-01..06 Full PiP implementation (MainActivity + LiveStreamActivity + AndroidManifest)

### Session 3 — Tasks 16–20 (Crosscheck fixes)
- UPS-06 Audio call button added to UserProfileScreen
- UPS-09 "Watch Live Stream" CTA on UserProfileScreen when profile.isLive
- UPS-13 3-dot report/block menu now always visible (was hidden when LIVE)
- MSG-03 Nav bar Messages badge wired to real unread count
- CALL-12 TeaserRechargeBottomSheet implemented
- GAME-06 Games Ranking tab — real Firestore query (top players by coins)
- GAME-07 Games History tab — real Firestore query (user's game_transactions)
- BEAN-06 Bean Center "Contact Agency" button opens WhatsApp with payout request

### Session 3 continued — Tasks 21–26 (Remaining open issues)
- HOME-07 UserCard shows age + city (e.g. "24, Mumbai")
- HOME-08/09 FilterBottomSheet — RangeSlider (18–60) + gender chips (All/Male/Female)
- CALL-13/NOTIF-06 In-app incoming call overlay in MainActivity (avatar, accept/decline)
- PARTY-07 AudioPartyStageLayout — viewer join messages detected from seat state changes, shown as floating bubbles
- LIVE-10 Auto-welcome system message sent to RTDB live_chat on stream start
- ECON-08 Marked as by design — no in-app payment (offline coin sellers)
