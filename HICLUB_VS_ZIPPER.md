# HiClub vs Zipper — Full Feature Comparison
> Source: 12 HiClub screenshots + full APK analysis (manifest, native libs, SVGA animations, asset structure, string tables)
> Purpose: Feature-by-feature decision — keep / skip / adapt for Zipper
>
> Legend:
> - ✅ IN ZIPPER — already built
> - ⚠️ PARTIAL — exists but incomplete
> - ❌ MISSING — not in Zipper yet
> - 🚫 SKIP — consciously don't want it
> - 🔧 TOOL — third-party SDK confirmed from APK

---

## SECTION 0 — SDKs & TECH STACK (confirmed from .so native libraries)

| Library File | What It Is | HiClub Uses | Zipper Uses | Decision |
|---|---|---|---|---|
| `libagora-rtc-sdk.so` | **Agora RTC** — live video/audio streaming | ✅ | ✅ Agora | Same — keep |
| `libagora-fdkaac.so` | Agora AAC codec | ✅ | ✅ | Same |
| `libagora-ffmpeg.so` | Agora video processing | ✅ | ✅ | Same |
| `libagora-soundtouch.so` | Agora audio pitch/effects | ✅ | — | Add it |
| `libagora_clear_vision_extension.so` | Agora video clarity AI | ✅ | — | Add it |
| `libCNamaSDK_lk.so` + `libfuai_lk.so` | **Faceunity CNamaSDK** — face AR, beauty | ✅ | Snap Camera Kit | Check for device own filters; if not available then keep Snap — already integrated |
| `libBugly.so` + `libBugly_Native.so` | **Bugly** crash reporting (Tencent) | ✅ | Firebase Crashlytics | Keep Firebase Crashlytics |
| `libmmkv.so` | **MMKV** fast key-value store (WeChat/Tencent) | ✅ | SharedPreferences | Add MMKV later |
| `libne_audio.so` | **NetEase IM (NIM)** audio | ✅ | Firebase Firestore | Keep Firebase |
| `libquicclient-jni.so` | NIM QUIC protocol | ✅ | — | Not needed |
| `libmarsxlog.so` | **MarsXLog** logging (WeChat) | ✅ | Logcat + Firebase | Keep our setup |
| `libkwai-android-base.so` | Kuaishou base lib | ✅ | — | Not needed |
| `libkoom-fast-dump.so` | **KOOM** OOM monitoring (Kuaishou) | ✅ | — | Check for other free packages; otherwise not required |
| `libhiiclub_azome.so` | Custom media lib (WebRTC, FLAC, AAC) | ✅ | Agora handles it | Already covered by Agora |
| `librtmp-jni.so` | **RTMP** streaming protocol | ✅ | Agora | Agora covers this |
| `libanimation-decoder-gif.so` | GIF decoder | ✅ | — | Add it |
| `libavif_android.so` | AVIF image format | ✅ | JPEG/PNG | Add it |
| `libartemis.so` | Anti-tamper / obfuscation | ✅ | — | Add similar free package if available; otherwise leave it |
| `libxhook_lib.so` | PLT hooking | ✅ | — | Add similar free package if available; otherwise leave it |
| `librenderscript-toolkit.so` | Image processing (blur, filters) | ✅ | — | Add if free or similar package available — needed for beauty filters |
| `libtraceroute.so` | Network diagnostics | ✅ | — | Add similar free package; otherwise leave it |

**Summary:** Our Agora + Firebase + Snap Camera Kit stack matches HiClub's core. No SDK changes needed for core features.

---

## SECTION 1 — NAVIGATION STRUCTURE

Keep Zipper's current navigation structure as-is.

| # | HiClub Feature | Zipper Status | Decision | Notes |
|---|---|---|---|---|
| 1 | Bottom nav: **For You** (home discovery) | ✅ Tab 1 | Keep | |
| 2 | Bottom nav: **Follow** | ✅ sub-tab on Home | Keep | |
| 3 | Bottom nav: **Game** | ✅ Tab 3 | Keep | |
| 4 | Bottom nav: **Messages** with unread badge | ✅ Tab 4 | Keep | |
| 5 | Bottom nav: **Me** (profile + settings) | ✅ Tab 5 | Keep | |
| 6 | Home sub-tabs: **Hot / Live / Party / Match** | ⚠️ We have All/Online/Live/Following | Adapt | Consider merging Live+Party under one tab |
| 7 | **Match tab** — random video speed-matching queue | ❌ | Later | Big feature; build after core is solid |
| 8 | Search icon in top nav | ✅ | Keep | |
| 9 | **Rankings / Trophy icon** in top nav | ❌ | Add | Opens global weekly leaderboard |

