I have the full picture. Here is the report.

---

# ZIPPER ANDROID APP — WHAT A PERSON ACTUALLY EXPERIENCES

All paths relative to `/Users/soumyaranjansingh/Documents/Projects/zippern/zipper-app/app/src/main/java/com/zipper/app/`

---

## 1. INSTALL & FIRST LAUNCH

**The splash screen** (`ui/screens/auth/SplashScreen.kt`) shows the Zipper mark, the wordmark, and the tagline "LIVE. CONNECT. SHINE." with a thin progress ring (`SplashScreen.kt:305-311`). It holds for a scripted ~800ms before deciding anything (`SplashScreen.kt:74-75`).

**What it checks, in this exact order:**

1. **Is this handset barred?** It reads the Android device ID against a `bannedDevices` document (`SplashScreen.kt:78-94`). If present, the person goes to a "This device is blocked" screen and never sees a login form. If the lookup errors (no network, rules not deployed), the app treats it as "not banned" and continues (`SplashScreen.kt:95-99`).
2. **Is anyone signed in?** If not → Login. Notably it does **not** auto-sign-in even when a quick-login secret exists on the device; that secret only earns a button on the Login screen (`SplashScreen.kt:128-132`).
3. **Is the stored credential still good?** It reloads the Firebase user. On failure it raises a "Your session has expired. Please sign in again." notice, tears the session down, and lands on Login (`SplashScreen.kt:134-153`, message at `ui/screens/auth/SessionViewModel.kt:108`).
4. **Does a user record exist?** If not → Profile Setup (`SplashScreen.kt:158-161`).
5. **Banned or suspended?** A banned account goes to the Banned screen; a suspended one goes to a separate Suspended screen carrying the end date. Critically, **the person stays signed in** in both cases, because the appeal form on those screens writes a record about the signed-in account (`SplashScreen.kt:199-220`).
6. **Deletion pending?** → Recover Account screen (`SplashScreen.kt:232-235`).
7. **Has another phone taken the session?** If the server-side session ID differs from the local one, the person is told which device took it ("You were signed out because your account was opened on a Motorola…") and signed out (`SplashScreen.kt:247-274`, wording at `SessionViewModel.kt:126-129`).
8. **Is the profile complete?** `isProfileComplete` false → Profile Setup; otherwise → Main (`SplashScreen.kt:281-282`).

**Where a fresh install lands:** Login. Every path above either fails fast or has no stored credential.

**There is no maintenance-mode gate anywhere in the app.** A repo-wide search for "maintenance" in the Android source returns nothing.

**Version / force-update is not on the splash at all.** It runs as a dialog layered over the whole app, deliberately waiting until the splash has finished deciding (`MainActivity.kt:487-490`). It reads `appConfig/androidUpdate` (`data/repository/UpdateRepository.kt:271`). An update is forced when the config says `mandatory` or when the installed build is below `minSupportedVersionCode` (`UpdateRepository.kt:297-302`). A forced update shows "This version can no longer be used. Install the update to carry on." with no Later or Not now button (`ui/screens/update/UpdateDialog.kt:137-139, 190`).

**Runtime permissions — what is asked, and when:**

| Permission | Asked where | Trigger |
|---|---|---|
| Notifications (Android 13+) | On arriving at the Main shell | Automatic, every time the Home route is reached (`MainActivity.kt:386-388`) |
| Full-screen intent (Android 14+) | Main shell | Sent to a system settings page, once ever, tracked in prefs (`MainActivity.kt:391-400`) |
| Coarse location | Profile Setup | Only when the person taps the "detect location" button next to Area/City (`ui/screens/auth/ProfileSetupScreen.kt:316-326`) |
| Camera | Face Verification | On entering the screen (`ui/screens/auth/FaceVerificationScreen.kt:96-101`) |
| Camera + Microphone | Go Live | A rationale screen ("Camera and microphone … Nothing is recorded by Zipper.") blocks the screen until granted (`ui/screens/live/GoLiveScreen.kt:96-98, 368-372`) |
| Microphone (+ Camera for video rooms) | Party Room | On entering a room (`ui/screens/party/PartyRoomScreen.kt:213-223`) |

Nothing is requested at install time. Screenshots and screen recording are blocked in release builds (`MainActivity.kt:155-160`).

---

## 2. AUTHENTICATION

**LoginScreen** (`ui/screens/auth/LoginScreen.kt`) offers exactly four ways in:

1. **Phone + OTP.** A country-code picker (defaults to +91, searchable list of all countries), a phone field, and a **"Get OTP"** button (`LoginScreen.kt:485-490, 794-827`). The button is disabled until the number is at least 5 digits **and** the terms checkbox is ticked. The OTP step is a slide-in stage on the same screen, not a separate destination — six code boxes, a **"Verify"** button, **"Change number"**, and a 45-second resend countdown ("Resend OTP in 45s") (`LoginScreen.kt:508-535`). SMS auto-fill submits the code without a tap (`LoginScreen.kt:235`).
2. **"Continue with Google"** via Credential Manager (`LoginScreen.kt:501, 196-211`).
3. **"Continue as Guest"** (`LoginScreen.kt:502`).
4. **"Continue as <name>"** — the quick-login card, described below.

**There is no email/password sign-in.** No password field exists anywhere in the app.

**Gating on the form:** a checkbox "I agree to the Terms & Conditions" with "By continuing you confirm you're 18+" beneath it (`LoginScreen.kt:475-479`). Google and Guest are both disabled until it is ticked (`LoginScreen.kt:501-502`). The installed version number is printed under the tagline (`LoginScreen.kt:395-399`).

**Every one of the three entry methods re-checks the device ban before doing anything** (`ui/screens/auth/AuthViewModel.kt:141-154, 207-220, 242-255`).

**Quick-login / Block Store, from the user's side.** After any normal sign-out, a gradient card appears at the top of the Login screen with the person's avatar, "Continue as <name>", and the subtitle "Signed in on this device before", followed by a divider reading "Use a different account" (`LoginScreen.kt:651-732`). One tap signs them straight back in — no SMS, no Google picker. The secret is minted on sign-out while the credential is still valid (`data/repository/AuthRepository.kt:2451-2457`), stored in Google Block Store with a local fallback (`util/QuickLoginStore.kt:85-129`). The design comment is explicit that this is a button and not an automatic entry, because a phone left on a desk would otherwise open into a stranger's wallet (`SplashScreen.kt:102-127`).

**RecoverAccountScreen** (`ui/screens/auth/RecoverAccountScreen.kt`) solves: *you asked us to delete this account and then signed back in during the 30-day window.* It says "Welcome back", names the deletion date and days remaining, and offers three choices: **"Keep my account"** (profile, coins, level, gifts and messages come back exactly as they were), **"Create a new account instead"** (start from zero; the old balances stay with the old account), and **"Delete it for good"** (finish it today) (`RecoverAccountScreen.kt:162-247`). The last two open a confirmation dialog warning there is no undo (`RecoverAccountScreen.kt:260-315`).

**SecureAccountScreen** (`ui/screens/auth/SecureAccountScreen.kt`) solves: *you are a guest, so the account lives only on this phone.* It attaches a **phone number** to the already-signed-in account via SMS code — "Send code", then "Add this number" (`SecureAccountScreen.kt:225-297`). If the number already belongs to another Zipper account, the person sees "That number is already taken" and is told plainly that nothing was merged or changed (`SecureAccountScreen.kt:351-357`).

**SecureEmailScreen** (`ui/screens/auth/SecureEmailScreen.kt`) does the same with **email**, by a mailed sign-in link rather than a code: "Send me a link", then "Check your email … Open it on this phone" (`SecureEmailScreen.kt:226-302`). The link comes back into the app through an Android App Link and is consumed by the Activity (`MainActivity.kt:99-110`).

> **Contradictory:** the email screen's pitch is `"can sign back into it, with your diamonds and your history, from"` anywhere (`SecureEmailScreen.kt:235`) — but the Login screen has no email sign-in method at all. The screen's own success copy is narrower and honest: email is "how support can find the account" (`SecureEmailScreen.kt:488-490`).

**On a new device.** Nothing is remembered, so the person signs in with phone OTP or Google and arrives at their existing account. Guests are the exception and cannot: a guest account is bound to one device secret, and a second installation that cannot prove ownership gets "This device already has a guest account, but this installation can't prove it owns it" (`AuthRepository.kt:1608-1613`). Signing in on a new device also displaces the old one — the app enforces one live mobile session per account, and the previously-signed-in handset is kicked with a named reason (`MainActivity.kt:213-266`).

