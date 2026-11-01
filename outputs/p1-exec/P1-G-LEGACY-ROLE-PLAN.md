# P1-G — Legacy role strings: survey and removal plan

**Status:** plan only. Nothing is removed until you approve it (decision 9). No production data was read or written in Phase 1.

## What the legacy strings are

Before departments existed, `crmUsers.role` could be `admin`, `ops`, `tech`, `finance` or `support`. Three layers still handle them, and they disagree:

| Layer | Reads `admin` as | Reads `ops` / `tech` / `finance` / `support` as |
|---|---|---|
| CRM front end (`LEGACY_ROLE_MAP`, `zipper-crm/lib/auth.ts:89`) | `app_admin` | `*_member` |
| Backend (`crm_directory.LEGACY_CRM_ROLE`) | `app_admin` | `*_member` |
| **firestore.rules** | **`isAdmin()` and every department helper** (`isApp`, `isOps`, `isTech`, `isFinance`, `isSupport`, lines 216–243) | that department's helper, plus `isStaff()` |

**Risk.** A document still holding `role: 'admin'` shows its holder an App-admin screen. In Firestore, the same document holds Ops, Finance, Tech and Support authority, and every `isAdmin()` grant (55 of them, 24 on financial paths; see `A2-isAdmin-matrix.md`). That is more authority than anyone sees in the CRM, and none of it shows up in the API's permission table.

## Step 1: Survey (read-only; you run it)

```
cd backend && .venv/bin/python -m scripts.survey_legacy_roles
```

- Prints the count of each `crmUsers.role` value.
- Lists each legacy document by an 8-character fingerprint, alongside its Mongo `staff.role`.
- Never prints a uid, name, email or phone.
- Exit code 3 means legacy strings were found.

## Step 2: Repair the documents (after approval)

For each flagged document, the Mongo `staff` row is the authority:

- **If a staff row exists:** re-mirror it with `crm_directory.mirror(...)`, via the existing `scripts/repair_staff_accounts.py`. That rewrites `role` to the canonical CRM spelling, which is the same role the CRM already shows. Before running it, confirm what that script audits and whether it touches sessions; I have not verified either in Phase 1.
- **If no staff row exists** (an orphan with authority): set `isActive: false`, and report it to an Owner. Never delete.
- **Re-run the survey.** It must exit 0.

## Step 3: Remove the strings from the rules (after step 2 exits 0)

- Drop `'admin'` from `isAdmin()` and from each department helper.
- Drop `'ops'`, `'tech'`, `'finance'`, `'support'` from `isStaff()` and the helpers.
- Add rules tests showing that a document carrying a legacy string gets no staff authority at all.
- Keep `LEGACY_ROLE_MAP` in the CRM for one release, for display only, then remove it.

## Rollback

Step 2 changes only the `role` field, to the value the CRM already displayed, so it is reversible from the survey output. Step 3 is a rules deploy, reverted by redeploying the previous rules file.
