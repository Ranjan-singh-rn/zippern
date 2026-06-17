# ZIPPER — Full App Roadmap
> Living document. Each phase builds on the last. Go one by one.
> Status key: ✅ Done | 🔄 In Progress | ⏳ Pending

---

## PHASE 0 — FOUNDATION (Already Done ✅)

Everything completed across previous sessions.

| # | Feature | Status |
|---|---|---|
| 1 | Auth: Phone OTP, Google Sign-In, Guest login | ✅ |
| 2 | Face verification (ML Kit) | ✅ |
| 3 | Home discovery feed — grid, cards, search, tabs | ✅ |
| 4 | User profile screen (other user) — full sections | ✅ |
| 5 | My profile + edit profile | ✅ |
| 6 | Live streaming — host + viewer (Agora) | ✅ |
| 7 | PK Battle — full flow | ✅ |
| 8 | Party Room — host + guest basics | ✅ |
| 9 | Video/Audio calls (Agora, billing, auto-end) | ✅ |
| 10 | Messages / DM chat | ✅ |
| 11 | Games Center — WebView architecture ready | ✅ |
| 12 | Diamond shop + transaction history | ✅ |
| 13 | Gift system — catalog, send, lucky gift | ✅ |
| 14 | Bean economy — earnings, payout via WhatsApp | ✅ |
| 15 | PiP mode (live + calls) | ✅ |
| 16 | FCM notifications (calls, messages, live, party) | ✅ |
| 17 | Settings — blocked users, feedback, rewards, my bag | ✅ |
| 18 | Games ranking + history tabs | ✅ |

---

## PHASE 1 — CORE FIXES (Current Sprint)

Finish the open bugs and small wires before building new features.

| # | Task | Issue ID | Status |
|---|---|---|---|
| 1 | Age range + gender filter wired to Firestore query | HOME-08/09 | 🔄 In Progress |
| 2 | Incoming call overlay in MainActivity (in-app UI) | CALL-13 | ⏳ |
| 3 | Viewer join messages in party chat | PARTY-07 | ⏳ |
| 4 | Auto-welcome message when host starts live | LIVE-10 | ⏳ |
| 5 | Party room — guest enters as listener, not auto-seated | BUG | ⏳ |
| 6 | Fix games button inside party room (broken wire) | GAME | ⏳ |
| 7 | PARTY badge on home feed cards | HOME | ⏳ |

**Exit criteria:** App works end-to-end with no broken flows. All pending tasks cleared.

---

## PHASE 2 — GIFT SYSTEM UPGRADE

The gift system is the primary revenue driver. Make it visually powerful.

| # | Feature | Notes |
|---|---|---|
| 1 | **SVGA/Lottie gift animations** — replace static icon | Add SVGA library; each gift has its own animation file |
| 2 | **Gift combo/streak** animation (×2, ×3 rapid gifting) | `anim_combo_particle` — fires when viewer sends multiple gifts fast |
| 3 | **Super Lucky gift SVGA** — full-screen win animation | `super_lucky_big_win.svga` — already have the logic, add the visual |
| 4 | **Scrolling gift ticker** inside live + party room | Banner at top: "BADAL won 65000 💎 by sending Rocket" |
| 5 | **Gifts sent counter in top bar** of party/live room | Shows running total of gems sent this session |
| 6 | **Gift received section** on other user's profile | Show what gifts they've received publicly |
| 7 | **Gift sent history** improvement | Rich grid with gem value × quantity per gift type |
| 8 | **Wish Gift** — host sets gem goal, progress bar fills | `anim_wish_gift_progress_bar.svga`; viewers see progress; host celebrates on reach |

**Exit criteria:** Sending a gift feels rewarding visually. Wish Gift drives sustained gifting sessions.

---

## PHASE 3 — LIVE ROOM UPGRADES

Make the live room feel premium and competitive.