**Logout.** Reachable from two places: a "Log out" tile on the Me tab (`ui/screens/profile/MyProfileScreen.kt:252`) and a row in Settings (`ui/screens/settings/SettingsScreen.kt:272`). Both confirm with "Log out?" / "Your balances stay on your account." (`SettingsScreen.kt:318-321`). The sign-out mints a quick-login secret, drops the push token, clears the local session, and signs out of Firebase (`AuthRepository.kt:2451-2457`).

A second, stronger option sits in the danger zone: **"Sign out and forget this device"** — "For a shared phone. Removes quick sign-in for this account" — which revokes the quick-login token server-side so nobody can tap straight back in (`SettingsScreen.kt:306, 327-347`; `AuthRepository.kt:2471-2484`).

> **Observation, not a judgement:** ordinary logout does not call `endMobileSession`. The server-side session record is not closed on the way out; only the local copy is cleared (`AuthRepository.kt:2451-2457`).

---

## 3. ONBOARDING — PROFILE SETUP

**ProfileSetupScreen** (`ui/screens/auth/ProfileSetupScreen.kt`) is titled "Set Up Profile" / "Tell us who you are" (`:529-530`).

**The fields, top to bottom:**

| Field | Required? | Notes |
|---|---|---|
| Profile photo | No | A default avatar is pre-picked — "We picked this one for you" — with a "Shuffle" chip, or tap the circle to choose your own (`:548-612`). Google sign-in pre-fills the Google photo. |
| **Display Name** | **Yes** | Pre-filled from Google. For guests, auto-filled with a random name like "Guest xkqp" (`:615, 897-901`) |
| About Me | No | 150-character limit with a live counter (`:618-628`) |
| **Languages** | **Yes** (≥1) | Pre-seeded from the device locale plus English (`:362-375, 631-635`) |
| **Gender** | **Yes** | Three pills: Male / Female / Transgender. Captioned "Set once — it decides your call pricing and can't be changed later." (`:639-658`) |
| **Date of Birth** | **Yes** | Date picker; under 18 is refused with "You must be 18 or older to use Zipper" and the value is not stored (`:271-314, 662-670`) |
| **Area / City** | **Yes** | Free text, or a gradient button that uses coarse location and reverse-geocodes via OpenStreetMap Nominatim (`:674-695, 996-1027`) |
| Email / Phone | Conditionally **yes** | Only shown when the server says this account needs them, with a reason like "Hosts need an email address so we can reach you about your payouts." (`:712-737, 926-944`) |
| Referral code | No | Labelled "Referral code (hosts only, optional)". Hidden entirely for guests (`:741-778`) |

The **"Let's Go!"** button stays disabled until name, gender, DOB (valid age), city and at least one language are present (`:437-441, 780-787`).

**Country is never chosen by the person.** It is taken from the device locale and silently overwritten if location detection succeeds (`:107, 334-337, 486`).

**What happens if abandoned halfway.** Pressing Back (hardware or the arrow) raises a dialog titled **"Leave and delete this account?"**: "Signing in already created an account. Going back removes it — the login itself, not just this form". Buttons: "Delete and go back" (destructive) and "Keep setting up" (`:254-256, 861-884`). Confirming genuinely deletes the auth user and the half-written document (`AuthRepository.kt:2501-2560`), then returns to Login. There is no save-and-resume.

**What the choices affect later.** Gender drives call pricing on both sides and is locked afterwards (shown read-only on Edit Profile with "Gender is set once. Contact support to change your phone or email." — `ui/screens/profile/EditProfileScreen.kt:248-252`); the earner's share is 50% when the host is female, 40% male, 30% otherwise, and 30% when both parties are the same gender (`util/EconomyEngine.kt:260-280`). Country and language become discovery filters on Home (`data/repository/DiscoverRepository.kt:64-69`). Date of birth is shown as Age on the public profile.

**A valid referral code changes the destination.** Instead of going to Home, the person is told "Valid code — joining <Agency>. You'll be registered as a host." and is routed to Face Verification after saving (`:771-774`; `ui/screens/auth/AuthViewModel.kt:319-371`). An unrecognised code yields "Code not recognised — you'll join as a regular user" and does not block anything (`:775`). If agency activation fails after the profile saved, a dialog "Couldn't join the agency" offers "Try again" or "Continue as user" (`:808-831`).

---

## 4. NAVIGATION — MAIN SCREEN

**Five bottom tabs**, labelled and in this order (`ui/screens/main/MainScreen.kt:56-62`):

1. **Home** — the discovery grid, plus a Party Rooms entry strip
2. **Live** — the live-room browser and the Go Live button
3. **Games**
4. **Messages** — three sub-tabs
5. **Me** — the account hub

Selecting a tab resets the stack to that tab with saved state (`MainScreen.kt:106-119`); the bar is a 64dp row with pill-highlighted icons and text labels (`MainScreen.kt:183-221`).

> **Half-built:** the Games tab renders a placeholder. The decisive line is `composable("tab_games") { PlaceholderScreen("Games — Phase 9") }` (`MainScreen.kt:144`). Nothing else in the app implements games, yet the Terms of Service carry a whole section promising them (`ui/screens/auth/TermsScreen.kt:54-55`) and the Level screen counts "Lucky Gifts & Games" toward progress (`ui/screens/level/LevelScreen.kt:254`).

Everything else is pushed on top of the shell from the outer graph (`navigation/ZipperNavGraph.kt:354-384`): Edit Profile, Settings, Diamond Shop, Beans Centre, own Profile, other users' profiles, Go Live, Watch Live, Party Rooms, My Bag, Earnings, Call History, Likes, Level, Daily Rewards, Incoming Call, Chat, Agency Dashboard, Seller Dashboard, Feedback, Face Verification, Join Agency.

An incoming call rings over whatever screen is open once the app is running (`MainActivity.kt:405-414`).

---

## 5. HOME & DISCOVERY

**HomeScreen** (`ui/screens/home/HomeScreen.kt`) is a two-column grid of people. The top bar shows "Zipper", the person's diamond balance as a tappable pill (goes to the Diamond Shop), a filter icon with a dot when filters are active, and a search icon (`:245-289`). Under it sits a **"Party Rooms"** strip: "Audio and video rooms you can join and take a seat in" (`:198-225`).

**Data source:** the `publicProfiles` collection, filtered to `isListed == true`, ordered by `presenceRank` then `lastSeen`, paged 20 at a time with infinite scroll (`data/repository/DiscoverRepository.kt:58-93`; `ui/screens/home/HomeViewModel.kt:93, 126-132`). It is a live listener, so cards update as people come and go. The person's own card and anyone they have blocked are removed client-side (`HomeViewModel.kt:116, 147-178`).

**Each card** shows the photo (or a coloured placeholder with their initial), a LIVE or PARTY badge, an online dot, the name, a verified tick for verified hosts and official accounts, and a "LV n" chip (`ui/components/UserCard.kt:54-152`). Tapping a card opens their profile — unless they are live, in which case it drops you straight into their live room (`HomeScreen.kt:127-130`).

**Search** is by Zipper ID only — a numeric keyboard with the hint "Search by Zipper ID" (`:260-271`). It is an exact document lookup, not a name search (`DiscoverRepository.kt:143-148`). Searching your own ID returns nothing.

**Filters** (bottom sheet titled "Filters", with "Clear all" and "Done"): a **"Verified hosts only"** toggle ("Identity-checked hosts you can call"), a free-text **Country** field, a single-choice **Language** from the first 20 languages, multi-select **Hobbies** (15 options) and **Interests** (10 options) (`:293-399, 56-64`). Country, language and verified-only are sent to the server; hobbies and interests are applied to the already-fetched page in memory (`HomeViewModel.kt:245-280`).

**Empty states:** "Nobody's around yet" / "Pull down in a moment — people come online all day." With filters on: "Nobody matches these filters" with a "Clear filters" action (`:119-125`). A failed ID search: "No one has that ID" (`:112-117`). The end of the list reads "You've seen everyone online" (`:182-191`).

> **Dead copy:** "Pull down in a moment" invites a pull-to-refresh gesture that the grid does not implement.