---

## SECTION 2 — HOME / DISCOVERY FEED

| # | HiClub Feature | Zipper Status | Decision | Notes |
|---|---|---|---|---|
| 1 | User cards grid | ✅ | Keep | |
| 2 | **Avatar frames** on cards (animated borders) | ❌ | Add it | Unlocked by wealth level |
| 3 | Level badge on card | ✅ | Keep | |
| 4 | Online dot | ✅ | Keep | |
| 5 | LIVE badge | ✅ | Keep | |
| 6 | PARTY badge (user in party room) | ❌ | **Add it** | Low effort, missing |

---

## SECTION 3 — LIVE STREAMING

### 3A — Live Room (Viewer)

| # | HiClub Feature | Zipper Status | Decision | Notes |
|---|---|---|---|---|
| 1 | Agora RTC live video | ✅ | Keep | |
| 2 | **Hourly Rank button** in live room | ❌ | Future | Not for now |
| 3 | **Gift announcement scrolling ticker** ("X won 65000 💎 by sending [gift]") | ❌ | Future | Not for now |
| 4 | **Intimacy score** shown in live | ❌ | Future | Not for now |
| 5 | **Big entrance animation** when high-level user enters | ❌ | **Add it** | Levels 3/4/5 have different entrance SVGAs |
| 6 | **Wish gift progress bar** — host sets gem goal, viewers contribute | ❌ | **Add it** | `anim_wish_gift_progress_bar.svga` — huge gifting driver |
| 7 | **Floating gift animation** overlay (SVGA) | ⚠️ Basic icon only | **Improve it** | Full SVGA/Lottie animations |
| 8 | **Floating game button** in live | ⚠️ TODO comment | **Fix it** | `anim_live_float_game.svga` |
| 9 | **Gift combo/streak** animation | ❌ | **Add it** | For lucky gifting combo — X2, X3 multiplier effect |
| 10 | Viewer list with level badges + gem amounts | ⚠️ Basic | Improve it | Show gems sent per viewer |
| 11 | Viewer popup: **Message + Send Gifts** buttons | ❌ | **Add it** | Tap viewer → see profile card |
| 12 | **TOP1/TOP2 gifter badge** next to top viewers | ❌ | **Add it** | Drives competition |
| 13 | **First recharge celebration** for new payers | ❌ | **Add it** | `live_room_first_charge.svga` |
| 14 | **Stream ended animation** for viewers | ❌ | Add it | `anim_watch_live_finished.svga` |
| 15 | **"Pick Me" feature** | ❌ | Future | Not for now |
| 16 | **Video call FROM live room** | ❌ | **Add it** | Host can do 1:1 call with a viewer mid-stream |
| 17 | **Incoming call overlay inside live** | ❌ | **Add it** | `live_room_incoming_call.svga` |
| 18 | PK Battle | ✅ | Keep | |
| 19 | PK countdown animation | ⚠️ | Improve it | HiClub has 4 SVGA stages (countdown/match/matching/start) |

### 3B — Live Room (Host / Broadcaster)

| # | HiClub Feature | Zipper Status | Decision | Notes |
|---|---|---|---|---|
| 1 | Full-screen camera (Agora) | ✅ | Keep | |
| 2 | **Anchor tasks** — daily host challenges | ❌ | **Add it** | Tasks drive host engagement |
| 3 | Wish gift goal (set target gems, viewers contribute) | ❌ | **Add it** | Same as viewer side |
| 4 | **Free call** mode — host can enable free calls | ❌ | **Add it** | `live_room_free_call.svga` |
| 5 | Gift scroll ticker | ❌ | **Add it** | Same as viewer side |
| 6 | Agora Clear Vision Extension (video quality boost) | ❌ | **Add it** | Just needs the .so — already in Agora SDK |

---

## SECTION 4 — PARTY ROOM

### 4A — Party List

| # | HiClub Feature | Zipper Status | Decision | Notes |
|---|---|---|---|---|
| 1 | Party room cards with thumbnail, name, seats | ✅ | Keep | |
| 2 | Host level badge on card | ✅ | Keep | |
| 3 | Viewer count | ✅ | Keep | |
| 4 | Start Party button | ✅ | Keep | |

