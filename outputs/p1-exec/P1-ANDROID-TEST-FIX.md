# Android test failure — `WorkModulesTest` line 153: diagnosis and fix

25 Oct 2026. Only one file changed: `zipper-app/app/src/test/java/com/zipper/app/data/work/WorkModulesTest.kt`. The pre-fix copy is at `outputs/p1-exec/before/android-test-fix/`. **No production code changed.**

## Root cause: the test, not the implementation

- **What failed.** Line 153 was `assertFalse("ownerWork never starts a mobile session", owner.contains("startMobileSession"))`, a raw source-text search over all of `OwnerWorkFirebase.kt`.
- **Why it matched.** The only match is **line 14, inside the class KDoc**: "…so the personal app's phone sign-in, `startMobileSession`, `credentialsValidAfter` … are never touched." The test failed on the sentence documenting the very invariant it checks. I wrote both the comment and the test in the previous stage.

**The runtime behaviour is correct** (traced in code):

- **The one entry point.** A backend mobile session is started only by the `startMobileSession` callable (`functions/src/identity.ts:1773`). The app names it in code only in `MoneyFunctions.kt:621`. The only caller is `AuthRepository.kt:261/264`, the personal sign-in.
- **It always runs as the personal sign-in.** `MoneyFunctions` uses the Hilt `FirebaseFunctions`, which is `FirebaseFunctions.getInstance("asia-south1")` (`di/FirebaseModule.kt:58`). That is region only, so it is bound to the **default** FirebaseApp, and every callable carries the personal sign-in's token. No code creates a Functions instance for `ownerWork`.
- **No Owner work component reaches it.** `data/work/` and `data/api/` contain no code reference to `MoneyFunctions`, `AuthRepository` or the callables, only that comment.
- **An `ownerWork` sign-in can't trigger personal listeners.** Every personal auth listener is registered on the default `FirebaseAuth` (`ProfileRepository.kt:103`, `ApiClient.kt:65`). All personal uses are `FirebaseAuth.getInstance()` or the injected default; the only `getInstance(app)` is `ownerWork`'s own. There is no App Check and no other app enumeration.

## Fix (test only)

1. **New `codeOnly()` helper.** It strips comments (nested block/KDoc and line comments) while keeping code and string contents. It is aware of strings, raw strings, `${}` templates, char literals and backtick names, so a `//` inside `"https://…"` stays code.
   - Self-tested by the new `codeOnly strips comments and nothing else`.
   - Validated beforehand with a line-for-line Python port: 14/14 edge cases, and over all 218 app Kotlin files.
2. **The P1-A3b test's source checks now run on code only,** so comments can neither fail nor satisfy them. Two invariants were added:
   - `ownerWork` uses its own `FirebaseAuth.getInstance(app)`, never the default;
   - `ApiClient` never signs the personal `auth` in **or out**.
3. **The broken line was replaced** by a dedicated test, `owner work never starts a backend mobile session (P1-A3b)`, which proves the invariant by wiring:
   1. only `MoneyFunctions` names the session callables;
   2. only `AuthRepository` calls `.startMobileSession(`;
   3. every `FirebaseFunctions` instance is default-app (region-only argument);
   4. by reflection, none of `OwnerWorkFirebase`, `WorkFirestore`, `WorkRepository` or `ApiClient` has a constructor parameter or field of type `MoneyFunctions`, `FirebaseFunctions`, `AuthRepository` or `SessionManager`;
   5. none of them names any of these in code.

**Mutation check** (Python port of the same logic, run on copies of the real sources) [RAN]:

| Injected change | Result |
|---|---|
| `ownerWork` calls `money.startMobileSession` | caught |
| `ownerWork` builds its own Functions instance | caught |
| the callable named in `ApiClient` | caught |
| `ownerWork` uses the default auth | caught |
| `ApiClient` signs the personal auth in | caught |
| `ApiClient` signs the personal auth out | caught |
| a call hidden after a URL string | caught |
| comment-only mention | correctly passes |

**Nothing was weakened.** Every previous assertion is kept, now evaluated on code. The one that failed was replaced by stronger ones.

## Verification

| Check | Result |
|---|---|
| Logic, sources and mutations (Python port) | [RAN] all as expected |
| Structure of the edited file | [RAN] 5 block comments, none nested; scanner ends in code state; `/*` and `*/` only inside the intended string literals |
| Whitespace and final newline | [RAN] clean |
| Kotlin compile and Android unit tests | **[NOT RUN]** No Android SDK or Gradle caches in the sandbox |

**Run on your Mac:**
```
cd zipper-app && ./gradlew --no-daemon :app:testDebugUnitTest --tests 'com.zipper.app.data.work.WorkModulesTest' --console=plain
cd .. && bash zipper-app/work-verify.command        # expect 310 tests (308 + 2 new), 0 failures, exit 0
bash tests/run-phase1a-validation.sh                # expect every step exit=0
```