**LiveBrowseScreen** (`ui/screens/live/LiveBrowseScreen.kt`) is the Live tab: a header reading "Live" with a LIVE badge and an "N live" count, a row of category chips — **all, general, music, dance, gaming, talk** (`:53, 71-102`) — and a two-column grid of room cards showing the host's photo, a LIVE badge, a PK chip when a battle is running, the viewer count, host name, stream title, lifetime gifts received, and the category (`:141-174`).

Source: the `liveRooms` collection filtered to `isActive == true`, live-listened (`data/repository/LiveRepository.kt:45-47`). Category filtering is done in memory (`LiveBrowseScreen.kt:65-66`). Empty: "No one is live right now" / "Be the first — go live and people will find you here." with a "Go Live" action (`:106-111`).

> **Contradictory:** the floating **"Go Live"** button is shown to every signed-in account (`LiveBrowseScreen.kt:125-137`), but tapping it as a non-host fails with "Going live is for hosts. Apply with an agency referral code to become one." (`ui/screens/live/GoLiveViewModel.kt:213-218`). The invitation and the gate disagree.

**PartyListScreen** (`ui/screens/party/PartyListScreen.kt`) is reached from the Home strip, not a tab. Header "Party Rooms" with an "N open" chip and a lock icon for "Open a private room" (`:129-137`). Two mode pills, **Audio** and **Video**, which are the actual list switch — the server query is re-subscribed per mode (`:147-152`; `ui/screens/party/PartyListViewModel.kt:115-139`). Each row shows the room title (defaulting to "<host>'s room"), an AUDIO or VIDEO chip, and a seat counter reading either "3/8" or "FULL", with a sub-label of "no seat free", "ask to sit", or "seats taken" (`:267-345`). Source: the `partyRooms` collection (`data/repository/PartyRepository.kt:145, 170`).

Empty: "No audio rooms open" with either "Open one and people will find you here…" plus a "Start a room" action, or — for anyone who cannot create — "Check the other tab, or look again in a few minutes." (`:159-174`). In practice every signed-in account can create (`PartyListViewModel.kt:84`).

---

## 6. PROFILE & SOCIAL

**MyProfileScreen** — the "Me" tab (`ui/screens/profile/MyProfileScreen.kt`). Header "Me" with Edit and Settings icons (`:87-91`). Then the person's avatar, name, and a tappable line "ID ABCD1234 · Lv 7" that copies the full ID to the clipboard (`:103-107`), role badges, and two balance cells side by side: **Diamonds** (→ Diamond Shop) and **Beans** (→ Beans Centre) (`:129-137`).

Three conditional banners:
- **"Verify your face"** — shown to hosts who have not verified. "Takes a minute. Until you do, you cannot go live, you earn at the base rate instead of your own, and your weekly payout is held." (`:152-176`)
- **"Join an agency"** — shown to non-hosts. "Invited by an agency? Enter their code to become a host." (`:196-220`)
- **"Host earnings"** — shown to hosts: "Today's beans, weekly statement, payout", or "Verification pending — earning at base rate" (`:224-236`)

Then a grid of tiles (`:243-252`): **My Bag**, **My Level** (badged "Lv n"), **Daily Reward** (badged "!" when claimable, otherwise "D<streak>"), **Likes** (badged with the received-likes count), **Call History**, **Agency** (agency owners only), **Seller** (sellers only), **Settings**, **Feedback**, **Log out**.

**OtherUserProfileScreen** (`ui/screens/profile/OtherUserProfileScreen.kt`). A cover photo, avatar with a live/online ring, name, verified tick, "ID: … · Level n", age/gender/place line (`:201-258`). If they are live or in a party, a banner: "Tap to join their live room" / "Tap to join their party room" (`:260-262`).

**Four action discs** (`:265-287`):
- **Like / Liked** — writes an edge into `users/{me}/liked` (`ui/screens/profile/OtherUserViewModel.kt:269-281`; `data/repository/ProfileRepository.kt:306-325`). This is the only "follow-like" action on a profile.
- **Call** — overlaid with the live per-minute diamond cost, computed from the target's rate, both genders, and whether either is a host (`:275-285`; `OtherUserViewModel.kt:180-226`)
- **Gift** — opens the gift drawer
- **Message** — disabled if you have blocked them

Below: About Me (with Read more past 120 characters), Gallery, a Personal Information block (Full Name, Age, Gender, Area, Country, Languages, Hobbies, Interests), Gifts Received, and Top Supporters (`:292-380`).

The **⋮ More** sheet offers "Report <name>" and "Block <name>" / "Unblock <name>" (`:133-146`). **Report** presents six reasons — Inappropriate content, Harassment or abuse, Scam or fraud, Underage, Fake profile, Something else — and on submit the person sees "Thanks — our team will review this profile"; a document lands in the `reports` collection (`:149-165`; `data/repository/LiveRepository.kt:404-420`). **Block** warns "They won't be able to call, message or see you. You can unblock them from Settings." and writes to `users/{me}/blocked` (`:169-176`; `ProfileRepository.kt:510-527`).

> **Half-built:** there is **no Follow button on any profile.** `followUser` is only ever called from a live room (`ui/screens/live/WatchLiveViewModel.kt:398-403`), and `unfollowUser` exists in the repository but is called from nowhere in the app. The follower and following counts shown on your own profile (`ui/screens/profile/ProfileViewModel.kt:156`) can therefore only ever go up, and only via live rooms. Push notifications also promise a channel described as `"When someone you follow goes live"` (`service/PushNotifications.kt:88`), fed by a feature with no discoverable entry point.

**EditProfileScreen** (`ui/screens/profile/EditProfileScreen.kt`): cover photo, profile photo, Display name (30 chars), Bio (150 chars with counter), Date of birth, Area/City, Languages, Hobbies and Interests chip sections, and a 10-slot photo-and-video Gallery (`:148-310`). An **Account** block shows Gender, Phone, Email and Referral code as read-only rows (`:245-252`). Hosts see a **Call rate** card: editable within a level-dependent band, or locked with "Complete identity verification to set your own rate" / "Reach Host Level 3 to unlock custom rates" (`:256-295`).

**LikesScreen** (`ui/screens/social/LikesScreen.kt`): two tabs, **"I Like (n)"** and **"Liked Me (n)"**, each a list of name plus city/gender (`:71-91`). Empty: "You haven't liked anyone yet" / "Tap the heart on a profile you enjoy and they'll show up here." and "No likes yet" / "Complete your profile and go live to get noticed." (`:86-87`).

**BlockedUsersScreen** (`ui/screens/blocked/BlockedUsersScreen.kt`): "Blocked users", a list with an **Unblock** button per row, confirmed by "Unblock <name>?" / "They'll be able to see your profile and message you again." (`:107-138`). Empty: "Nobody blocked" (`:110`).

**GalleryViewerScreen** (`ui/screens/profile/GalleryViewerScreen.kt`): full-screen swipeable pager over photos and videos with a close button and an "n / m" counter (`:40-78`). Video files are detected by URL and played inline (`:102-145`).

**LevelScreen** (`ui/screens/level/LevelScreen.kt`): two tabs, **"Wealth level"** and **"Host level"** (`:159`). A big level number, a progress bar reading "12,400 more XP to level 8", a full "Level ladder" with thresholds and per-level perks (frame, entrance, card, bonus diamonds/beans, rate ceiling), and a **Level rules** card: for wealth — "Calls: 100% of diamonds spent", "Gifts: 100% of diamonds spent", "Lucky Gifts & Games: 1% of cost counted"; for host — "Based on total beans earned from calls and gifting", "Withdrawals do not reset your level progress" (`:180-298`).

---

## 7. CHAT

**MessagesScreen** (`ui/screens/messages/MessagesScreen.kt`): title "Messages" with an "N new" pill of total unread, and three tabs: **Official**, **Feedback**, **Chats** (`:57-65`).

- **Chats** lists conversations newest-first, each showing avatar, name, a preview prefixed "You: " when you sent it (or "Say hi!" when empty), a timestamp ("now", "5m ago", "Yesterday", "3d ago", then a date), and an unread badge capped at "99+" (`:96-131, 198-209`). Source: the `conversations` collection, matched on a `participants` array (`data/repository/ChatRepository.kt:35-62`). Empty: "No chats yet" / "Open someone's profile and tap Message, or reply to a reseller from the Diamond Shop."
- **Official** lists platform broadcasts with an "OFFICIAL" chip. Empty: "Nothing from Zipper yet" (`:135-157`). Source: the `broadcasts` collection.
- **Feedback** lists support tickets with status chips — Open, In progress, Replied, Resolved, Closed — and a "Reply from Zipper" block when staff have answered, plus a "Write feedback" button (`:159-193`).