### 4B — Inside Party Room (Guest)

| # | HiClub Feature | Zipper Status | Decision | Notes |
|---|---|---|---|---|
| 1 | **Animated party room background** (castle, scenes by level) | ❌ | **Add it** | Major visual differentiator |
| 2 | Mic seats | ✅ | Keep | |
| 3 | Room name + viewer count | ✅ | Keep | |
| 4 | **Gifts sent counter in top bar** (💎 0) | ❌ | **Add it** | Total gems sent this session |
| 5 | **Scrolling gift ticker** ("X Won 65000 💎") | ❌ | **Add it** | |
| 6 | Welcome message on entry | ✅ | Keep | |
| 7 | Room mic mode shown in chat ("Room mic mode: Free") | ❌ | Add it | |
| 8 | "[User] joined the room" chat message | ⚠️ PARTY-07 | **Fix it** | Pending task |
| 9 | **Games from inside party** | ⚠️ Broken | **Fix it** | |
| 10 | **Big entrance animation** for high-level users | ❌ | **Add it** | Level 3/4/5 entrances |
| 11 | Gift button | ✅ | Keep | |
| 12 | Viewer list: **Recent chats / Follower / Member tabs** | ❌ | **Add it** | HiClub has 3 tabs in viewer list |
| 13 | Each viewer has **Share button** | ❌ | Add it | Invite friends to this room |
| 14 | Guest enters as listener (not auto-seated) | ❌ BUG | **Fix it** | |
| 15 | **Follower task system** | ❌ | **Add it** | `tvFollowerTask` / `tvFollowerTaskDesc` strings found |

### 4C — Hourly Ranking (Inside Room)

Not required for now — revisit in future.

---

## SECTION 5 — GAMES CENTER

| # | HiClub Feature | Zipper Status | Decision | Notes |
|---|---|---|---|---|
| 1 | Games accessible from bottom nav (Game tab) | ✅ | Keep | |
| 2 | Games accessible from **inside live/party room** | ⚠️ Broken | **Fix it** | |
| 3 | WebView-based real casino games | ✅ Architecture | **Fill URLs** | All `webUrl=""` still empty |
| 4 | **Ranking tab** | ✅ | Keep | |
| 5 | **Game history / transactions** | ✅ | Keep | |
| 6 | **Game rank settlement animation** | ❌ | Add it | SVGA anim available |
| 7 | **Game Store** tab (buy power-ups) | ❌ | Add it | |
| 8 | **Blue Gems** (separate in-game currency) | ❌ | 🚫 Skip | Not required |
| 9 | **Daily Claim** button (free gems from tasks) | ❌ | **Add it** | Claim button visible in HiClub screenshots |
| 10 | Games shown in 4-column grid with icons | ✅ | Keep | |
| 11 | HOT / NEW badges | ✅ | Keep | |

---

## SECTION 6 — MY BAG (COSMETICS / INVENTORY)

| # | HiClub Feature | Zipper Status | Decision | Notes |
|---|---|---|---|---|
| 1 | **Avatar frame** (animated border around profile pic) | ⚠️ Screen exists, no real frames | **Add it** | Wealth Lv11 frame shown in HiClub |
| 2 | **Chat style** (custom message bubbles) | ❌ | Add it | Changes how chat messages look |
| 3 | **Profile card** (custom card design) | ❌ | Add it | |
| 4 | **Entrance bubble** (small animation on room entry) | ❌ | **Add it** | |
| 5 | **Big entrance** (grand vehicle/effect for VIPs) | ❌ | **Add it** | Huge revenue from top spenders |
| 6 | "Wearing" tag + "Use It" button | ⚠️ | Keep | |
| 7 | **Item expiry** ("Effective Time: Eternal" or X days) | ❌ | **Add it** | Time-limited items = recurring revenue |
| 8 | Items unlocked by **wealth level** (spending level) | ❌ | **Add it** | `live_room_enter_room_level_3/4/5.svga` confirms this |
| 9 | **Level upgrade celebration** animation | ❌ | **Add it** | `anim_user_level_upgrade_1.svga` + `_2.svga` |

---

## SECTION 7 — GEMS / DIAMOND SHOP

