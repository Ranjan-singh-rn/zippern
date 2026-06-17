# Zipper — Full App Specification (MASTER REFERENCE)

> Single source of truth. Do NOT override or auto-generate. Every screen, every rule.
> Last updated: June 2026 — fully corrected by product owner.

---

## Table of Contents
1. [App Concept](#1-app-concept)
2. [Login & Onboarding](#2-login--onboarding)
3. [Home Screen](#3-home-screen)
4. [Other User Profile](#4-other-user-profile)
5. [Live Tab](#5-live-tab)
6. [Live — Broadcaster View](#6-live--broadcaster-view)
7. [Live — Viewer View](#7-live--viewer-view)
8. [PK Battle](#8-pk-battle)
9. [Party Room — Owner View](#9-party-room--owner-view)
10. [Party Room — Guest View](#10-party-room--guest-view)
11. [Messages Tab](#11-messages-tab)
12. [Games Tab](#12-games-tab)
13. [Profile & Settings Tab](#13-profile--settings-tab)
14. [Diamond & Bean Economy](#14-diamond--bean-economy)
15. [Video Call Screen](#15-video-call-screen)
16. [Data Model Constraints](#16-data-model-constraints)

---

## 1. App Concept

Zipper is a live-streaming social app (Chamet/HiClub style).

Users can:
- Browse other users on Home
- 1-to-1 video call
- Watch or host live streams
- Join or own audio party rooms
- Play games using diamonds
- Gift other users (lucky gift mechanic)
- Chat via DMs

Primary revenue: in-app diamond purchases, game betting, gifting.

---

## 2. Login & Onboarding

### 2.1 Splash Screen
- Holds until Firebase auth bootstrap is complete.
- Then navigates to Gender Selection or Home (if already logged in).

### 2.2 Gender Selection Screen
- First screen after splash for new users.
- Three large tap cards: **Male** / **Female** / **Transgender**.
- Selection stored on user profile. Used in home feed and badge.

### 2.3 Login Options
1. **Google** — OAuth, pulls name + profile picture + birthday (→ age).
2. **Phone OTP** — number entry → OTP verification.
3. **Guest** — no credentials, auto-creates anonymous profile.

### 2.4 Device Capture (all login types)
- Capture device fingerprint (Android ID) on first login.
- Store against user record in Firestore.
- Guest users: next app open → look up device ID → auto-login same guest profile.
- Guest users can bind phone/email at any time in Settings → then no longer guest.

### 2.5 Profile Setup (Phone & Guest only — Google skips most fields)
Fields collected:
- Username (unique handle)
- Age (if not from Google birthday)
- Hobbies (multi-select tags)
- Likes (multi-select tags)
- Dislikes (multi-select tags)
- Preferred Languages (multi-select)

**Referral code** — shown for Google and Phone only. NOT for guest.

### 2.6 Face Verification (once, all users including guest)
- ML Kit face detection — confirms gender matches user's gender selection.
- On pass → `isVerified = true` → Verified badge shown throughout app.

### 2.7 Auto Location Capture (all users, all login types)
- Silently capture city, state, country via GPS/IP.
- **City** shown on profile card and other profile.
- State and country: internal only, never shown in UI.
- **City and gender are LOCKED after first set** — cannot be changed later.

### 2.8 After Onboarding
- Land on **Home Screen** (Tab 1).

---

## 3. Home Screen (Bottom Tab 1)

### 3.1 Layout
- 2-column grid, rectangular cards.
- Infinite scroll / paginated (batches of 20).
- Real-time updates — online dot, live badge update live.

### 3.2 Card Content
- Profile photo (or initial letter in colored circle if no photo)
- Name (truncated with `...` if too long)
- City + Age
- Level badge
- Verified badge (if `isVerified = true`)
- 🟢 Online green dot (real-time presence)
- 🔴 LIVE badge (if currently broadcasting)
- 🎉 PARTY badge (if seated in a party room)

### 3.3 Exclusions
- **Never show own profile card** in home feed.
- **Never show blocked users** (blocked by me OR I am blocked by them).

### 3.4 Search
- Search by **User ID** only (exact match).
- Own User ID never appears in search results.

### 3.5 Filters (combinable)
| Filter | Options |
|--------|---------|
| Country | India, Africa, Philippines, etc. |
| Language | Any of user's preferred languages |
| Hobbies | Tag multi-select |
| Likes | Tag multi-select |
| Dislikes | Tag multi-select |

### 3.6 Tap a Card
- Opens **Other User Profile** (full screen).

---

## 4. Other User Profile

### 4.1 Layout
- Cover photo + avatar
- Name (bold, large)
- Level badge (directly below name)
- User ID below level
- Gender + City (below ID)
- Verified badge if applicable
- Online / LIVE / PARTY status

### 4.2 What IS Visible
- Profile photo + cover photo
- Name, age, city, gender, User ID, level
- Verified badge
- Bio
- Gallery (photos)
- Personal info section: name, age, gender, city (no private fields)
- Hobbies, Likes, Dislikes
- **Gifts this person has SENT to others** (public gift summary, top items)
- **Gifts this person has RECEIVED from others** (public gift summary, top items)
- Online status / LIVE badge / PARTY badge

> **Implementation note**: Gift summaries must be stored as aggregated public fields on the
> user Firestore document (e.g. `publicGiftsSentSummary`, `publicGiftsReceivedSummary`)
> updated by the Cloud Function when gifts are processed — because Firestore rules block
> reading another user's `gift_transactions` collection directly.

### 4.3 What Is HIDDEN on Other Profile
- Email address
- Phone number
- Hours streamed
- Referral code
- Diamonds balance
- Call rate setting
- Beans balance

### 4.4 Stats Row
- **NOT shown** on other profile.
- Only Level shown, placed directly below name.

### 4.5 Action Buttons (4 buttons, always shown)
1. **Like / Unlike** — toggle.
2. **Message** — opens 1-to-1 DM screen.
3. **Video Call** — disabled if person is offline. Initiates 1-to-1 video call.
4. **Gift** — opens gift selection sheet → deducts diamonds → lucky gift mechanic.

**No audio call button at all.**

### 4.6 If Person Is Currently LIVE
- Floating draggable mini-card appears inside the profile screen.
- Shows real-time video feed (no audio).
- User can drag it to any corner.
- Tap it → navigate to **LiveViewerScreen** for that person.

### 4.7 If Person Is Seated in a Party Room
- Banner shown: *"[Name] is in a party — Join them"*.
- Only shown if person has an active seat (not just in lobby).
- Tap → navigate to that party room as guest.

### 4.8 3-Dot Menu
- **Report user** — opens reason-select sheet → submits to Firestore `reports` collection.

### 4.9 Loading
- Real-time Firestore snapshot listener on the profile.

---

## 5. Live Tab (Bottom Tab 2)

### 5.1 Two Sub-Tabs
- **All Lives** — grid of all active live streams (own stream excluded).
- **Party Rooms** — grid of all active party rooms (own room excluded).

### 5.2 Filters (both sub-tabs)
| Filter | Notes |
|--------|-------|
| Country | Same as home |
| Language | Multi-select |
| Hobbies | Multi-select |
| Likes | Multi-select |
| Dislikes | Multi-select |
| People I Like | Only lives/parties from users I liked |
| People Who Like Me | Only lives/parties from users who liked me |

### 5.3 Floating Action Button
- In **All Lives** sub-tab → button label: **Go Live**
- In **Party Rooms** sub-tab → button label: **Go Party**
- Button floats above the bottom navigation bar.

---

## 6. Live — Broadcaster (Host) View

### 6.1 Screen Layout (full screen, portrait)
- Camera preview fills entire screen (front camera only — no back camera).
- Overlays on top of camera.

### 6.2 TOP LEFT Area
- **Gift Target Box**: shows total diamonds received this live session (running total of all gifts).
- **👁 Eye + viewer count** — works as a button:
  - Tap → opens Viewers List bottom sheet.
  - Hides comment section and bottom button row while sheet is open.
  - Each viewer row: profile pic + name + level. Tap → shows their profile card with: Like/Unlike, Message, Kick Out, Block.
  - Closing the sheet → comment section and bottom buttons return.

### 6.3 TOP RIGHT Area
- **✕ End button** → End Live (shows confirmation dialog).

### 6.4 MIDDLE — Comment Section Overlay
- Scrollable list of chat comments overlaid on the camera feed (bottom half of screen).
- Semi-transparent background.
- Host sees ALL comments from the start of the live.
- When a viewer joins → auto-welcome message appears: *"Welcome to [Host Name]'s live! Say hi 👋"*

### 6.5 BOTTOM — Controls Row (left to right)
1. **Comment input** field + **Send** button
2. 🔗 **Share** → share live link to followers list + following list + recent chats
3. 📨 **Messages** → opens message inbox sheet with full messaging feature
4. 🎮 **Game** → opens game sheet:
   - Hides comment section + text input + bottom buttons
   - Game fills bottom half of screen
   - Game has its own **Close** button → restores comment + buttons
5. 🎤 **Mute** → mute/unmute own mic
6. ⚔️ **PK** → initiate PK battle
7. ⬛ **PiP** → float live into Picture-in-Picture window

### 6.6 No Gift Button for Host
- Host does NOT have a gift button. Gifts come from viewers only.

### 6.7 PIP Mode (host)
- ALL controls hidden.
- PiP overlay shows only two options:
  - **Return to Live**
  - **✕ End Live**

### 6.8 Back Button
- Back press during live = End Live (same as ✕ button — shows confirmation dialog).

### 6.9 End Live Confirmation
- Dialog: *"End your live session?"* → Confirm / Cancel.
- On Confirm: stop Agora stream, mark `live_streams/{uid}.isActive = false`, navigate out.

---

## 7. Live — Viewer View

### 7.1 Screen Layout (full screen, portrait)
- Host's video feed fills entire screen.

### 7.2 TOP LEFT Area
- Host name + level badge + **Like/Unlike** button

### 7.3 TOP RIGHT Area
- **👁 Eye button** → opens viewers list bottom sheet (shows all current viewers with Like/Unlike, Block, Message options)
- **✕ Leave button** → leave live (no confirmation needed for leave)

### 7.4 MIDDLE — Comment Section Overlay
- Viewer sees only comments posted **after they joined** (not history).
- Welcome message auto-shown on join: *"Welcome to [Host Name]'s live! Say hi 👋"*

### 7.5 BOTTOM — Controls Row (left to right)
1. **Comment input** field + **Send** button
2. 🎁 **Gift** → gift sheet → send gift to host → lucky gift mechanic
3. 🔗 **Share** → share live link
4. 📨 **Messages** → message inbox sheet
5. 🎮 **Game** → same as host: hides comment + buttons, game in bottom half, close to return
6. 🔇 **Speaker/Mute** → mutes incoming audio (viewer has no mic in live, mic is disabled)
7. ⬛ **PiP** → float live into PiP window

### 7.6 PIP Mode (viewer)
- ALL controls hidden.
- PiP overlay shows only:
  - **Return to Live**
  - **Leave Live**

### 7.7 Differences Summary (Host vs Viewer)
| Feature | Host | Viewer |
|---------|------|--------|
| Gift button | ❌ | ✅ (gifts to host) |
| PK button | ✅ | ❌ |
| End button | ✅ | ❌ (has Leave instead) |
| Kick out | ✅ | ❌ |
| Comments seen | All from start | Only from join time |
| Mic | Active | Disabled |
| Speaker mute | N/A | ✅ |

---

## 8. PK Battle

### 8.1 Initiation
- Host taps PK button → system finds another active live host who is opted in.
- Both hosts see: *"[Other Host] — Start Battle?"* with **Start Battle** button.
- Battle starts only when **both** press Start Battle.

### 8.2 During Battle — What's Visible
- **Top half of host's own live**: split screen — host on left, opponent on right.
- **Support bar**: blue (me) vs red (opponent) — updates in real-time from gift totals.
- **3-minute countdown timer**.
- Host can hear opponent's audio (Agora channels merged for host mics only).

### 8.3 What Is HIDDEN During PK
- Opponent's viewer list (neither side can see who is watching the other).
- Opponent's gift animations (viewers on one side don't see gifts going to the other side).
- Opponent's games or screen actions.
- Viewers only gift the host in whose live they are currently viewing (not the opponent).

### 8.4 Gift Support
- Viewers on MY side gift me → diamonds add to my support bar.
- Viewers on opponent's side gift opponent → adds to opponent's bar.
- Viewers can only see the bar total for each side, not who gifted what on the opponent's side.

### 8.5 End of PK
- Timer ends → winner = higher diamond total.
- Winner/Loser badges shown for 1 minute.
- After 1 minute: opponent video disappears, PK bar disappears, host's live returns to normal solo broadcast.

---

## 9. Party Room — Owner View

### 9.1 Create Party Room
Fields:
- **Room Name**
- **Welcome Message** (auto-posted in comment section when members join)
- **Seat Consent Type**: Free / Consent / Private
- **Seat Count**: 10 / 15 / 20

On subsequent "Go Party" sessions, all fields are **pre-filled** from the previous session. Owner only changes what they want to change.

### 9.2 Screen Layout
- **Background**: chosen static image (higher-level users/hosts unlock animated/Lottie backgrounds progressively by level).
- **Top left**: Room name.
- **Top right**: 👁 Members button | ✕ Close Party button.
- **Seats area**: mic icons in chosen count layout. Empty seats tappable.
- **Comment section**: below seats (semi-transparent overlay).

### 9.3 Members Button (Top Right, 👁)
- Opens joined users list bottom sheet.
- Hides comment section and bottom buttons while open.
- Each row: profile pic + name + level. Tap → profile card with Kick Out / Block / Message / Like-Unlike.
- Closing sheet → restores comment section and bottom buttons.

### 9.4 Seat Interaction (Owner)
- Tap **empty seat** → options: **Take Mic** (sit self) | **Lock Seat**
  - Locked seat: no one can sit there including owner. Lock persists.
- Tap **seat occupied by another user** → options: **Kick Out** | **Send to Lobby** | **Mute/Unmute**
  - Kick Out: removed from room for this session.
  - Send to Lobby: removed from seat but stays as listener.
  - Mute: silences that user. Persists if same user rejoins.

### 9.5 Control Buttons (Bottom Row)
| Button | Action |
|--------|--------|
| 🎤 Mute | Mute/unmute own mic |
| 🔇 Speaker | Mute all incoming audio |
| ⚙️ Settings | Opens party settings sheet (name, bg, seats, consent type) |
| ✅ Approvals | Bottom sheet: pending seat requests (Consent mode) + invite lobby users to seat |
| 🎮 Game | Game sheet — same as live: hides comment+buttons, game fills bottom, close to return |
| 🎁 Gift | Gift sheet: all seated users pre-selected, owner can deselect any, then Send |

### 9.6 Admin System
- Owner grants admin role to any member.
- Admin can: approve seat requests, invite users to seats, mute/kick others (NOT owner, NOT other admins).
- Owner revokes admin from Settings → Admin List.

### 9.7 Session Persistence (saved to Firestore, reloaded each session)
- Room name, welcome message, consent type, seat count
- Locked seat positions
- Muted user list
- Admin list

### 9.8 Party Never Ends
- Party room stays active until owner closes it (taps ✕).
- Owner can leave the room (go to lobby or exit app) — party **continues** with other seated users talking.
- When owner goes back to "Go Party", the room settings are pre-filled. Owner joins back in.
- **Only the owner pressing ✕ Close Party ends the party.**

---

## 10. Party Room — Guest View

### 10.1 Entry
- Guest enters as a **listener** (in lobby) first.
- Does **NOT** auto-sit on any seat.
- Free mode: tap empty seat → sit immediately.
- Consent mode: tap empty seat → sends request to owner/admin → wait for approval.
- Private mode: can only join via invite link. Once in the room, no further permission needed to sit — same as Consent rules apply after they're let in.

### 10.2 Leaving
- Tap **✕** button → confirmation dialog → leave party completely. Party continues without them.
- Tap **own occupied seat** → confirmation: *"Leave your seat?"* → leaves seat but stays in lobby as listener.

### 10.3 What Guest CAN Do
- Mute own mic
- Mute incoming speaker audio
- Gift seated users
- Play games

### 10.4 What Guest CANNOT Do
- Close the party room
- Change party settings (name, bg, seats, consent type)
- See admin list or member list
- Grant or revoke admin
- Kick/lobby/mute other users (admin-only)

---

## 11. Messages Tab (Bottom Tab 3)

- 1-to-1 real-time chat list
- Support/feedback messages from admin
- CRM announcements (system broadcasts)
- Standard chat UI: own messages right, other left. Real-time RTDB listener.

---

## 12. Games Tab (Bottom Tab 4)

- Full-screen WebView-based games.
- Users bet **diamonds** on games.
- Win → diamonds credited. Lose → diamonds deducted.
- Game transactions recorded as `GAME_BET` and `GAME_WIN` types.
- Available from:
  - Games Tab (standalone)
  - Inside live session (game button: comment section hides, game fills bottom half)
  - Inside party room (game button: full bottom sheet)

---

## 13. Profile & Settings Tab (Bottom Tab 5)

### 13.1 Own Profile Screen
Shows:
- Avatar + cover photo
- Name, level, city, bio
- Gallery photos
- Stats row: Like Me count | I Liked count | Diamond balance (shortened: 1k, 1L, 1Cr)
- Level badge
- Hobbies, Likes, Dislikes, Languages
- **Gifts Sent** (own sent history only — not visible on other profiles as live data)
- **Gifts Received** (own received history only)
- If HOST: **Call Rate** setting (shown as beans/minute — host can set their own call rate)

### 13.2 Locked Fields (cannot be changed after first set)
- City
- Gender
- Referral code

### 13.3 Editable Fields
- Username
- Profile photo
- Cover photo
- Age (if set via form, not from Google)
- Preferred Languages
- Hobbies, Likes, Dislikes
- Call Rate (HOST only)

### 13.4 Settings Menu Items
| Item | Notes |
|------|-------|
| Edit Profile | Edit own profile |
| I Like / Like Me | Two sub-tabs |
| Blocked Users | Manage blocked list |
| Daily Rewards | Claim streak rewards |
| My Bag | Avatar items, frames |
| Chat Style | Chat bubble/theme selector |
| Profile Card | Profile card skin selector |
| Entrance | Entry animation |
| Big Entrance | Premium entry animation (level-locked) |
| Language | Change app display language |
| My Level | Level progress + benefits |
| Streaming History | Past live sessions stats |
| Feedback & Support | Submit feedback or contact |
| Settings | Notifications, privacy, etc. |
| Diamonds / Bean Center | Wallet + bean/diamond screens |

---

## 14. Diamond & Bean Economy

### 14.1 Currencies
- **Diamonds** — purchased with real money by users. Spent on gifts, calls, games.
- **Beans** — earned by hosts and users from receiving gifts and calls. Paid out weekly to hosts.

### 14.2 Exchange Rates (fixed, public)
- ₹2,290 per 1,00,000 diamonds (what platform charges users to buy)
- ₹1,000 per 1,00,000 beans (what platform pays hosts on payout)

### 14.3 Internal Conversion (CONFIDENTIAL — never shown to users)
- 1 diamond spent → 2.5 gross beans generated internally.
- Maximum profit goes to company. The exact split rates for calls are set by the company and can be adjusted.

### 14.4 Gift Flow
1. Sender selects gift from gift sheet.
2. Diamonds deducted from sender.
3. Cloud Function `processGift` runs:
   - **Regular gift**: host gets **50% of gross beans** from the gift. Company keeps 50%.
   - **Lucky gift**: host gets **5% of gross beans** from the gift. Company keeps 95%.
   - Lucky gift return to SENDER (diamonds back): Cloud Function determines randomly: 0× / 1× / 2× / 5× the gift value back in diamonds.
4. Gift animation plays on screen.
5. Host's bean balance updated.

### 14.5 Weekly Host Payout Cycle
- Week: Monday 12:00 AM IST → Sunday 11:59 PM IST.
- At end of week (Sunday 11:59 PM IST):
  - Host's `weeklyBeansEarned` recorded to CRM profile / payout history.
  - `weeklyBeansEarned` resets to 0.
  - Host **level resets to 1**.
  - Bean balance resets to 0 (payout already sent).
- Cloud Function cron: `"59 18 * * 0"` (UTC = Sunday 11:59 PM IST).

### 14.6 Call Economy
- Video call costs caller **1500 diamonds per minute** (fixed).
- Earning rates based on gender:
  - Male → Female call: **female gets 50%** of the gross beans earned from that call.
  - Female → Male call: **male gets 30%** of the gross beans.
  - Same gender call: **receiver gets 40%** of the gross beans.
- **Host rule**: if either party is a host (regardless of who calls whom), beans are always credited to the HOST.
- Billing: 1 minute deducted at the START of each minute. Auto-end if caller has insufficient diamonds for the next minute.

### 14.7 Game Economy
- Game bets deduct diamonds from player.
- Game wins credit diamonds to player.
- Game losses deduct diamonds from player.
- Recorded as `GAME_BET` / `GAME_WIN` transaction types.

---

## 15. Video Call Screen

### 15.1 Who Can Call Whom
- **Anyone can call anyone** (no restriction on user type).
- Call disabled only if callee is currently offline.

### 15.2 Call Rate
- Fixed rate for regular users: **1500 diamonds/minute**.
- Host rate: shown as whatever the host has set (host can set their own rate in Profile settings). Company profit is added on top transparently.

### 15.3 Billing Logic
- At the start of each minute: 1 minute's worth of diamonds is deducted from the caller.
- Auto-end at 59s, 1m59s, 2m59s, 3m59s, etc. if caller has insufficient diamonds for the next minute.
- Caller cannot initiate a call if they have fewer diamonds than 1 minute's cost.

### 15.4 Caller Screen Layout
- **Top right**: Callee name
- **Top left**: Duration timer + Like/Unlike button
- **Bottom overlay** (in-call controls):
  - In-call chat overlay
  - Mute/Unmute own mic
  - Speaker selector (earpiece / loudspeaker / Bluetooth if connected)
  - Camera toggle (front/back)
  - 🎁 Gift button (caller only — opens gift sheet to send gifts to callee mid-call)
  - End call button

### 15.5 Receiver Screen Layout
- **Top right**: Caller name + Like/Unlike button
- **Bottom overlay** (in-call controls):
  - In-call chat overlay
  - Mute/Unmute own mic
  - Speaker selector (earpiece / loudspeaker / Bluetooth if connected)
  - Camera toggle (front/back)
  - End call button
  - **No gift button** (receiver cannot send gifts in call)

### 15.6 Auto-End Conditions
- Caller's diamonds drop below the next minute's cost → call ends automatically.
- Either party kills the app.

---

## 16. Data Model Constraints

### 16.1 User Fields (Firestore `users/{uid}`)
```
id (uid)
username
name
email (nullable, private)
phone (nullable, private)
gender (locked after first set: MALE / FEMALE / TRANSGENDER)
city (locked after first set)
state (internal only)
country (internal only)
age
profilePicUrl
coverPicUrl
isVerified
isOnline
isLive
isInParty
partyRoomId (if seated)
level
diamonds
beans
weeklyBeansEarned
hobbies []
likes []
dislikes []
languages []
referralCode (locked after first set)
referredBy
deviceId (for guest login)
isGuest
isBound (phone/email bound for guest)
callRate (host only, diamonds/minute)
isHost
createdAt

// Public gift summaries (updated by Cloud Function on each gift)
publicGiftsSentSummary   [{ giftName, giftImageUrl, count }]  ← visible on other profiles
publicGiftsReceivedSummary [{ giftName, giftImageUrl, count }]  ← visible on other profiles
```

### 16.2 Live Stream Fields (Firestore `live_streams/{hostId}`)
```
hostId (= uid)
isActive
title
viewerCount
viewerIds []
startedAt
channelId (Agora)
sessionDiamondTotal (running total of gifts this session)
```

### 16.3 Party Room Fields (Firestore `party_rooms/{ownerId}`)
```
ownerId
roomName
welcomeMessage
consentType (FREE / CONSENT / PRIVATE)
seatCount (10 / 15 / 20)
isActive
seats [] → { seatIndex, userId, isMuted, isLocked }
admins [] → userIds
kickedUsers [] → userIds (session-level)
mutedUsers [] → userIds (persistent across sessions)
backgroundId
```

### 16.4 Transaction Fields (Firestore `transactions/{id}`)
```
id
userId
type (GIFT_SEND / GIFT_RECEIVE / CALL_CHARGE / CALL_EARN / RECHARGE / BEANS_CONVERT / GAME_BET / GAME_WIN)
diamonds (Long, negative for debits)
beans (Long, negative for debits)
refId
counterpartId
counterpartName
note
timestamp
```

---

## 17. Known Gaps vs Current Code (as of June 2026)

| # | Feature | Status | What Needs Fixing |
|---|---------|--------|-------------------|
| 1 | Transgender gender option | ❌ Missing | Add to gender selection screen and profile |
| 2 | Gift summaries on other profiles | ❌ Missing | Add `publicGiftsSentSummary` + `publicGiftsReceivedSummary` fields to user doc; update Cloud Function `processGift` to write them; display on UserProfileScreen |
| 3 | Host live control layout (top-left target box + eye button) | ❌ Wrong | Redesign LiveBroadcastScreen layout per §6.2–6.5 |
| 4 | Viewer live control layout | ❌ Wrong | Redesign LiveViewerScreen layout per §7.2–7.5 |
| 5 | Game button inside live (collapses comment + buttons) | ⚠️ Partial | Wire game sheet toggle in both LiveBroadcastScreen and LiveViewerScreen |
| 6 | Share + Messages buttons inside live | ❌ Missing | Add to both host and viewer live bottom rows |
| 7 | PK: opponent side information hidden from viewers | ❌ Not verified | Ensure viewer only sees their host stream + bar, not opponent's viewer list or gifts |
| 8 | Party room: owner can leave and return (party never ends) | ❌ Wrong | Remove auto-end on owner exit; party ends only on owner ✕ |
| 9 | Party pre-filled on repeat "Go Party" | ❌ Missing | Load last room settings into CreatePartyRoom form |
| 10 | Guest enters party as listener (no auto-seat) | ❌ Bug reported | Fix AudioPartyStageLayout — guest starts in lobby |
| 11 | Guest: tap own seat = leave seat, stay in lobby | ❌ Missing | Add confirmation on own-seat tap |
| 12 | Games Tab: real WebView URLs | ❌ Missing | Plug in real game provider URLs |
| 13 | Caller: diamond timer / auto-end on insufficient diamonds | ⚠️ Partial | Verify billCall Cloud Function handles this correctly |
| 14 | Call screen: in-call chat overlay | ❌ Missing | Add in-call text chat to VideoCallScreen |
| 15 | Call screen: speaker selector (earpiece/loudspeaker/Bluetooth) | ❌ Missing | Add AudioManager routing to VideoCallScreen |
| 16 | Receiver has no gift button in call | ✅ Correct | — |
| 17 | Host call rate setting in profile | ⚠️ Partial | Expose host rate field in EditProfileScreen; use it in billing |
| 18 | Weekly host level + bean reset | ✅ Cloud Function exists | Verify cron fires correctly |
| 19 | Stats numbers shortened (1k, 1L) | ❌ Missing | Format diamond/bean/like counts with K/L suffix |
| 20 | Agora token real implementation | ❌ Missing | `agora-access-token` npm package + env vars in Cloud Functions |
| 21 | Lottie gift animations | ❌ Missing | Real Lottie URLs needed in Firestore gift catalog |
| 22 | Cosmetics applied visually in live/party | ❌ Missing | Render avatar frame etc. in live/party screens |

---

*This document is the single source of truth for the Zipper app.*
*All code changes must reference this document. Do not implement features not listed here.*