**ChatScreen** (`ui/screens/messages/ChatScreen.kt`): header with the other person's avatar, name, and "Online"/"Offline" (`:79-86`). A message list, and a composer with the hint "Type a message…" and a send button (`:118-134`). Empty state: "Say hi to <name>" / **"Messages are private between the two of you. Keep payments to verified resellers only."** (`:98-99`).

**What can be sent from the app: plain text only.** The composer has no attachment control. The message model supports three types and the renderer handles all three — `text`, `image`, and `invite` (a tappable "<host> is live!" card with a "Join live" button) — but only `text` can be composed here (`:155-166`; `ChatRepository.kt:89-130`). Live invites are generated by the Go Live flow, which auto-messages your liked-and-online contacts when you start streaming (`ui/screens/live/GoLiveViewModel.kt:263-300`; `ChatRepository.kt:135-170`).

**Cost: none.** Messages are written straight to Firestore with no economy callable and no balance check (`ChatRepository.kt:89-130`). Unread counts increment on the recipient's side and are cleared when the chat is opened (`ui/screens/messages/ChatViewModel.kt:107`).

> **Contradictory — two unconnected ticket systems.** The Messages → Feedback tab reads the **`supportTickets`** collection, looking for `body`, `updatedAt` and `adminReply` (`ChatRepository.kt:27, 218-238`). The Feedback screen writes to **`feedbackTickets`**, with `message`, `createdAt` and `response` (`ui/screens/feedback/FeedbackScreen.kt:225, 210-223`). A ticket submitted in the app will not appear in the Messages tab that is meant to show it, and the Feedback screen keeps its own separate "My tickets" list (`FeedbackScreen.kt:130-131`).

---

## 8. CALLS

**Who can call whom.** Anyone can call anyone from a profile — there is no host-only gate on the Call disc (`ui/screens/profile/OtherUserProfileScreen.kt:275-285`). The paying side is decided by the server, and the app mirrors the rule: when the receiver is a host, the caller pays; when the caller is a host and the receiver is not, the receiver pays (`data/repository/EconomyConfigRepository.kt:194-196`; `util/EconomyEngine.kt:212-241`).

**The journey, outgoing.** Tap **Call** on a profile. The disc carries the live price — "1,600/min" in diamonds (`OtherUserProfileScreen.kt:281`). A `startCall` callable creates the call and the person lands on the call screen in a RINGING state over a blurred photo of the other party, with a pulsing ring (`data/repository/MoneyFunctions.kt:84-98`; `ui/screens/call/VideoCallScreen.kt:354-375`). Unanswered calls time out to MISSED (`ui/screens/call/VideoCallViewModel.kt:122-135`).

**IncomingCallScreen** (`ui/screens/call/IncomingCallScreen.kt`): caller's avatar and name, "Incoming video call", and then **a card that differs depending on who pays** (`:84-128`):
- If you will be charged: "This call costs 1,600 diamonds/min" and "Billed from your balance every 10 seconds"
- If you will earn: "You earn 375 beans/min" (or "Base rate until you're verified") and "Credited every 10 seconds while connected"

Two controls: **Decline** and **Accept** (which shows "Connecting…") (`:139-147`). Declining calls `declineCall`; letting it ring out marks it missed (`data/repository/CallRepository.kt:59-67, 129-131`).

**VideoCallScreen** (`ui/screens/call/VideoCallScreen.kt`). Full-screen remote video with your own feed in a corner tile labelled "You", a mute indicator, the duration clock, and a heart to like the other person mid-call (`:137-215`). Controls along the bottom: **Flip** camera, **Mute/Unmute**, **End**, **PIP** (`:306-321`). An in-call chat strip with the hint "Say something…" (`:257-290`). A gift button — **shown only to the paying side** (`:290-296`).

**What it costs, visibly.** A cost bar across the top differs by role (`:389-417`):
- Payer: **Balance**, **Rate** ("1,600/min"), **Time left** ("4m", turning amber under two minutes), and a **"Top up"** link
- Earner: **Earned** in beans, and **Duration**

Billing is a ticking `tickCall` every interval; when the server says stop, the call ends itself with reason `diamonds_exhausted` (`VideoCallViewModel.kt:223-251`). Shortly before that, a card appears: **"Balance running low"** / "Less than a minute left. Top up now to keep the call going." with a **"Recharge diamonds"** button that opens the Diamond Shop (`:449-468`; `navigation/ZipperNavGraph.kt:418`).

**What the host sees:** the same screen with the earner variant of the cost bar — beans accruing and the duration — plus incoming gift animations and the gift notice posted into the call chat ("🎁 Ravi sent Rose ×3") (`VideoCallViewModel.kt:442-450`).

**CallHistoryScreen** (`ui/screens/call/CallHistoryScreen.kt`): one row per call with a direction arrow, **Outgoing** / **Incoming** / **Missed**, a duration ("3:42", or "Missed" at zero), and the money — "−1,600" in red for calls you paid for, "+375" in bean green for calls you earned from (`:63-101`). Source: the `callHistory` collection, queried twice (as caller and as receiver) and merged (`CallRepository.kt:227-290`). Empty: "No calls yet" / "Open a host's profile and start a video call — every call you make or receive shows up here."

A host streaming live can switch calls off entirely with a **"Calls off" / "Calls on"** control on the Go Live rail (`ui/screens/live/GoLiveScreen.kt:257`).

---

## 9. LIVE

**What a host must do to go live.** From the Live tab's Go Live button, the person first hits a **camera-and-microphone permission wall** (`ui/screens/live/GoLiveScreen.kt:96-98`), then a pre-live setup card titled **"Set up your live"**: a 60-character title ("What's happening tonight?"), one of five category chips (general, music, dance, gaming, talk), a flip-camera button, the warning **"Stay in frame — the live ends automatically if you leave the camera for 2 minutes."**, and a **"Go Live"** button (`:321-366, 74`).

Tapping it runs two eligibility gates in order (`ui/screens/live/GoLiveViewModel.kt:199-230`):
1. Signed in — "Please sign in to go live"
2. `isHost` — "Going live is for hosts. Apply with an agency referral code to become one."
3. `isVerifiedHost` — "Finish face verification to go live. You can still open a party room in the meantime."

On success, starting a live **auto-messages every online person who has liked you** with a tappable live invite (`:263-300`).

**The host's live screen** (`GoLiveScreen.kt`): own camera full-screen, own name and a live clock, a close button, a tappable "N watching" chip, a scrolling comment feed with a composer ("Chat with viewers…"), and a right-hand rail: **PK** (shows "Finding…" while queued), **Share**, **Mute/Unmute**, **Flip**, **Calls off/Calls on**, **PIP** (`:199-290`).

Tapping the viewer count opens a sheet with two tabs — **"Viewers · N"** and **"Top gifters"** — where each viewer row has a **Remove** button, confirmed by "Remove <name>?" / "They'll be dropped from your live and can't rejoin this broadcast. You can't undo this." (`:407-493`). Empty: "No one is watching yet — share your live!" and "No gifts yet this session".

Ending the stream asks "End live?" / "Your viewers will be disconnected. You've earned 4,250 beans this session." (`:296-303`).

**FaceDetectionManager** (`ui/screens/live/FaceDetectionManager.kt`) is the automatic presence check behind that warning. The host's own camera surface is sampled roughly every interval, copied to a bitmap, and run through Google ML Kit face detection in fast mode with a 15%-of-frame minimum face size (`FaceDetectionManager.kt:24-28`; `GoLiveScreen.kt:146-155`). When no face is found, a full-screen overlay appears: **"We can't see you"** / "Come back in front of the camera to keep the live going." with a countdown "Ends in 118s" (`GoLiveScreen.kt:243-247`), and the stream ends itself when it runs out (`GoLiveViewModel.kt:390-420`). If the detector itself errors, it reports a face as present rather than ending the stream — `onFaceDetected?.invoke(true) // Safe default: assume face present` (`FaceDetectionManager.kt:37`).