| # | HiClub Feature | Zipper Status | Decision | Notes |
|---|---|---|---|---|
| 1 | Gem packages with bonus shown | ✅ | Keep | |
| 2 | 6 price tiers (₹200 to ₹9,160) | ✅ | Align tiers | Logic: ₹2,290 = 1 lakh diamonds |
| 3 | **"Boost Your Gems Today!"** event header | ❌ | **Add it** | Doubles revenue during events |
| 4 | **First recharge celebration** (SVGA) | ❌ | **Add it** | `live_room_first_charge.svga` |
| 5 | Gem balance visible in top of shop | ✅ | Keep | |
| 6 | **"Payment Successful / Pending / Failed"** states | ✅ | Keep | Already handled |
| 7 | **"We'll credit it back in 3 days"** for failed payments | ❌ | **Add it** | Found in strings |

---

## SECTION 8 — ME TAB / PROFILE + SETTINGS

| # | HiClub Feature | Zipper Status | Decision | Notes |
|---|---|---|---|---|
| 1 | I Like / Like Me stats | ✅ | Keep | |
| 2 | Gems balance | ✅ | Keep | |
| 3 | Beans Center balance | ✅ | Keep | |
| 4 | **Reward → Get Free Gems** (task-based) | ⚠️ My Rewards exists | Improve it | Make it give free gems via tasks |
| 5 | My Bag | ✅ | Keep | |
| 6 | Gems Center (recharge) | ✅ | Keep | |
| 7 | My Level | ✅ | Keep | |
| 8 | Settings | ✅ | Keep | |
| 9 | Feedback | ✅ | Keep | |
| 10 | Update checker | ❌ | Add it | Low priority |
| 11 | **Agency model** — earnings auto-transfer to agency every Sunday midnight | ✅ | Keep & verify | Already in spec; confirm Cloud Function fires correctly |

---

## SECTION 9 — GIFTS

| # | HiClub Feature | Zipper Status | Decision | Notes |
|---|---|---|---|---|
| 1 | Gift catalog | ✅ | Keep | |
| 2 | **SVGA gift animations** (full animated overlays) | ❌ | **Add it** | Replace static icon with Lottie/SVGA |
| 3 | **Gift combo streak** (x2, x3 multiplier display) | ❌ | **Add it** | For lucky gifts — `anim_combo_particle.svga` |
| 4 | **Super Lucky gift** mechanic | ✅ | Keep | `super_lucky_win/big_win.svga` confirmed |
| 5 | **Wish gift** — host sets gem goal, progress bar | ❌ | **Add it** | `anim_wish_gift_progress_bar.svga` — very engaging |
| 6 | Gift ticker in room ("X won Y gems by sending [gift]") | ❌ | **Add it** | |
| 7 | Gift sent history — grid with value + quantity | ⚠️ | Improve it | HiClub's shows gem totals per gift type |
| 8 | Gift received shown on other user's profile | ❌ | **Add it** | |
| 9 | Lucky gift: 0×/1×/2×/5× return | ✅ | Keep | |

---

## SECTION 10 — CALLS (1:1)

| # | HiClub Feature | Zipper Status | Decision | Notes |
|---|---|---|---|---|
| 1 | Agora video call | ✅ | Keep | |
| 2 | Diamond billing per minute | ✅ | Keep | |
| 3 | **Private call animation** (top + bottom SVGA) | ❌ | **Add it** | `anim_private_call_top/bottom.svga` — visual polish |
| 4 | **Free teaser call** | ✅ | Keep | `live_room_free_call.svga` confirmed |
| 5 | **Incoming call from inside live room** | ❌ | **Add it** | `live_room_incoming_call.svga` |
| 6 | Auto-end on low balance | ✅ | Keep | |
| 7 | **Intimacy score** grows with calls | ❌ | Add it | `anim_intimacy_score_live.svga` |
| 8 | In-app incoming call overlay | ❌ CALL-13 | **Fix it** | Pending task |

---

## SECTION 11 — SOCIAL / RANKING

| # | HiClub Feature | Zipper Status | Decision | Notes |
|---|---|---|---|---|
| 1 | Follow/Unfollow | ✅ | Keep | |
| 2 | Block / Report | ✅ | Keep | |
| 3 | **Intimacy score** between two users | ❌ | Add it | Relationship level; drives repeat engagement |
| 4 | **Follower tasks** — tasks that earn rewards for following | ❌ | Add it | `tvFollowerTask` found in strings |
| 5 | **Global weekly ranking** (accessible from home) | ❌ | **Add it** | Trophy icon in HiClub nav |
| 6 | **"Pick Me" random host-picks-viewer** feature | ❌ | **Add it** | `anim_pick_me_result.svga` — drives viewer engagement |
| 7 | **Level upgrade celebration** | ❌ | **Add it** | `anim_user_level_upgrade_1/2.svga` |
| 8 | Beauty/filter settings | ✅ Snap Camera Kit | Keep | |