| # | Feature | Notes |
|---|---|---|
| 1 | **Agora Clear Vision Extension** — auto video quality boost | Enable the extension already in Agora SDK |
| 2 | **Stream ended animation** for viewers | `anim_watch_live_finished.svga` shown when host ends stream |
| 3 | **Viewer popup** — tap viewer in list → card with Message + Gift | Bottom sheet with viewer's avatar, level, gems sent + 2 action buttons |
| 4 | **TOP1/TOP2 gifter badge** in viewer list | Show badge next to top 2 gifters; resets hourly |
| 5 | **Incoming call overlay inside live room** | Host gets call while live → overlay with accept/decline; `live_room_incoming_call.svga` |
| 6 | **Video call from inside live room** | Host invites a viewer to 1:1 video mid-stream; `anim_room_video_call.svga` |
| 7 | **Free call mode** for hosts | Host can toggle "free calls" on; viewers can call for free during this window |
| 8 | **First recharge celebration** | When a user recharges for the first time, show full-screen SVGA celebration in live room |
| 9 | **PK countdown SVGA** — 4 stages | Replace existing countdown with `anim_pk_room_countdown/match/matching/start.svga` |

**Exit criteria:** Live room feels engaging and reactive. Viewers have reasons to stay and interact beyond just watching.

---

## PHASE 4 — PARTY ROOM UPGRADES

Make party rooms feel alive and customisable.

| # | Feature | Notes |
|---|---|---|
| 1 | **Animated party room backgrounds** | Backgrounds unlocked by host level; castle, nature, luxury scenes |
| 2 | **Room mic mode label** in chat | Show "Room mic mode: Free / Consent" as system message on join |
| 3 | **Viewer list with 3 tabs** — Recent Chats / Follower / Member | Same as HiClub; tabs filter who is shown |
| 4 | **Share button on each viewer** in viewer list | Invite that viewer to this room via share sheet |
| 5 | **Follower task system** | Tasks like "Follow 5 people in this room → earn 100 gems" |
| 6 | **Gifts sent counter** in party top bar | |

**Exit criteria:** Party rooms feel customised and social. Hosts have reasons to personalise their rooms.

---

## PHASE 5 — COSMETICS / MY BAG

Build the full cosmetics economy — this is recurring revenue.