**What a viewer can do** (`ui/screens/live/WatchLiveScreen.kt`): watch; see the host's name, viewer count, and a **Follow** (+) button that becomes a tick (`:173-190`); send comments ("Say something…"); tap a heart to like the stream; send **gifts** (`:234-277`). The rail offers **Gifts** (a "Top gifters" leaderboard), **Share**, and **PIP**. The **⋮** sheet offers **"Hide comments"/"Show comments"**, a **Stream quality** choice of **Auto / High / Low**, and **Report**, which presents six reasons — Nudity or sexual content, Harassment or hate, Scam or spam, Underage host, Violence, Something else — answered with "Thanks — our team will review this live" (`:425-456`; `WatchLiveViewModel.kt:422-436`).

Two terminal overlays: **"Removed from this live"** / "The host removed you from this room. You can still watch their other lives." and **"Live has ended"** / "<host> has finished this broadcast. Follow to catch the next one." with a **"Follow <host>"** button (`:461-494`).

Gifts cost diamonds and go through the server `settleGift` callable with a `live` context; insufficient balance surfaces as a message (`WatchLiveViewModel.kt:343-380`; `MoneyFunctions.kt:56-63`).

**LiveSummaryScreen** (`ui/screens/live/LiveSummaryScreen.kt`) is what the host sees the moment a stream ends: **"Live ended"** / "Here's how it went", then **Beans earned** as the hero figure, and four stats — **Duration**, **Peak viewers**, **Gifters** — plus a **"Top gifters"** list, the line "Thank you for streaming — keep up the great content.", and a **Done** button back to Home (`:93-136`). The route's own comments record that this card previously overstated host earnings twenty-fold by passing beans in a field named for diamonds, and reported zero viewers and zero gifters to every host (`navigation/Screen.kt:154-175`).

---

## 10. PARTY

**PartyRoomScreen** (`ui/screens/party/PartyRoomScreen.kt`) — reached from the Party Rooms list, or by opening a private room by ID.

**Creating a room** (the "Start a party room" sheet, `ui/screens/party/PartyListScreen.kt:366-530`) sets: **kind** (Audio — "Voices only. Cheapest on data…" / Video — "Faces on camera. Every seat on video costs everybody in the room data and battery"), **room name** (optional, defaults to "<name>'s room"), **seats** (a choice of counts; ten video tiles carries a warning), **taking a seat** (**"Anyone can sit"** or **"Ask me first"**), **who can find it** (**Public** or **Private**, the latter requiring a 4-digit password), and a **welcome message** that rejects digits to stop phone numbers being posted.

**Joining.** A public room opens directly. A private room shows a **password gate**: the host's avatar, the room name, "Ask <host> for the four-digit code.", a four-box code field, and **"Join the room"** (`PartyRoomScreen.kt:1494-1545`). Private rooms never appear in the list, so you need the room ID too — pasted into an "Open a private room" sheet, which validates the ID shape and reports "No room with that id." when it is wrong or the room has closed (`PartyListScreen.kt:579-685`). Entering the room asks for microphone permission (and camera for video rooms) (`PartyRoomScreen.kt:213-223`).

**Seats.** A grid of numbered seats, audio as discs and video as tiles. An empty seat reads "Seat 4"; a locked one reads "Locked"; a pending request reads "Waiting…" (`PartyRoomScreen.kt:1198-1209`). Tapping an empty seat either sits you down immediately or sends a request, depending on the room's mode — "Asked the host for seat 4." — with a strip at the bottom reading "Waiting for the host to let you onto seat 4" and a **Cancel** link (`ui/screens/party/PartyRoomViewModel.kt:637-663`; `PartyRoomScreen.kt:1256-1274`). Locked seats refuse with "This seat is locked."

**What a participant can do.** A listener can read the welcome card, chat ("Say something…"), send gifts to a specific seat, view profiles, and ask for a seat. Once seated they also get a **microphone** toggle ("Turn my microphone on/off") and, in video rooms, a **camera** toggle (`PartyRoomScreen.kt:1327-1420`). A seat muted by a moderator shows "A moderator muted you" and the person cannot unmute themselves (`PartyRoomViewModel.kt:694-704`).

**Moderation.** The room menu offers "Leave my seat", "People in the room", "Seat requests · N", "Room settings", and — for the owner — **"End this room"**, confirmed by "Everyone is disconnected and the room disappears from the list. You cannot reopen this one." (`ui/screens/party/PartyRoomSheets.kt:300-362`). The seat menu lets admins mute, unmute, lock, unlock, take someone off a seat, or **remove them from the room** — "They lose their seat and cannot rejoin this room… the block lasts until the room closes." (`PartyRoomSheets.kt:381-483`). The People sheet separates **Admins** from **In the room**, marks rows HOST and ADMIN, and lets the owner promote, demote, invite to a free seat, or remove (`PartyRoomSheets.kt:568-781`). Mute authority is hierarchical: an admin cannot undo an owner's mute — "Muted by the host — only they can unmute" (`PartyRoomSheets.kt:437`; `PartyRoomViewModel.kt:148-160`).

Removed participants see **"Removed from this room"** / "A moderator removed you. You cannot rejoin this room, but their other rooms are still open to you."; a closed room shows "This room has closed" (`PartyRoomScreen.kt:605-616`).

**Who can open a room:** any signed-in account, host or not — deliberately a looser rule than going live (`PartyRepository.kt:441-445`; `PartyListViewModel.kt:84`).

---

## 11. WALLET & ECONOMY

Two currencies: **diamonds** are bought and spent; **beans** are earned by hosts and either converted to diamonds or paid out. The published fallback rate is 20 beans to 1 diamond, 100 beans to ₹1, and a payout floor of 100,000 beans (₹1,000) (`data/repository/EconomyConfigRepository.kt:239-261`; `util/EconomyEngine.kt:74-85`). Live values come from `appConfig/economy`.

**DiamondShopScreen** (`ui/screens/diamond/DiamondShopScreen.kt`). Titled "Diamond Shop". Recharge packs load from the `rechargePackages` collection — label, rupee price, dollar price, base diamonds, bonus diamonds, badge (`:91-110`). Each pack card shows the diamond total, "50,000 + 5,000 bonus", the rupee price, and a local-currency estimate (`:241-270`).

**There is no in-app payment.** A notice reads "Zipper sets the pack price" / "You pay a verified reseller directly and they may add their own margin. Diamonds arrive once they confirm your payment." (`:178-183`). Tapping a pack opens a "Choose a reseller" section with a pre-written chat message — "Hi! I want to recharge 50,000 diamonds (₹1,145 pack). Please confirm." — and a safety line "Never share OTPs or passwords." (`:202-240`). Empty: "No resellers are online right now."

**ResellerListScreen** (`ui/screens/diamond/ResellerListScreen.kt`). Titled "Verified resellers", headed "Pay only verified resellers. Zipper never asks for OTPs or passwords." (`:125`). Each row: name, a verified tick, a description or a masked phone number, a **QR** button, and a **Message** button (`:167-182`). The QR sheet shows the reseller's payment QR with "Scan to pay, then message the reseller with your Zipper ID." (`:146-150`). Source: `publicSellers` (`:88`). Empty: "No resellers right now".

**DiamondHistoryScreen** (`ui/screens/diamond/DiamondHistoryScreen.kt`). Titled "Diamond wallet". A balance card with a **"Recharge diamonds"** button, then a transaction list where every row is labelled in plain language: "Seller Recharge", "Gift Sent to Priya", "Call — Ravi", "Daily Reward", "Beans → Diamond", "Game Win Reward", "Lucky Spin Win", "Added by Zipper" (`:27-40`). Credits in diamond blue with "+", debits in red with "−" (`:87`). Empty: "No transactions yet" / "Recharge from a verified reseller…".

> **Dead labels:** "Game Win Reward" and "Lucky Spin Win" describe features the app does not have (Games is a placeholder).

**BeanHistoryScreen** (`ui/screens/beans/BeanHistoryScreen.kt`). Titled "Beans". A balance card stating the rate — "20 beans = 1 diamond" (`:92`). Then a **"Convert to diamonds"** card: a field accepting only multiples of the rate ("Beans to convert (multiples of 20)"), a "Convert all 48,400" shortcut, a live preview ("You'll receive 2,420 diamonds", "4 beans stay in your balance"), and a **Convert** button (`:108-234`). Refusals are specific: "Insufficient beans — you have 1,240." and "Convert in multiples of 20 beans — try 1,220 or 1,240." Transaction labels: "Gift — from Ravi", "Call — Priya", "Converted to Diamonds", "Weekly Salary", "Weekly Beans Processed for Cashflow" with the sub-line "Beans reset every Sunday — processed to your cashflow account" (`:42-59`).