---

## SECTION 12 — ASSETS STRUCTURE

| Asset Folder | Size | Contents | Zipper Has? | Action |
|---|---|---|---|---|
| `assets/data/` | 55MB | Encrypted DEX files — app's protected source | — | — |
| `assets/model/` | 21MB | ML models (face detection, gender, age) | Snap Camera Kit covers this | — |
| `assets/effect/` | 17MB | AR face filters/effects (Faceunity) | Snap Camera Kit covers this | — |
| `assets/svga/` | 3.4MB | 31 SVGA animation files | ❌ None | Add all SVGA/Lottie animations |
| `assets/anim/` | 3.3MB | Lottie / other animations | ⚠️ Basic only | Make complete |
| `assets/emoji/` | 1MB | Custom emoji pack | ❌ | Add it |
| `assets/nim/` | 236KB | NetEase IM config | Using Firebase instead | — |
| `assets/fonts/` | 204KB | Custom fonts | ⚠️ | Complete it |

---

## SECTION 13 — PRIORITY BUILD LIST

### 🔴 HIGH PRIORITY (build now)

| # | Feature | Effort | Why |
|---|---|---|---|
| 1 | **PARTY badge** on home feed cards | Low | Drives party discovery |
| 2 | **Fix games from inside party room** | Low | Already broken, just needs wiring |
| 3 | **Scrolling gift ticker** in party + live ("X won Y gems") | Low | Biggest social proof feature; drives gifting |
| 4 | **Gift animations with Lottie/SVGA** (replace static icon) | Medium | Gifters need visual reward |
| 5 | **Wish gift / gem goal** — host sets target, progress bar | Medium | Huge gifting driver |
| 6 | **Incoming call overlay in-app** (CALL-13) | Medium | Core UX missing |
| 7 | **Gifts sent counter in party/live top bar** | Low | Social proof inside rooms |

### 🟡 MEDIUM PRIORITY (next sprint)

| # | Feature | Effort | Why |
|---|---|---|---|
| 8 | **Big entrance animation** by level (Lv3/4/5) | Medium | Top spenders love this; drives wealth leveling |
| 9 | **Anchor tasks** — daily host missions | Medium | Keeps hosts streaming regularly |
| 10 | **Avatar frames** by wealth level | Medium | Cosmetic revenue; visible on every card |
| 11 | **Gift combo streak** animation (×2, ×3) | Low | Makes rapid gifting exciting |
| 12 | **First recharge celebration** animation | Low | Memorable moment for new payers |
| 13 | **Level upgrade animation** | Low | Reward for reaching new levels |
| 14 | **Viewer popup** in live (tap viewer → Message + Gift) | Low | More gift touchpoints |
| 15 | **Animated party room backgrounds** | Medium | Visual quality |
| 16 | **Item expiry** in My Bag + time-limited items | Medium | Recurring cosmetic revenue |
| 17 | **PK countdown SVGA animations** (4 stages) | Low | Polish |

### 🟢 LOWER PRIORITY (build later)

| # | Feature | Effort | Why |
|---|---|---|---|
| 18 | Intimacy score (user relationship levels) | High | Engagement but complex data model |
| 19 | "Pick Me" — host randomly picks a viewer | Medium | Fun viral feature |
| 20 | Video call FROM inside live room | High | Premium but niche |
| 21 | Global weekly leaderboard (trophy nav icon) | Medium | Good after active user base exists |
| 22 | Follower task system | Medium | Drives follows |
| 23 | Match tab (random video speed-matching) | Very High | Big viral feature; build last |
| 24 | Monthly card subscription | Medium | Recurring revenue when user base is bigger |
| 25 | Custom emoji pack | Low | Polish |
| 26 | Entrance bubble (small entry effect) | Low | After big entrance is done |

---

## SECTION 14 — OPEN TASKS (pending from previous sessions)

| Task | Issue ID | Priority |
|------|----------|----------|
| Age range + gender filter → server query | HOME-08/09 | Medium |
| Incoming call overlay in MainActivity | CALL-13 | High |
| Viewer join messages in party chat | PARTY-07 | Medium |
| Auto-welcome message on live start | LIVE-10 | Low |