| # | Feature | Notes |
|---|---|---|
| 1 | **Avatar frames** — animated borders on profile photo | Unlocked by wealth level (how much you've spent total); visible everywhere |
| 2 | **Entrance bubble** — small animation when user enters a room | Small but visible; first cosmetic tier |
| 3 | **Big entrance** — grand vehicle/effect for high spenders | Level 3/4/5 big entrance SVGAs; VIP feel |
| 4 | **Chat style** — custom message bubble style in chats | Changes appearance of your messages in DMs and live chat |
| 5 | **Profile card** — custom card shown when others tap your profile | Different layouts/designs |
| 6 | **Item expiry system** — items have expiry (7 days, 30 days, Eternal) | Time-limited items sold cheaper; drives re-purchase |
| 7 | **Wealth level system** — total gems spent unlocks tiers | Wealth Lv1→Lv15; each level unlocks new frames/entrances |
| 8 | **Level upgrade celebration** animation | `anim_user_level_upgrade_1/2.svga` — shown when user hits new wealth level |

**Exit criteria:** Users can visibly show off their spending. Top spenders are immediately recognisable in any room.

---

## PHASE 6 — ENGAGEMENT LOOPS

Daily/weekly systems that keep users coming back.

| # | Feature | Notes |
|---|---|---|
| 1 | **Anchor tasks** — daily host missions | e.g. "Stream for 2 hours today → earn 500 gems"; shown in host dashboard |
| 2 | **Daily Claim** button in Games | Free gems from daily task completion |
| 3 | **Reward system** upgrade — task-based free gems | Replace placeholder with real tasks: follow someone, send a gift, watch a live → earn gems |
| 4 | **Intimacy score** between two users | Grows with calls, gifts, time spent together; shown on profile; unlocks special interactions |
| 5 | **Follower tasks** | Tasks for viewers that reward following hosts |
| 6 | **"Boost Gems Today" event header** in diamond shop | Time-limited bonus: buy gems this weekend, get 20% extra |
| 7 | **Weekly Sunday agency payout** — verify Cloud Function | Confirm the cron fires correctly; add admin visibility |
| 8 | **Update checker** in Me tab | Check Play Store version vs installed; prompt update if behind |

**Exit criteria:** Users have daily reasons to open the app. Hosts have daily reasons to stream.

---

## PHASE 7 — RANKING & SOCIAL PROOF

Show who the top players are. Competition drives spending.

| # | Feature | Notes |
|---|---|---|
| 1 | **Global weekly ranking** — trophy icon in home nav | Top gifters / top hosts / top earners this week; resets Sunday midnight |
| 2 | **Hourly ranking inside live + party rooms** | Room / Send Gift tabs; This Hour / Last Hour; podium #1/#2/#3 |
| 3 | **"Pick Me" feature** | Host randomly picks one viewer from the audience; picked viewer gets highlighted |
| 4 | **Level upgrade celebration** visible to room | When a user hits a new wealth level inside a room, the room sees the animation |
| 5 | **Game rank settlement animation** | `anim_game_rank_settle.svga` — shown when game session ends and ranks are tallied |

**Exit criteria:** Viewers compete to gift. Top gifters are celebrated publicly.

---

## PHASE 8 — PAYMENTS & MONETISATION

Full in-app payment flow (when ready to go live).

| # | Feature | Notes |
|---|---|---|
| 1 | **Razorpay integration** — UPI, Paytm, cards, net banking | Currently offline coin sellers only; flip when ready |
| 2 | **6 gem tiers** at correct price | ₹2,290 = 1 lakh diamonds; align all 6 tiers from this base |
| 3 | **Payment details screen** for hosts | Bank account / UPI ID entry for payout; stored securely |
| 4 | **"We'll credit it back in 3 days"** failed payment message | UX trust signal |
| 5 | **Monthly card subscription** | e.g. ₹499/month → 5,000 gems daily for 30 days |
| 6 | **KYC verification** for high-value top-ups | Required for RBI compliance above threshold |
| 7 | **GIF decoder** — enable GIF gifts | Add GIF animation decoder library |
| 8 | **AVIF image format** support | Smaller profile photos / gift images |

**Exit criteria:** Users can pay in-app. Hosts can receive payouts to their bank account.

---

## PHASE 9 — MATCH TAB (Big Feature)

Random video speed-matching — the viral user acquisition feature.

| # | Feature | Notes |
|---|---|---|
| 1 | Match tab in bottom nav | |
| 2 | Random match queue — pair two users for 60-second video chat | Agora channel created on the fly |
| 3 | Like/Skip controls during match | |
| 4 | If both like → opens DM conversation | |
| 5 | Diamond cost per match (optional) | Revenue from matching |
| 6 | Gender/age filter for match preference | |
| 7 | Safety — report during match | |

**Exit criteria:** Users can discover new people via random matching. Strong viral growth loop.

---

## PHASE 10 — POLISH & PRODUCTION HARDENING

Before public launch.

| # | Feature | Notes |
|---|---|---|
| 1 | **Agora soundtouch** — voice pitch effects for hosts | Fun filters (chipmunk, deep voice) |
| 2 | **MMKV** — replace SharedPreferences for speed | Faster app startup and state reads |
| 3 | **OOM monitoring** — check for free package (KOOM alternative) | Prevent crashes on low-end devices |
| 4 | **Anti-tamper / obfuscation** — check free tools (ProGuard R8 + DexGuard free tier) | Protect revenue logic |
| 5 | **Custom fonts** — complete font set | |
| 6 | **Custom emoji pack** | |
| 7 | **K/L/Cr number formatting** on all stats (1K, 1L, 1Cr) | |
| 8 | **Stat numbers** — diamonds/beans formatted everywhere | |
| 9 | **Agora tokens** from server — replace null | Security for live channels |
| 10 | **Rate limiting** on gifts + calls | Prevent abuse |
| 11 | **Admin panel** — basic web dashboard for moderation | Ban users, manage gifts, see revenue |
| 12 | **App version check** — force update on critical releases | |

**Exit criteria:** App is stable, secure, and ready for real users.

---

## SUMMARY — PHASE ORDER

| Phase | Theme | Approx Items |
|---|---|---|
| **0** | Foundation | ✅ Done |
| **1** | Core fixes + bugs | 7 items |
| **2** | Gift system upgrade | 8 items |
| **3** | Live room upgrades | 9 items |
| **4** | Party room upgrades | 6 items |
| **5** | Cosmetics / My Bag | 8 items |
| **6** | Engagement loops | 8 items |
| **7** | Ranking & social proof | 5 items |
| **8** | Payments & monetisation | 8 items |
| **9** | Match tab | 7 items |
| **10** | Polish & production hardening | 12 items |

**Total remaining work: ~78 items across 10 phases.**

Start with Phase 1. Tell me which item to begin with.