**EarningsScreen** (`ui/screens/earnings/EarningsScreen.kt`) — hosts only, from the Me tab. Server-sourced via a single `getHostHome` call (`data/repository/HostStatsRepository.kt:83`; `MoneyFunctions.kt:509`). Shows:
- **Today**: beans, plus Calls, Minutes, Gifts, From calls (`:198-208`)
- **This week**: total beans split into Gifts and Calls (`:216-221`)
- **Payout**: "Available now" and "Pending release", with the rule stated — "Each week's beans are released the following week. Converting to diamonds is instant but makes those beans non-payable." (`:226-229`)
- Blockers, when they apply: "Verification pending — payouts unlock once your identity is approved." or "Payouts are on hold for this account. Contact support from Feedback." (`:231-232`)
- **Host level** with the current rate and ceiling, an "Edit rate" link, progress to the next level, and Lifetime / From calls / From gifts totals (`:242-265`)
- **Weekly statements**, each a row with the week, the gift/call/converted split, a rupee amount, and a status of **Released**, **Held** (with the reason) or **Pending** (`:274-290`)
- A **"Convert beans to diamonds"** button (`:234`)

Non-hosts who reach the screen see "Host figures unavailable — this account isn't a host, or the server couldn't be reached." (`:270`).

**MyBagScreen** (`ui/screens/bag/MyBagScreen.kt`) — the cosmetics locker and shop. Six tabs: **Avatar frames, Chat bubbles, Profile cards, ID frames, Entrances, Video cards** (`:177-182`). Items load from the `bagItems` collection and are filtered by the person's gender and host/user role (`ui/screens/bag/MyBagViewModel.kt:108-147`).

Each item shows a preview and a status chip — **Equipped**, **Owned**, **Expired**, **Event exclusive**, or **Reach level 12** — with explanatory copy: "Unlocks automatically at level 12.", "Event exclusive — earned by taking part in a Zipper event.", "This has expired and is no longer worn. Renew it to get it back — nothing else was lost." (`:371-383`). Purchasable items show a **Duration** (a term choice like "30d · 1,200", or "Permanent"), a diamond **Price**, a **Remaining** days counter when owned, and a **"Buy for 1,200"** / **"Renew for 1,200"** / **"Equip"** button (`:389-461`). Buying and equipping both go through server callables, `purchaseBagItem` and `equipBagItem` (`MoneyFunctions.kt:182-218`). A banner warns about expiry: "3 items expire soon … Open one to renew it; the days you have left are added to the new term, not replaced." (`:273-276`). Load failure: "Couldn't load the shop" — "Every item and price comes from Zipper's server, so there is nothing to show until it answers." (`MyBagViewModel.kt:169`).

> **Half-built:** the **Video cards** tab is not a shop tab at all — it shows a count badge and the promise "Each card lets you start a free random call." (`:744-745`). Cards are earned from daily rewards, but **nothing in the app spends them**; there is no random-call feature anywhere in the source. Business purpose unclear.

**DailyRewardsScreen** (`ui/screens/level/DailyRewardsScreen.kt`). Titled "Daily rewards". Shows "Day 4 streak" (or "Start your streak"), the strap "Check in daily to earn diamonds and free call cards", today's reward in diamonds plus any video cards, a seven-day strip, and a **"Claim today's reward"** button that becomes "Claimed today" (`:239-300`). The schedule is read from `appConfig/dailyRewards` (`data/repository/DailyRewardsConfigRepository.kt:81`) but the credited amount is decided server-side by the `claimDailyReward` callable, and the screen says so when the schedule cannot be read: "Claim to find out — the server decides the amount." (`:276`) and "Amounts are indicative — the live schedule could not be read." (`:285`). Success toast: "Day 4 claimed! +500 💎 +1 video card 📹". Footer varies: "Come back tomorrow for the Day 5 reward." / "Your last streak lapsed, so today starts again at Day 1." / "Rewards grow every day you check in. Miss a day and the streak starts over." (`:290-294`). Days roll over on an India-timezone calendar (`:170-174`).

**BuyCoinScreen** — see section 12; it is the reseller-facing wholesale purchase, not a consumer screen.

---

## 12. HOST & AGENCY ON THE PHONE

**How an ordinary user becomes a host.** Only by agency invitation. There is no apply-to-be-a-host flow.

**JoinAgencyScreen** (`ui/screens/host/JoinAgencyScreen.kt`), reached from the "Join an agency" banner on the Me tab. Titled "Join an agency", it states the model up front: "Hosts are invited by an agency. If one has invited you, they will have given you a code — enter it here to become a host." (`:83-84`). A single **Agency code** field (placeholder "e.g. ZIPP4K2M") and a **"Check code"** button. On a hit it shows "Invitation found — <Agency>" and spells out the consequence: "Joining makes you a host of this agency at the rate they agreed. You will then need to verify your face before you can go live or be paid." followed by a **"Join <Agency>"** button (`:161-186`). The footer closes the door explicitly: "No code? Agencies invite hosts directly — you cannot apply from here." (`:214-217`). Joining routes straight to Face Verification (`navigation/ZipperNavGraph.kt:394-402`).

The same code can also be entered during first-run Profile Setup (section 3). The route's own documentation records that this screen exists because the field used to live only on the signup form, leaving already-registered invitees with nowhere to type a code (`navigation/Screen.kt:125-138`).

**FaceVerificationScreen** (`ui/screens/auth/FaceVerificationScreen.kt`). Titled "Verify your identity", with a **"Later"** escape hatch in the top bar (`:126-129`). A camera permission wall first ("Zipper needs the camera for a quick liveness check. Your selfie is only used for verification.", with an "Open Settings" route if permanently denied) (`:139-152`). Then a three-step liveness sequence with on-screen prompts: **"Look directly at the camera"** → **"Now BLINK slowly"** → **"Great! Now SMILE 😄"** → "Hold still…" → "Verifying…" (`:74-78`). A **Capture** button, a step indicator, and an attempt counter "Attempts remaining: 2 / 3" (`:410, 431`).

A biometric notice is defined: "Your face image is biometric data. It is used only to confirm you are the person in your profile photo and is reviewed by Zipper staff." (`:81`).

The captured photo is also run through an on-device gender classifier, and a mismatch against the declared gender fails the attempt: "Face does not match your declared gender (female). Attempts remaining: 2" (`:257-262, 448-466`). After three failures the person is sent to Home with a reassurance rather than a lockout: "That is three tries. Your account is fine — the capture just has not gone through. Come back to it from Me → Verify your face when you have a better connection." (`ui/screens/auth/AuthViewModel.kt:405-459`).

**What verification buys, stated on the Me tab:** without it you cannot go live, you earn at the base rate rather than your own, and your weekly payout is held (`ui/screens/profile/MyProfileScreen.kt:170-173`).

**AgencyDashboardScreen** (`ui/screens/agency/AgencyDashboardScreen.kt`) — titled "My agency", shown only when the account has `isAgent`. What an owner can do from the phone is narrow:
- See an approval status chip: **Approved / Rejected / Pending** (`:134-137`)
- See and **copy their referral code**, with the explanation "Hosts who sign up with your code join this agency." (`:147-154`)
- See three numbers: **Hosts**, **Sub-agencies**, **Last payout** in rupees (`:163-165`)
- See a **"My hosts"** list — which shows only a generic "Host" row per entry, no name or figures (`:171-186`). Empty: "No hosts yet" / "Share your referral code — every host who signs up with it appears here."
- See the latest **Weekly payout** report (status **Generated / Submitted / Paid**, week label, rupee total) and, when it is still "generated", tap **"Submit report"** — the single write action available, flipping `status` to `submitted` in `weeklyPayoutReports` (`:189-228`). Confirmation: "Report submitted successfully."

Empty: "You're not linked to an agency" / "Apply from your profile, or ask an agency owner to add you with their referral code." (`:129`).

> **Contradictory:** that empty state tells the person to "Apply from your profile" — but the Join Agency screen states "you cannot apply from here" (`JoinAgencyScreen.kt:214-215`), and no apply flow exists.

**SellerDashboardScreen** (`ui/screens/seller/SellerDashboardScreen.kt`) — titled "Seller panel", for accounts with `isSeller`. The seller sees their **coin balance** and an **Online/Offline** switch that controls whether buyers can find them (`:376-403`), three stats (**Total sold**, **Pending**, **Completed**), a **"Buy diamonds"** button, and two tabs: **"Pending (N)"** and **"History"** (`:414-425`).

Each pending request shows the buyer's name, the diamond count, the rupee amount paid, and the buyer's payment screenshot, with **Reject** and **Approve** buttons (`:432-470`). Approving sets `status: approved` on the `rechargeRequests` document and the seller is told "Approved — 50,000 diamonds. The transfer is running; your coin balance updates when it lands." (`:453-470`). Rejecting opens a dialog requiring a typed reason ("Reason (e.g. wrong amount)") and saves it on the request (`:290-357`). Failure messages are unusually specific, including the self-dealing case: "a seller can't approve their own purchase" (`:174`). Missing fields are surfaced rather than hidden — "Diamond count not recorded", "Amount paid not recorded" (`:592-594`).

**BuyCoinScreen** (`ui/screens/seller/BuyCoinScreen.kt`) — how a seller restocks. Titled "Buy diamonds (wholesale)". An **India (₹) / Foreign ($)** switch, three packs (1 Lakh / 2 Lakh / 5 Lakh coins), and a margin notice: "Your margin: ₹855 per lakh" / "You pay ₹2,290 per lakh. Buyers pay ₹3,145. You collect the difference from them directly." (`:105-108, 279-280`). If the margin is zero: "No margin set" / "You are being charged the same price your buyers pay, so this purchase earns you nothing. Contact support before transferring." (`:284-285`).

Then the company's own payment details, read from `appConfig/paymentCredentials`: copyable **Bank / IFSC / Account / Name / Branch** rows for India, or a **Binance UID** for abroad (`:176-338`). When those cannot be loaded, the screen refuses rather than guessing: "Our bank details could not be loaded, so there is nothing safe to show you. Do not transfer to any account you may have used before" and "You cannot submit a purchase request until this is fixed." (`:316-321`). The seller pays out of band, then submits a **UTR / reference number** and a **payment screenshot**, which creates a `coinPurchaseRequests` document (`:191-234`). Success: "Request submitted" / "Your purchase request has gone to Zippern. Coins are credited once the finance team verifies your payment — usually within a few hours." (`:246-247`).

---

## 13. SETTINGS & ACCOUNT END

**SettingsScreen** (`ui/screens/settings/SettingsScreen.kt`), grouped:

- **Secure your account** — guests only: "Add your phone number", "Add your email", with "You are signed in as a guest, so this account only exists on this phone. Adding either one keeps it." (`:183-195`)
- **Account** — "My agency" (agents), "Seller panel" (sellers), "Blocked users", "Switch account" (`:202-206`)
- **Appearance** — "App language", showing the current language in its own script. Eleven options: English, हिन्दी, मराठी, বাংলা, தமிழ், తెలుగు, ಕನ್ನಡ, ગુજરાતી, ਪੰਜਾਬੀ, اردو, العربية (`:50-60, 226`)
- **Notifications** — "Notification settings · Calls, messages, live", which opens the Android system settings page (`:229-234`)
- **About** — "Help & support", "Privacy policy", "Terms of service", "Check for updates" (only in builds with OTA enabled), and "Version" showing the installed build (`:236-267`)
- Then "Log out", and a danger zone with **"Sign out and forget this device"** and **"Delete account"** (`:272-309`)

**LegalScreen** (`ui/screens/settings/LegalScreen.kt`) is what Settings' Privacy policy and Terms of service rows actually open (`navigation/ZipperNavGraph.kt:737-738`). It fetches the document from the `policies` collection by type (`privacy_policy`, `terms_of_service`, `faq`) and renders it with a version header — "Version 4", "Published 12 Jun 2026", "Last updated: 12 Jun 2026" (`:59-154`). Failure: "Content not available" / "Check your connection and open this page again."

> **Dead screen:** `PrivacyPolicyScreen` — a 12-section hardcoded policy dated "Last updated: June 2025" (`ui/screens/settings/PrivacyPolicyScreen.kt:23-93`) — is registered as a destination (`ZipperNavGraph.kt:815-817`) but **nothing in the app navigates to it.** A repo-wide search finds exactly one reference to `Screen.PrivacyPolicy`, and it is that registration.

> **Near-dead screen:** `TermsScreen` — a 15-section hardcoded Terms document dated "Last updated: June 2026" (`ui/screens/auth/TermsScreen.kt:26-86`) — is reachable from exactly one place: the "Terms & Conditions" link on the Login screen (`ZipperNavGraph.kt:247`). So the terms a person agrees to at signup are a compiled-in copy, while the terms Settings shows them afterwards are a CRM-managed document from Firestore. The two can drift and nothing reconciles them. The hardcoded version also promises Games (section 8), a 30-day call-history retention, and forfeiture of balances on termination.

**FeedbackScreen** (`ui/screens/feedback/FeedbackScreen.kt`). Titled "Help & support", with tabs **"New ticket"** and **"My tickets"** (`:297`). The form takes a **Category** from eight choices — 🔐 Login / Auth, 💳 Payment, 💎 Recharge, 📞 Video Call, 📡 Live Stream, 👤 Account, 🐛 Bug Report, 💬 General (`:273-280`) — a **Subject** ("What is this about?"), a **description** with a character counter, an optional time-of-occurrence, and image or video **attachments** (`:388-406`). Submitting writes to `feedbackTickets` with `status: open` and `priority: medium` (`:210-225`), and the person sees "Ticket sent" / "We read every ticket and reply here under My tickets, usually within a day." (`:375`). Validation: "Subject and message cannot be empty."

**Account deletion and the recovery window.** The "Delete account" row opens a dialog titled **"Delete account?"** with the clearest copy in the app (`SettingsScreen.kt:381-398`):

> "You are signed out straight away and your profile disappears — calls and messages stop, and nobody can find you. For 30 days nothing is destroyed. Sign in again before then and we will offer your account back, exactly as it was. After 30 days it is final: your profile, photos, followers and anything you bought are deleted, you can no longer sign in, and any diamonds or beans left on the account go with it. Your purchase and earnings records are kept, so a payment question can still be answered later. Messages you have already sent stay in the other person's chat."

Buttons: **"Delete"** and **"Keep my account"**. It calls a soft-delete (`AuthRepository.kt:2280`, server callable `requestAccountDeletion`) and drops the person on Login (`ZipperNavGraph.kt:95-100`). A failure is reported with reassurance appended: "… Your account has not been deleted." (`ui/screens/auth/AuthViewModel.kt:654-659`). Signing in during the window produces the RecoverAccountScreen described in section 2.

**SuspendedScreen** (`ui/screens/auth/SuspendedScreen.kt`). Headline **"Account suspended"**, then the distinction stated outright: **"This is a suspension, not a ban."** (`:155-164`), then the reason recorded by staff. The end-date block has three shapes (`:181-250`):
- No date on record: **"No end date"** / "This suspension does not run out on its own — it stays until a reviewer lifts it. We would rather tell you that than put a date on screen that was never set."
- Elapsed: **"Your suspension has run out"** / "It ended on 2 June 2026. Accounts are let back in by a check that runs on a schedule, so if you are still seeing this it has not caught up yet. Try again in a few hours."
- Future: **"Ends on 2 July 2026"** / "That is 14 days from now. Your account opens again by itself — there is nothing you have to do."

Then **"This phone is not blocked"** / "Only this account is suspended. The device itself is untouched, so you can go back to the login screen and sign in with another account" (`:266-275`), a **"Back to login"** button, and a caution: "This signs you out of the suspended account. Send your appeal first if you mean to write one — it has to be sent while you are signed in here." (`:281-300`).

**What they can do:** write an appeal (the shared appeal panel), or leave for another account on the same phone.

**BannedScreen** (`ui/screens/auth/BannedScreen.kt`) has two faces (`:152-190`):
- **Account ban** — "Account banned", with the recorded reason.
- **Device block** — "This device is blocked", with the extra explanation "Every account is blocked on this phone, whoever signs in, so making a new one here will not get past it. Another device will work if the account itself is in good standing."

**There is no way off this screen.** Unlike Suspended, it offers no route back to Login — deliberately, per the route's documentation (`navigation/Screen.kt:71-79`).

**The appeal panel** (shared by both, `BannedScreen.kt:224-438`) is the one thing a banned person can do. It offers "Think this is wrong?" / "Tell us what happened. A person will read it.", a free-text field ("What happened, in your own words…"), up to three screenshots ("Screenshots help, up to three. Optional."), and a **"Send appeal"** button, with the fallback "You can also write to support@zipperlive.app". Once sent: "Your appeal is with a reviewer" / "A person reads every appeal. You will be able to sign in normally if it is accepted — there is nothing else you need to do, and sending another one will not make it faster." A previous verdict is shown as "Your last appeal was accepted" / "Your last appeal was not accepted".

For a **device** block with no signed-in session, the panel degrades to instructions only: "Write to support@zipperlive.app from the email address or phone number on the account" (`:259-267`). The session is deliberately kept on both screens precisely so the appeal can be written (`SplashScreen.kt:163-179`; `MainActivity.kt:267-279`).

**Mid-session bans and suspensions** are caught by a live listener on the user record and take effect immediately: the push token is dropped so the phone stops ringing, and the person is moved to the Banned or Suspended screen over whatever they were doing (`MainActivity.kt:267-314`; `SessionViewModel.kt:194-245`).

---

## 14. OFFLINE / FAILURE BEHAVIOUR

**No network, generally.** Firestore runs with a persistent local cache (`di/FirebaseModule.kt:25-33`), so previously-seen lists and profiles still render from disk and live listeners resume when connectivity returns. There is no global offline banner and no retry queue.

**Server calls that fail** (anything touching money, calls, sessions, bag purchases, daily rewards) go through one error path: a Cloud Functions error passes the server's own human-readable message straight to the user, and any other exception becomes **"Could not reach the server. Check your connection."** (`data/repository/MoneyFunctions.kt:569-581`). The comment is explicit that the server's wording is preferred because "you need 900 diamonds, you have 420" is the whole answer.

**Splash with no network.** The device-ban lookup failing is treated as "not banned" and the launch continues (`SplashScreen.kt:95-99`). If the user document cannot be read at all, the person is let into Home rather than held on the splash — `catch (e: Exception) { onNavigateToMain() }` (`SplashScreen.kt:283-285`). Any identity check that cannot reach the server during sign-in refuses politely instead: "Could not verify your account right now. Check your connection and try again." (`AuthRepository.kt:1727-1731`).

**A failed call.** Several distinct outcomes, each named: no answer times out to **MISSED** (`VideoCallViewModel.kt:122-135`); an Agora connection failure ends the call with reason `network` (`:332`); running out of diamonds ends it as `diamonds_exhausted` after the low-balance card has been shown (`:248-251`, `VideoCallScreen.kt:449-468`); and a failure to end a call is the one case the app refuses to paper over — "You are still connected and still being charged — try End again." (`VideoCallViewModel.kt:309-310`). Ending is retried on transient server codes before giving up (`data/repository/CallRepository.kt:101-128, 304`). Minimising the picture-in-picture window while connected ends the call (`VideoCallScreen.kt:103-104`).

**A failed purchase.** Nothing is bought inside the app, so there is no payment failure to handle. The three failure surfaces are: pack prices not loading — "Packs aren't available right now" / "Recharge packs are set by Zipper and load from the server." (`ui/screens/diamond/DiamondShopScreen.kt:155-156`); no resellers online — "No resellers are online right now. Try again shortly." (`:211`); and a bag purchase or equip rejected by the server, where the server's message is shown verbatim. The reseller's own wholesale purchase refuses to submit at all if the company's bank details cannot be read (`ui/screens/seller/BuyCoinScreen.kt:316-321`). A gift with insufficient funds says "Not enough diamonds — recharge to send this" (`ui/screens/profile/OtherUserViewModel.kt:292`).

**An expired session.** The credential failing to reload raises "Your session has expired. Please sign in again." as a dismissible notice on the Login screen, after a full teardown that also mints a quick-login secret so a guest does not lose the account outright (`SplashScreen.kt:134-153`; `SessionViewModel.kt:108, 350-372`; the notice is rendered at `LoginScreen.kt:411-413, 751-769`).

**Being displaced by another device** is the same mechanism with different wording: "You were signed out because your account was opened on a Motorola Edge 40." — or, when the other device ran an older build that recorded no name, the generic "…on another device." (`SessionViewModel.kt:104, 126-143`; `MainActivity.kt:244-246`).

**A forced update.** A modal with no dismiss control and the single message "This version can no longer be used. Install the update to carry on." (`ui/screens/update/UpdateDialog.kt:137-139, 190`). It sits over whatever screen is open and survives navigation, because the gate lives at the composition root rather than inside any destination (`MainActivity.kt:447-490`). The flow then needs an Android permission the person has to grant by hand — "Allow installing updates" / "Android needs your permission before Zipper can install its own update. The next screen has one switch — turn it on and come back, and the download starts by itself." (`UpdateDialog.kt:228-243`) — then a progress dialog ("Downloading update" → "Checking the download" → "Applying update…"), then "Ready to install" / "The download is verified. Android will ask you to confirm the install.", with "Update failed" and a "Try again" button on error (`:262-397`). Optional updates show "Later" / "Not now" and warn "The update downloads over your mobile data if you are not on Wi-Fi." (`:209`). The manual Settings check also has an up-to-date answer: "You are up to date" / "This is the newest build that has been published for this channel." (`:146-149`).

> **Worth flagging for business readers, from the manifest's own comment:** `"GOOGLE PLAY FORBIDS AN APP UPDATING ITSELF OUTSIDE PLAY."` (`src/main/AndroidManifest.xml`). The whole self-update feature, and the `REQUEST_INSTALL_PACKAGES` permission behind it, exist for hand-shared team builds; the comment states a Play submission needs that manifest line removed as well as the build flag flipped. Both release and debug build types currently set `OTA_ENABLED = true` (`app/build.gradle.kts:244, 248`).

**Push notifications and failure.** Three channels: **Incoming calls** ("Rings when someone video-calls you", high importance, with Decline and Answer actions), **Messages**, and **Live** (`service/PushNotifications.kt:51-92, 117-147`). If notification permission was never granted, nothing is posted and nothing complains (`:93-95`). A notification tapped while signed out is **held, not dropped** — the destination is parked and consumed the moment the person gets past Login (`MainActivity.kt:416-443`).

---

## SUMMARY OF THINGS THAT LOOK HALF-BUILT, DEAD, OR CONTRADICTORY

1. **Games tab is a placeholder** — `PlaceholderScreen("Games — Phase 9")` (`MainScreen.kt:144`) — yet Terms section 8, the Level rules card, and two diamond-transaction labels all describe games as live.
2. **Video cards are earned but unspendable.** "Each card lets you start a free random call." (`MyBagScreen.kt:744`) describes a feature with no implementation.
3. **Follow is one-way and live-only.** No Follow button on any profile; `unfollowUser` is never called; the "Live" push channel is described as `"When someone you follow goes live"` (`PushNotifications.kt:88`).
4. **Two unconnected support-ticket systems** — Messages reads `supportTickets`, Feedback writes `feedbackTickets`.
5. **Three competing legal documents** — a hardcoded Terms reachable only from Login, a hardcoded Privacy Policy reachable from nowhere, and CRM-managed `policies` documents shown in Settings.
6. **"Go Live" is offered to everyone and refused to non-hosts** (`LiveBrowseScreen.kt:125-137` vs `GoLiveViewModel.kt:213-218`).
7. **"Apply from your profile"** on the Agency Dashboard empty state (`AgencyDashboardScreen.kt:129`) contradicts "you cannot apply from here" (`JoinAgencyScreen.kt:214-215`).
8. **The email-recovery promise overstates what exists** — "can sign back into it … from anywhere" (`SecureEmailScreen.kt:235`) with no email sign-in on the Login screen.
9. **No maintenance-mode gate** exists anywhere in the Android app.
10. **"Pull down in a moment"** on the Home empty state invites a refresh gesture the grid does not implement (`HomeScreen.kt:122`).
11. **The OTA self-updater is Play-incompatible by its own documentation** and is enabled in both build types.