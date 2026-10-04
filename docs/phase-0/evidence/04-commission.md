I have everything needed. Here is the complete documentation of the existing progressive commission system.

---

# ZIPPER PROGRESSIVE COMMISSION SYSTEM — AS IMPLEMENTED

---

## 1. THE SLAB TABLES

**File:** `/Users/soumyaranjansingh/Documents/Projects/zippern/backend/app/services/commission.py`

### Fallback MAIN agency table — `FALLBACK_MAIN_SLABS` (commission.py:551-561)

| Band | `from` (₹) | `to` (₹) | Rate | Rate in basis points |
|---|---|---|---|---|
| 1 | 25,001 | 75,000 | 5 % | 500 |
| 2 | 75,001 | 1,50,000 | 7.5 % | 750 |
| 3 | 1,50,001 | 3,00,000 | 10 % | 1000 |
| 4 | 3,00,001 | 5,00,000 | 14 % | 1400 |
| 5 | 5,00,001 | 8,00,000 | 16 % | 1600 |
| 6 | 8,00,001 | 12,00,000 | 18 % | 1800 |
| 7 | 12,00,001 | 18,00,000 | 21 % | 2100 |
| 8 | 18,00,001 | 25,00,000 | 23 % | 2300 |
| 9 | 25,00,001 | 50,00,000 | 25 % | 2500 |

**MAIN floor = ₹25,001 → `from_minor` 2,500,100 paise** (commission.py:552, `floor_minor` at :340-344).

### Fallback SUB agency table — `FALLBACK_SUB_SLABS` (commission.py:563-573)

| Band | `from` (₹) | `to` (₹) | Rate | Rate in bp |
|---|---|---|---|---|
| 1 | 26,001 | 75,000 | 5 % | 500 |
| 2 | 75,001 | 1,50,000 | 6 % | 600 |
| 3 | 1,50,001 | 3,00,000 | 7 % | 700 |
| 4 | 3,00,001 | 5,00,000 | 8 % | 800 |
| 5 | 5,00,001 | 8,00,000 | 9 % | 900 |
| 6 | 8,00,001 | 12,00,000 | 10 % | 1000 |
| 7 | 12,00,001 | 18,00,000 | 11 % | 1100 |
| 8 | 18,00,001 | 25,00,000 | 12 % | 1200 |
| 9 | 25,00,001 | 50,00,000 | 12.5 % | 1250 |

**SUB floor = ₹26,001 → `from_minor` 2,600,100 paise** (commission.py:564).

Both are declared as "the live tables as at the 2026-08-20 backup" (commission.py:548-549).

### Band 9 is open-ended regardless of its declared `to`
`parse_slabs` sets `to_minor = None` for the last band (commission.py:320-322). `declared_to` is retained for display only. So band 9 applies above ₹25,00,001 (main) / ₹25,00,001 (sub) with **no cap**; the ₹50,00,000 `to` is ignored for matching (commission.py:128-131).

### Effective (matching) bounds, not declared bounds
A non-top band's `to_minor` is **the next band's `from` × 100 − 1**, not its own declared `to` (commission.py:326). So band 1 (main) effectively matches 2,500,100 … 7,500,099 paise, i.e. ₹25,001.00 to ₹75,000.99 — the 99 paise between ₹75,000.00 and ₹75,001.00 stay in the band below (commission.py:108-122, :324-326).

### Where the LIVE tables come from
- Document: Firestore **`appConfig/economy`** (`_read_economy_doc`, commission.py:610-619).
- Block: **`commissionConfig`** (commission.py:653).
- Keys: **`mainAgencySlabs`** and **`subAgencySlabs`** — `CONFIG_KEY` (commission.py:91-94). Selected by `kind_of(partner)`, which returns `SUB` iff `partner["kind"] == "sub_agency"` (commission.py:97-105, `SUB_AGENCY_KIND = "sub_agency"` at :59).
- Edited from the CRM Economy Config page: `zipper-crm/app/economy/config/page.tsx:202,212,230,640` writes those exact two keys. The CRM's own defaults `DEFAULT_MAIN_AGENCY_SLABS` / `DEFAULT_SUB_AGENCY_SLABS` (`zipper-crm/lib/economyConfig.ts:336-359`) are **numerically identical** to the backend fallbacks.
- Bean rate comes from the same document: `giftRates.beanToInrRate` (commission.py:694-695).

### What happens if the live table is malformed
`load_slab_table` calls `parse_slabs(raw)` with **no try/except** — it raises (commission.py:666-667). `MalformedSlabTable` extends `CommissionError` with **`status_code = 503`** (commission.py:77-80); plain `CommissionError.status_code = 400` (:74). Refusal conditions in `parse_slabs`:

- not a list / missing / a str or bytes (commission.py:266-270)
- empty list (:272-276)
- an entry that is not a Mapping (:280-283)
- missing `from`, `to` or `rate` (:284-289)
- a bound that is not a number, is fractional, or is negative — `_rupees` (:208-227)
- a rate that is not a number, is outside 0–100 %, or is finer than whole basis points — `_rate_bp` (:230-249)
- `to < from` (:293-297)
- overlapping bands: `low <= prev_high` (:302-310)
- a real gap: `low != prev_high + 1` (:311-316)

Tables written out of order are sorted, not refused (`parsed.sort(key=lambda t: (t[0], t[1]))`, :300).

### When the fallback is used — three cases only, all `provisional=True`
`_fallback_table` (commission.py:622-634) is returned when:
1. the Firestore read **threw** (`except Exception`, :647-651);
2. `commissionConfig` is absent or not a Mapping (:653-657);
3. the specific key (`mainAgencySlabs`/`subAgencySlabs`) is `None` (:659-664).

A present-but-malformed table does **not** fall back (commission.py:637-644, :666). `SlabTable.source` is `"firestore"` or `"fallback"` (:587-589); the fallback note reads "PROVISIONAL — … must not be paid without confirming the live configuration" (:628-633).

`FALLBACK_BEAN_TO_INR = 0.01` (commission.py:580) — ₹0.01 per bean, i.e. 1 paisa, i.e. 1 lakh beans = ₹1,000.

---

## 2. BAND SELECTION & ARITHMETIC — `commission_for`

**It is PROGRESSIVE — each slice at its own rate.** `RULE` (commission.py:349-356): *"Progressive by band, like income tax. Each slice of the agency's billing is charged at the rate of the band it falls in … No single rate is ever applied to the whole amount."*

> **Documentation note, no judgement attached:** the module docstring at commission.py:8-23 and the comment at `functions/src/index.ts:76-81` both still describe the rule as *flat rate by band*. The executable code, `RULE`, and `backend/tests/test_commission.py` are progressive. test_commission.py:134-140 records the change explicitly: *"It was flat by band … and the owner confirmed against a worked example that it should be progressive."*

### Guards (commission.py:378-391)
- `isinstance(billing_minor, bool) or not isinstance(billing_minor, int)` → `CommissionError` ("Money is never a float here")
- `billing_minor < 0` → `CommissionError`
- `not slabs` → `MalformedSlabTable`

### Below the floor (commission.py:404-420)
`if billing_minor < low:` returns `(0, {...})` with `matched: False`, `band: None`, `rate_percent: "0"`, `effective_rate_percent: "0"`. This is a real zero, never an error.

### The slice loop — the formula lines (commission.py:440-466)

```
for band in slabs:
    if billing_minor < band.from_minor:
        break
    lower_edge = band.from_minor - 1
    ceiling = billing_minor if band.to_minor is None else min(billing_minor, band.to_minor)
    slice_minor = ceiling - lower_edge
    if slice_minor <= 0:
        continue

    product = slice_minor * band.rate_bp
    raw_total += product
```

**The rounding expression (commission.py:466):**

```
commission_minor = (raw_total + 5_000) // BASIS_POINTS_PER_UNIT
```

with `BASIS_POINTS_PER_UNIT = 10_000` (commission.py:126). So: `(Σ(slice_minor × rate_bp) + 5000) // 10000` — integer, half-up to the nearest paisa, **ties to the agency**, applied **once** on the summed products. Per-slice `commission_minor` values in the breakdown are labelled "Indicative only — the rounding happens once, on the total" (commission.py:461-463).

`ROUNDING` text at commission.py:358-365.

`top = next((b for b in slabs if b.contains(billing_minor)), None)` (commission.py:422) is the **highest band reached**, reported under key `band` for backwards compatibility (:486-489). `bands_crossed = len(slices)` (:493). `untaxed_minor = min(billing_minor, low - 1)` (:481).

`effective_rate_percent = (commission_minor × 100 / billing_minor).quantize(Decimal("0.01"))` (commission.py:471-479).

### Fully worked example — MAIN table, billing ₹10,00,000 (1,000,000 rupees = 100,000,000 paise)

This is the owner-confirmed example, written out slice by slice at test_commission.py:101-111.

| Band | Rate | `lower_edge` (paise) | `ceiling` (paise) | `slice_minor` (paise) | slice in ₹ | `product = slice × rate_bp` |
|---|---|---|---|---|---|---|
| 1 | 5 % (500 bp) | 2,500,099 | 7,500,099 | 5,000,000 | 50,000.00 | 2,500,000,000 |
| 2 | 7.5 % (750) | 7,500,099 | 15,000,099 | 7,500,000 | 75,000.00 | 5,625,000,000 |
| 3 | 10 % (1000) | 15,000,099 | 30,000,099 | 15,000,000 | 1,50,000.00 | 15,000,000,000 |
| 4 | 14 % (1400) | 30,000,099 | 50,000,099 | 20,000,000 | 2,00,000.00 | 28,000,000,000 |
| 5 | 16 % (1600) | 50,000,099 | 80,000,099 | 30,000,000 | 3,00,000.00 | 48,000,000,000 |
| 6 | 18 % (1800) | 80,000,099 | **100,000,000** (billing) | 19,999,901 | 1,99,999.01 | 35,999,821,800 |

Band 7 `from_minor` = 120,000,100 > 100,000,000 → the loop `break`s.

`raw_total = 2,500,000,000 + 5,625,000,000 + 15,000,000,000 + 28,000,000,000 + 48,000,000,000 + 35,999,821,800 = 135,124,821,800`

`commission_minor = (135,124,821,800 + 5,000) // 10,000 = 135,124,826,800 // 10,000 = 13,512,482`

**= ₹1,35,124.82** — matching `check("₹10,00,000 — progressive", commission(1_000_000), rupees("135124.82"))` (test_commission.py:111).

`effective_rate_percent` = 13,512,482 × 100 / 100,000,000 = **13.51 %** — below band 6's 18 %.
`untaxed_minor` = 2,500,099 paise = ₹25,000.99.
`bands_crossed` = 6.

The flat-by-band figure would have been ₹1,80,000 — a ₹44,875.18 difference, noted at test_commission.py:139-140.

Second confirmed example: ₹1,00,00,000 billing → **₹23,33,124.75** (test_commission.py:112), 9 bands crossed.

### Exactly AT a slab boundary
At a band's own `from_minor`, that band contributes **exactly one paisa**: `slice_minor = from_minor − (from_minor − 1) = 1` (commission.py:443-445). So everything paid at that point is what the bands below charged, plus `1 × rate_bp` rounded.

Consequences, all asserted:
- **₹25,001 exactly (main floor) → ₹0.** `(1 × 500 + 5000) // 10000 = 5500 // 10000 = 0` (test_commission.py:193). `matched` is `True` and band 1 is named; the figure is zero.
- **₹26,001 → ₹50.00** (test_commission.py:194) — 5 % of the ₹1,000 excess.
- **Sub: ₹26,001 exactly → ₹0; ₹27,001 → ₹50.00** (test_commission.py:209-210).
- **₹75,000 → band index 0; ₹75,000.50 → still band index 0; ₹75,001 → band index 1** (test_commission.py:228-263). No cliff: `commission(75_001) − commission(75_000) < ₹1` (test_commission.py:166-169), and monotonicity is swept over 0–₹30,00,000 in ₹7,919 steps with zero decreases (test_commission.py:173-179).
- Rounding at the boundary: `commission_for(2_500_110, MAIN) == 1` paisa (half rounds up); `2_500_105 → 0`; `2_500_120 → 1` (test_commission.py:319-321).

---

## 3. BILLING BASIS — `agency_billing` and `_aggregate_hosts`

### What is counted — `BILLING_DEFINITION` (commission.py:807-814)
> "An agency's billing for a period is the total its hosts **cashed out** in that period: bean debits on a host's balance whose action is a payout (`payout.execute`, `withdrawal.pay`) and whose `meta.agency_id` names the agency, valued at the bean → INR rate in force."

**It is beans CASHED OUT, not beans EARNED.** `"basis": "host_cashouts"` (commission.py:892).

### `cashout_actions()` (commission.py:816-820)
Returns `[audit.Action.PAYOUT_EXECUTE, audit.Action.WITHDRAWAL_PAY]` → the literal strings **`"payout.execute"`** and **`"withdrawal.pay"`** (`backend/app/core/audit.py:58-59`).

Only `withdrawal.pay` is actually written anywhere in this codebase, by `execute_host_withdrawal` (`backend/app/services/partner_ops.py:4840`). No service writes `payout.execute`; the only other references are the constant lists (`reports.py:662`, `reports.py:2613`).

### `_aggregate_hosts` — the exact Mongo match (commission.py:910-942)

```
match = {
    "holder_type": str(HolderType.USER),      # "user"
    "currency":    str(Currency.BEANS),       # "beans"
    "meta.agency_id": agency_id,
    "at": {"$gte": since, "$lt": until},
    "amount": {"$lt": 0} if negative else {"$gt": 0},
}
if actions: match["action"] = {"$in": list(actions)}
```

- **Holder type:** `user` (`HolderType.USER`, `money.py:38`) — the host, never the agency.
- **Currency:** `beans` (`money.py:32`).
- **Meta field:** `meta.agency_id`.
- **Window:** half-open `[since, until)` — `$gte` / `$lt`.
- Group: `_id: "$holder_id"`, `beans: {"$sum": {"$abs": "$amount"}}`, `movements: {"$sum": 1}`, `last_at: {"$max": "$at"}`; sorted `beans: -1` (commission.py:930-941).

### Two calls, one of which is informational only (commission.py:842-845)
```
cashouts = await _aggregate_hosts(agency_id, since, until, negative=True,  actions=cashout_actions())
earnings = await _aggregate_hosts(agency_id, since, until, negative=False)
```
- **`cashouts`: NEGATIVE movements, action-filtered** → this is billing.
- **`earnings`: POSITIVE movements, NOT action-filtered** → reported as `beans_earned_not_cashed_out` (commission.py:868, :897), never added to billing.

If hosts earned but cashed nothing out, a warning is emitted explaining that the period genuinely bills nothing and "those beans will bill in the period they are cashed out" (commission.py:874-880).

### Beans → rupees
```python
def _beans_to_minor(beans: int, bean_to_inr: float) -> int:
    return int((Decimal(int(beans)) * Decimal(str(bean_to_inr)) * MINOR_PER_MAJOR).to_integral_value())
```
(commission.py:902-907) — `MINOR_PER_MAJOR = 100` (:124). The rate goes through `Decimal(str(...))` so 0.01 means exactly one paisa.

The **agency total is converted once from the agency's total beans** (commission.py:867), so it can never disagree with the sum of per-host figures by a rounding step; per-host `billing_minor` is "for display only" (:857-859).

### `load_bean_rate()` (commission.py:681-707)
Returns `(rate, provisional, note)`.
- Source: `appConfig/economy` → `giftRates.beanToInrRate`.
- Read exception → `(0.01, True, "PROVISIONAL — the bean rate could not be read…")`.
- Missing / non-numeric / `rate <= 0` → `(0.01, True, "PROVISIONAL — giftRates.beanToInrRate is missing…")`.
- Valid → `(rate, False, "₹{rate} per bean, from appConfig/economy.")`.
- A caller-supplied `bean_to_inr` is always `provisional=False` with note "supplied by the caller" (commission.py:836-840).

**"Provisional"** means the figure was computed from a documented fallback rather than from live configuration. Its effects: the note is appended to `warnings` (commission.py:871-873, :997-998); `compute_for_period` sets `"provisional": table.provisional or billing["bean_rate_provisional"]` (:1015); and an **unattended accrual refuses outright** when it is true (see §6).

---

## 4. APPORTIONMENT — `apportion` (commission.py:514-536)

One agency-level figure is split across hosts by **largest-remainder**, weighted by `beans_cashed_out`.

```python
total_weight = sum(weights)
if total_weight <= 0 or not weights:
    return [0] * len(weights)

shares = [total_minor * w // total_weight for w in weights]
remainder = total_minor - sum(shares)
if remainder:
    order = sorted(range(len(weights)),
                   key=lambda i: (-(total_minor * weights[i] % total_weight), -weights[i], i))
    for i in order[:remainder]:
        shares[i] += 1
```

- Each share = exact proportion **floored** (integer `//`).
- The leftover paise go one each to the largest remainders.
- **Tie-break is deterministic and three-level:** largest remainder, then largest weight, then lowest index.
- The parts sum to `total_minor` exactly.

Called from `compute_for_period` with weights `[h["beans_cashed_out"] for h in billing["hosts"]]` (commission.py:977-979). Each host line carries `share_minor`, `share_inr` and a `share_note` stating "the band was chosen by the agency's total, and this is that commission's share, not a separate calculation" (:980-994). Host percentage shown to 3 dp via `_pct` (:1019-1024).

Hosts are pre-sorted `(-beans_cashed_out, host_id)` before apportionment (commission.py:863).

---

## 5. PERIODS

**`MAX_PERIOD_DAYS = 400`** (commission.py:712).

### `resolve_period(period, since=None, until=None) -> (start, end, label)` (commission.py:715-762)
- Bounds are **half-open `[since, until)`** — "so two consecutive periods can never both claim the same cash-out" (:721-722).
- Empty/blank label → `CommissionError` (:730-734).
- If `since` and `until` are both `None`: the label must be datable, else `CommissionError` naming the two accepted forms (:737-744).
- If one of `since`/`until` is given without the other → `CommissionError` "Give both since and until, or neither" (:745-750). **An explicit window overrides the label's own derived window.**
- `start >= end` → `CommissionError` (:752-756).
- `(end - start) > timedelta(days=400)` → `CommissionError` "Commission periods are capped at 400 days" (:757-761).
- The label string is returned unchanged (post-`strip()`) and is what lands in the idempotency key.

### `_utc` (commission.py:765-768)
Naïve datetimes are **assumed UTC** (`replace(tzinfo=timezone.utc)`); aware ones are converted with `astimezone(timezone.utc)`.

### `_window_from_label` (commission.py:771-802) — valid labels
Input is upper-cased and all spaces stripped (`label.upper().replace(" ", "")`).

| Form | Example | Window |
|---|---|---|
| ISO week, contains `-W` | `2026-W33` | `datetime.fromisocalendar(year, week, 1)` at **00:00 UTC**, to `+7 days` → `[Mon 00:00 UTC, next Mon 00:00 UTC)` |
| Calendar month, `YYYY-MM` | `2026-08` | `datetime(2026,8,1, tz=utc)` to `datetime(2026,9,1, tz=utc)`; December rolls to `datetime(year+1,1,1)` |
| anything else | `last-week`, `Q3` | `None` → requires explicit `since`/`until` |

Rejected to `None`: non-integer week/year, `week < 1 or week > 53`, a `ValueError` from `fromisocalendar` (e.g. week 53 in a 52-week year), `month < 1 or month > 12`, non-digit month parts.

### Timezone
**UTC throughout** `commission.py` — `timezone.utc` at :783, :795, :797, :799; `_utc` at :765-768. `SlabTable.fetched_at` is `datetime.now(timezone.utc)` (:592-594).

The business calendar elsewhere is IST — `BUSINESS_TIMEZONE = 'Asia/Kolkata'` (`functions/src/index.ts:3566`), and `releaseBeansForWeek` uses `.timeZone('Asia/Kolkata')` (`functions/src/payouts.ts:86`). The commission window itself is UTC: the weekly Cloud Function states "the ISO week … 00:00 UTC to … 00:00 UTC, start inclusive and end exclusive" (`functions/src/index.ts:975-979`).

`backend/app/services/scheduling.py:1672-1688` (`_weekly_window`) deliberately delegates to `resolve_period` rather than re-deriving the calendar.

---

## 6. ACCRUAL & RECORDING

### The endpoint
**`POST /api/partner-ops/agencies/{agency_id}/commission-accruals`** → 201 Created
(`backend/app/routers/partner_ops.py:1222-1228`; router prefix `/partner-ops` at :79, mounted under `/api` at `backend/app/main.py:75`).

Body `CommissionAccrual` (routers/partner_ops.py:249-263): `period` (1–64 chars, required), `reason` (≤1000), `host_id` (≤200), `since`, `until`, `amount_minor` (optional, `gt=0`). `amount_minor` and `host_id` are "narrowing, never setting".

Read-only twin: **`GET /api/partner-ops/agencies/{agency_id}/commission-preview?period=…`** (routers/partner_ops.py:990-1008).

Authority: `Depends(team_admin_or_accrual_service)` for accrual, `internal_or_accrual_service` for preview (`backend/app/core/deps.py:804-813`). Service identity is `WEEKLY_ACCRUAL`, env `SERVICE_KEY_WEEKLY_ACCRUAL`, header **`X-Service-Key`** (`deps.py:20`, `core/security.py:1338-1351`), allowlisted to exactly two operations `commission.accrue` and `commission.preview` (`security.py:1287-1288`). Its audit actor is `uid: "system:weekly-accrual"`, `role: system`, name "Weekly accrual (automated)".

### Service implementation — `accrue_commission` (`backend/app/services/partner_ops.py:4380-4582`)
1. `_approved_partner(agency_id)` (:4411).
2. `commission_svc.compute_for_period(...)` (:4415-4417); `CommissionError` → `PartnerOpsError`.
3. `lines = [h for h in computed["hosts"] if h["share_minor"] > 0]` (:4423).
4. If `host_id` given, filter to that host and recompute `total_minor` from it (:4425-4435).
5. `total_minor <= 0` → refuse: "a zero movement has no meaning" (:4437-4442).
6. `expected_amount_minor` mismatch → refuse, both figures quoted, nothing credited (:4444-4450).
7. **One movement per host.**

### The ledger movement (partner_ops.py:4463-4480)
- **Holder:** `holder_type = HolderType.AGENCY` (`"agency"`), `holder_id = agency_id`.
- **Currency:** `Currency.COMMISSION` = **`"commission"`**, defined as "agency commission balance, in minor units (paise)" (`money.py:34`). Minor unit = **paise**, 100 per rupee.
- **Amount:** `share` (positive, a credit).
- **Action:** `audit.Action.COMMISSION_ACCRUE` = **`"commission.accrue"`** (`core/audit.py:51`).
- **Idempotency key shape:** **`f"commission:{agency_id}:{line['host_id']}:{span}"`** (partner_ops.py:4471) — `commission:{agency}:{host}:{period}`, where `span = computed["period"]` (the resolved label).
- **Meta:** `host_id`, `period`, `agency_id`, and `commission_breakdown` (the full derivation — `_breakdown_meta`, partner_ops.py:4585-4606: period, since, until, agency_kind, agency_billing_minor, agency_commission_minor, band, rate_percent, floor_minor, rule, rounding, explanation, host_beans_cashed_out, host_share_minor, host_share_note, slab_source, provisional, billing_definition).

`DuplicateMovement` per host → that host is appended to `already` and skipped, not failed (partner_ops.py:4483-4490). If **every** host was already accrued, `PartnerOpsError` "Every host's commission for {span} was already accrued" (:4507-4512) — the phrase the Cloud Function treats as success via `ALREADY_ACCRUED_MARKER = "already accrued"` (routers/partner_ops.py:1028).

A second, agency-level `audit.record(action=COMMISSION_ACCRUE, subject_type="partner", subject_id=agency_id)` carries band, rate, rule, rounding, explanation, slab_source, provisional, the per-host list and `amount_supplied_by_caller` (partner_ops.py:4514-4555).

### Atomicity — `apply_movement` (`backend/app/services/money.py:111-214`)
Balance update + ledger insert + audit entry commit in **one Mongo transaction**; a `DuplicateKeyError` on `idempotency_key` becomes `DuplicateMovement`; a movement of zero raises `ValueError`; a reason is mandatory; a debit below zero raises `InsufficientBalance` unless `allow_negative`.

### Who calls it, and on what schedule
**Cloud Function `weeklyPayoutReportGenerator`** (`functions/src/index.ts:931-947`):
- `.pubsub.schedule('29 18 * * 0').timeZone('UTC')` → **Sunday 18:29 UTC** (= 23:59 IST Sunday).
- `runWith({ secrets: [ACCRUAL_KEY_ENV], timeoutSeconds: 540, memory: '512MB' })`.
- Writes `weeklyPayoutReports/{weekLabel}` **first**, then runs `runWeeklyAccrual(weekLabel, …)` (index.ts:1189-1194), then merges per-agency results back onto the report (:1216-1219).
- Attempts **every approved + active agency**, not only those with eligible hosts (index.ts:1179-1188, agencies queried at :999-1002 on `status == 'approved'` and `isActive == true`).
- Per agency: `GET …/commission-preview?period=…` then `POST …/commission-accruals { period, reason: "Weekly accrual (automated) — {period}" }` (index.ts:570, 657-661).
- Transport constants: `REQUEST_TIMEOUT_MS = 25_000`, `ACCRUAL_BUDGET_MS = 420_000`, `MIN_SERVICE_KEY_CHARS = 32`, `SANITY_BOUND_MINOR = 125_000_000` (index.ts:287-297, 277). The key is scrubbed from every output by `withoutKey()` (:429-432).

### The unattended path's four extra rules — `_accrue_unattended` (routers/partner_ops.py:1081-1219)
1. **Preview first**, then pass the figure back as `expected_amount_minor` (:1106, :1203).
2. **`provisional` → refuse**, outcome `refused_provisional_slabs`, HTTP **409** (:1133-1155).
3. **Sanity bound:** `total_minor > settings.service_accrual_max_minor` → refuse, outcome `refused_sanity_bound`, 409, nothing credited or truncated (:1157-1184). **`service_accrual_max_minor = 125_000_000` paise = ₹12,50,000** (`backend/app/config.py:221`), justified as 25 % of ₹50,00,000 (config.py:210-220).
4. **Zero is an outcome:** `total_minor <= 0` returns `nothing_to_accrue`, not an error (:1186-1193).

Refusals are audited as **`COMMISSION_ACCRUE_REFUSED` = `"commission.accrue_refused"`** (`core/audit.py:56`, written at routers/partner_ops.py:1066). Outcomes enum: `accrued`, `already_accrued`, `nothing_to_accrue`, `refused_sanity_bound`, `refused_provisional_slabs` (:1031-1038), plus `failed` and `not_attempted` on the Cloud Function side (index.ts:299-313).

### Where the agency's commission balance is read from
Mongo `balances`, via `get_balance(HolderType.AGENCY, agency_id, Currency.COMMISSION)` (`money.py:98-108`). Readers: `partners.agency_statement` (`services/partners.py:119-121`), `request_commission_payout` (partner_ops.py:4304-4306), `sub_agencies_of` (`partners.py:252-254`), `partner_ops.py:3352`.

### The Firestore mirror field
**`agencies/{id}.commissionBalance`** — `_FIELD_MAP` entry `("agency", "commission"): ("agencies", "commissionBalance")` (`backend/app/db/firebase.py:189`).

`sync_balance_to_firestore` applies a **delta, not an absolute**: `set({field: firestore.Increment(int(delta))}, merge=True)` (firebase.py:193-247). Mongo is authoritative; a sync failure is logged and left to reconciliation, never rolled back (firebase.py:219-247). Read in the CRM at `zipper-crm/app/page.tsx:241` and typed at `zipper-crm/lib/agencies.ts:69`.

The Cloud Function no longer writes it — `agencies/{id}.update({ commissionBalance: increment(commissionInr) })` was removed (index.ts:71, :1113-1115). `firestore.rules` refuses browser writes to `commissionBalance` (`zipper-crm/lib/firestore.ts:449-450`).

### Paying it out
- `POST /api/partner-ops/agencies/{agency_id}/commission-payouts` → `CardType.COMMISSION_PAYOUT`, `Team.FINANCE`, currency `commission`; refused if `amount_minor > outstanding` (routers/partner_ops.py:962-976, service at partner_ops.py:4296-4329).
- `POST /api/partner-ops/commission-payouts/{card_id}/execute` → **`Depends(require_owner)`**, requires a non-empty `payment_ref`, debits `-amount_minor` with action **`COMMISSION_PAY` = `"commission.pay"`**, idempotency key `card:{card_id}:commission` (routers/partner_ops.py:979-987, service at partner_ops.py:4332-4377).

---

## 7. HOST EARNINGS — tracing a host's money

### Credit (earning)
**Gifts** — `functions/src/gifts.ts:263-270`: on the receiver, `beans += beansCredited`, `totalBeansEarned += beansCredited`, `hostGiftEarnings += beansCredited`, `totalGiftsReceived += quantity`. Then `accrueWeeklyEarning(tx, receiverRef, beansCredited, 'gift')` (gifts.ts:273). A second path at gifts.ts:447.

**Calls** — `functions/src/calls.ts:393-394, 497-498`: `totalBeansEarned += beans` and `hostCallEarnings += beans`.

### `accrueWeeklyEarning` (`functions/src/payouts.ts:51-70`)
```
if (beans <= 0) return
const weekKey = istWeekKey()
tx.set(userRef.collection('weeklyEarnings').doc(weekKey), {
  weekKey,
  beans: increment(beans),
  [`${source}Beans`]: increment(beans),   // giftBeans | callBeans
  released: false,
  updatedAt: serverTimestamp(),
}, { merge: true })
```
`source` is `'gift' | 'call'`. Called **inside the credit's own transaction** so "a credit and its week record commit together" (payouts.ts:46-50).

### `releaseBeansForWeek` (`functions/src/payouts.ts:82-235`)
- `.pubsub.schedule('30 0 * * 1').timeZone('Asia/Kolkata')` → **Monday 00:30 IST**, 31 minutes after the payout period closes at 23:59 Sunday IST.
- `runWith({ timeoutSeconds: 540, memory: '512MB' })`, region `asia-south1`.
- `cutoff = istWeekKey(now − 7 days)`; collection-group query on `weeklyEarnings` where `released == false` **and** `weekKey <= cutoff`, `.limit(500)` (payouts.ts:90-96).
- One read of `appConfig/economy` per run for `giftRates.beanToInrRate`, default **0.01** (payouts.ts:100-104) — "Every statement in this batch is settled at the same rate, which is also what makes a week's figure reproducible."
- `beans <= 0` → mark `released: true` and skip (payouts.ts:111-114).
- Per week, in a transaction: `beansAvailable += beans`; the `weeklyEarnings` doc gets `released: true`, `releasedAt`, and `skippedReason` deleted; a `beanTransactions` row `{type: 'release', amount: beans, reason: 'weekly_release', weekKey, context: 'payout'}`; and a `weeklyStatements/{weekKey}` doc (payouts.ts:131-183).

**The hold:** week N's earnings are released at the end of week N+1 — "A Monday gift waits about thirteen days, a Sunday one about seven" (payouts.ts:21-26).

### What gates release — two gates, both inside the transaction
1. **`userSnap.get('isVerifiedHost') !== true` → `throw new Error('SKIP_UNVERIFIED')`** (payouts.ts:124-126). Comment: "Unverified hosts accrue but are not paid."
2. **`userSnap.get('payoutHold') === true` → `throw new Error('SKIP_HOLD')`** (payouts.ts:127-129).

A `SKIP_` throw rolls the transaction back, so `released` stays `false` and **the next run picks the week up once the block clears** (payouts.ts:78-81, :213-216 `willReleaseWhenCleared: true`). Outside the transaction, the week is marked `skippedReason: 'unverified' | 'dispute_hold'` and a `weeklyStatements/{weekKey}` doc is written with `status: 'held'`, `heldReason`, `beansPending` (payouts.ts:189-225). The comment at :191-195 notes this must be outside the transaction or the held weeks would be invisible to the host.

`isVerifiedHost` is set by host verification approval — `HOST_VERIFICATION_APPROVED` in `core/audit.py:125-128`: *"approval sets `isVerifiedHost`, and the weekly payout run will not release a week for a host without it. This is the moment someone becomes payable."*

### The four bean fields on `users/{uid}`
| Field | Meaning | Written by |
|---|---|---|
| `beans` | total balance — spendable and convertible now | gifts.ts:264, calls.ts, wallet.ts:125 (`-beansAmount` on convert) |
| `beansAvailable` | released, **withdrawable** | payouts.ts:132 (`+beans` on release); wallet.ts:130 (`-fromAvailable` on convert); `firebase.debit_host_beans` on withdrawal execution |
| `totalBeansEarned` | lifetime earned, cumulative | gifts.ts:264,447; calls.ts:393,497 |
| `hostCallEarnings` | lifetime call-only earnings (paired with `hostGiftEarnings`) | calls.ts:394,498 |

`beans − beansAvailable` = pending, with a release date (payouts.ts:28-36: "Three honest numbers beat one that sometimes cannot be withdrawn and does not say why").

`getPayoutStatus` (payouts.ts:245-280) returns `beans`, `beansAvailable`, `beansPending` (sum of unreleased weeks), `pendingWeeks` (each with `weekKey`, `beans`, `skippedReason`), `nextReleaseAt` (next Monday 00:30 IST), `isVerifiedHost`, `payoutHold`.

**Converted beans leave the payout pool** — `convertBeans` (`functions/src/wallet.ts:100-140`) draws down `beansAvailable` first (`fromAvailable = min(beansAmount, available)`), then the oldest unreleased week; otherwise a host could be "paid once in diamonds and again in rupees for the same earning" (wallet.ts:109-117). `weeklyStatements` records `convertedBeans` so the shortfall is explained (payouts.ts:174-177).

### `weeklyEarnings/{weekKey}` — subcollection of `users/{uid}`
Fields: `weekKey`, `beans`, `giftBeans`, `callBeans`, `convertedBeans`, `released`, `releasedAt`, `skippedReason`, `lastCheckedAt`, `updatedAt`.

### `weeklyPayoutReports/{weekLabel}` — top-level (`functions/src/index.ts:1147-1175`)
`weekLabel`, `weekStart`, `weekEnd`, `agencySummaries[]`, `totalAgencies`, `totalEligibleAgencies`, `totalEligibleHosts`, `grandTotalHostPayoutInr`, `commissionAccrued`, `commissionNote`, `commissionAccrualEndpoint`, `accrualPeriodLabel`, `accrualWindowNote`, `accrualWindowStart`, `accrualWindowEnd`, `minHostPayoutInr`, `beanToInrRate`, `economyNote`, `provisional`, `status: 'generated'`, `createdAt`.

Each `agencySummaries` entry (index.ts:1030-1050): `agencyId`, `agencyName`, `agencyType: 'main'|'sub'`, `isForeign` (`agency.paymentType === 'foreign'`), `hostCount`, `eligibleHostCount`, `totalBeansEarned`, `totalHostPayoutInr`, `commissionAccrued`, `commissionOutcome`, `commissionMinor`, `commissionCreditedMinor`, `commissionNeedsPerson`, `commissionNote`. There is deliberately **no local `commissionInr`, no `effectiveCommissionRate`, and no `grandTotalCommissionInr`** (index.ts:1012-1029, :1143-1146).

Report statuses: `generated | submitted | approved | rejected` (`zipper-crm/app/finance/payouts/page.tsx:79-84`). Approval/rejection via `approvePayoutReport` / `rejectPayoutReport` writing `status`, `approvedBy`, `approvedAt`, `rejectedReason` (`zipper-crm/lib/finance.ts:89-108`).

### `hostPayouts` — two collections of the same name
1. **Subcollection** `weeklyPayoutReports/{weekLabel}/hostPayouts/{agencyId}_{hostUid}` (index.ts:1099-1107): `agencyId`, `agencyName`, `hostUid`, `hostName`, `weekBeans`, `hostPayoutInr`, `weekLabel`, `weekStart`, `weekEnd`, `status: 'pending'`, `eligible: true`, `createdAt`.
2. **Top-level** `hostPayouts`, queried by `reportId` (`zipper-crm/lib/finance.ts:79-87`, `HOST_PAYOUT_LIMIT = 1000`).

`payouts.ts:149-155` names this collision explicitly and is why host statements went to `weeklyStatements` rather than `hostPayouts`.

`onPayoutApproved` (index.ts:2008-2075) fires on `weeklyPayoutReports/{weekLabel}` update to `status == 'approved'` and writes **approval markers only** — `lastPayoutApprovedAt`, `lastPayoutApprovedWeek` — plus one notification per agency owner. "No balance is written here (spec 4.4.7)… `beans` / `weeklyBeansEarned` stay exactly as the host earned them until the payout is executed on the money board" (index.ts:2045-2047).

### Every eligibility rule, with evidence
| Rule | Value / condition | Evidence |
|---|---|---|
| Weekly minimum payout | `hostPayoutInr < economy.minHostPayoutInr` → excluded from the report | index.ts:1091-1093 |
| …its source | `appConfig/economy.weeklyMinPayoutInr` | index.ts:189, :219-224 |
| …its fallback | **₹2,000** (`FALLBACK_MIN_HOST_PAYOUT_INR = 2_000`) | index.ts:158 |
| Backend equivalent | `min_payout_minor >= th.min_payout_minor` | reports.py:3975 |
| Backend fallback | `FALLBACK_MIN_PAYOUT_INR * 100` paise, marked PROVISIONAL | reports.py:3176-3185 |
| Second (bean) condition | `beans >= th.min_beans`, applied **only if configured** | reports.py:3984-3991 |
| …current state | **NOT CONFIGURED.** "The owner has described a second rule — 'one lakh beans in a week' — and it exists nowhere in this system"; set `appConfig/economy.{BEAN_THRESHOLD_KEYS[0]} = 100000` to enable | reports.py:3220-3231 |
| Verification | `isVerifiedHost !== true` → week skipped, not lost | payouts.ts:124-126 |
| Payout hold | `payoutHold === true` → week skipped, not lost | payouts.ts:127-129 |
| Release timing | one week in arrears; `weekKey <= cutoff` where cutoff = now − 7 days | payouts.ts:90-95 |
| Withdrawal ceiling | `beans > beansAvailable` → refused at request | partner_ops.py:4706-4712 |
| …re-checked | re-checked inside a Firestore transaction at execution | partner_ops.py:4675-4679, :4800-4809 |
| App-side minimum | `MIN_WITHDRAWAL_BEANS = 100_000` beans = ₹1,000 at `BEANS_PER_RUPEE = 100`; `canWithdraw(beans) = beans >= 100_000` | `zipper-app/.../EconomyEngine.kt:78-114` |
| Eligibility window vs commission window | eligibility = rolling 7 days ending when the job fired; commission = the ISO week from the label. "The two do not overlap and are not meant to" | index.ts:962-991 |
| Eligibility explanation | a host below the line always gets the figure and the exact shortfall, never a bare "no" | reports.py:3965-4000 |

---

## 8. SALARY — the host salary flow

### Collection: `salaryRequests` (top-level Firestore)

**Document shape** (`zipper-crm/app/agencies/[id]/salary/Client.tsx:20-36`):
`id`, `agencyId`, `hostUid`, `hostName`, `periodStart`, `periodEnd`, `beansEarned`, `amountInr`, `notes?`, `status`, `createdAt?`, `approvedAt?`, `paidAt?`, `distributedAt?`, `utrNumber?`.

**Status values:** `'pending' | 'approved' | 'paid' | 'distributed' | 'rejected'`.

### Who raises — the AGENCY
`zipper-crm/app/agency-dashboard/page.tsx:938-989` — `SalaryRequestForm` does `addDoc(collection(db, 'salaryRequests'), { agencyId, hostUid, hostName, periodStart, periodEnd, beansEarned: Number(beansEarned), amountInr: Number(amountInr), notes, status: 'pending', createdAt: serverTimestamp() })`.

Validation is client-side only: a host must be selected, both period dates set, and both `beansEarned` and `amountInr` entered (page.tsx:960-963). **Both figures are typed in by the agency** — nothing derives them from the ledger.

`firestore.rules` pins creation: `status` must be `'pending'` and the creator must be Finance, Admin, or an agency CRM user whose own `crmUserAgencyId()` equals the document's `agencyId`.

### Who approves — STAFF
`/agencies/[id]/salary` page (`zipper-crm/app/agencies/[id]/salary/Client.tsx`):
- **Page access:** `canAccess(crmUser, ['superadmin', 'app_admin'])` (:77, gate at :174-182).
- **Action access:** `canAccess(crmUser, ['finance_admin', 'superadmin'])` (:76, used at :288).
- `handleApprove` → `{ status: 'approved', approvedAt: serverTimestamp() }` (:113-122), shown only when `status === 'pending'`.
- `firestore.rules` allows update by `isFinance() || isSuperAdmin()`, explicitly narrowed from `isAdmin()` (which matched `.*_admin`) because "marketing_admin and support_admin could mark a host payout approved and paid from a browser".

### Who pays — STAFF, with a mandatory reference
`handleMarkPaid` (Client.tsx:124-138) → `{ status: 'paid', paidAt: serverTimestamp(), utrNumber: utr.trim() }`. **A UTR / transaction reference is required** — empty input gives "Enter UTR / transaction reference." (:126). The modal labels it "UTR / Transaction Reference *" with placeholder "e.g. HDFC1234567890 or UPI ref" (:354-362). Available only when `status === 'approved'`.

### Who closes it — the AGENCY
`handleMarkDistributed` (`agency-dashboard/page.tsx:2179-2192`) → `{ status: 'distributed', distributedAt: serverTimestamp() }` — the agency confirming it passed the money to the host. `firestore.rules` pins this third clause to `hasOnly(['status', 'distributedAt'])` with `status == 'distributed'`, by the agency CRM user whose `crmUserAgencyId()` matches.

There is also a staff-side `handleReject` button labelled **"Distributed"**, shown when `status === 'paid'`, that writes `{ status: 'rejected' }` (Client.tsx:140-159). Its comment explains the value was changed from `distributed` to `rejected` because a refusal rendered identically to a completed payment.

### Period
**Free-text `periodStart` / `periodEnd` strings** chosen by the agency on the form (`agency-dashboard/page.tsx:954-955`, displayed as `{req.periodStart} → {req.periodEnd}` at Client.tsx:272-274). Not an ISO week, not a calendar month, not resolved through `resolve_period`.

### Denomination
**Rupees** — `amountInr: number` (Client.tsx:28), formatted with `Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 })` (:46-48). Not minor units. `beansEarned` is carried alongside as a reference figure (:27, displayed at :275-277) but the payable amount is `amountInr`.

### Does it touch beans?
**No.** Across the whole flow — create at `agency-dashboard/page.tsx:970-981`, approve at `Client.tsx:116-118`, pay at `:129-131`, distribute at `page.tsx:2181-2184`, reject at `:155` — every write is to the `salaryRequests` document only. No `users/{uid}.beans`, no `beansAvailable`, no `beanTransactions`, no Mongo ledger movement. There is **no Cloud Function trigger on `salaryRequests`** (no match in `functions/src/*.ts`).

### Backend salary functions
**There are no `salary_request` functions in `backend/app/services/*`.** The card type exists — `CardType.SALARY_REQUEST = "salary_request"` (`backend/app/services/cards.py:55`) — but nothing in the backend raises or executes one. Every other reference is read-only classification:
- `reports.py:659` and `reports.py:5059` — included in the payout card-type list.
- `reports.py:424-427` — the single payout definition: *"cards in stage 'executed' with executed_at inside the period, of a payout type (commission_payout, subagency_payout, host_withdrawal, weekly_payout, salary_request)"*.
- `reports.py:5096-5101` — the `host_payouts` expenditure line: *"Executed cards of type host_withdrawal, weekly_payout or salary_request with executed_at in the period."*
- `cards.py:142-147` — `salary_request` is **excluded** from `PARTNER_SUBJECT_CARD_TYPES`, so it is staff-only and never appears on a partner's board.
- `reports.py:4944-4949` — "NOT the card type `salary_request`, which pays HOSTS and is already counted under host payouts above — the two have similar names and are different money" (distinguishing it from `ExpenseCategory.STAFF_SALARIES`). Pinned by tests at `backend/tests/test_expenses.py:674` and `backend/tests/test_weekly_business.py:842`.

`backend/app/services/staff.py` salary handling (`salary_minor`, `salary_currency`, `STAFF_EMPLOYMENT_CHANGED`) is **employee** pay, not host salary.

### Is host salary included in the commission billing basis?

**NO.** Evidence, both directions:

1. **The basis is action-filtered to two actions.** `cashout_actions()` returns exactly `["payout.execute", "withdrawal.pay"]` (commission.py:816-820), and `_aggregate_hosts` applies `match["action"] = {"$in": list(actions)}` (commission.py:927-928). A salary payment would have to carry one of those two actions to count.

2. **The salary flow writes no ledger row at all.** It is Firestore-only (evidenced above). `_aggregate_hosts` reads the Mongo `C.LEDGER` collection (commission.py:942). A `salaryRequests` document is invisible to it — no `holder_type`, no `currency: beans`, no `meta.agency_id`, no `action`.

3. **The reports treat them as separate money.** `reports.py:5096-5101` counts an **executed `salary_request` card** under `host_payouts` expenditure, a card-based, cash-basis P&L line. Commission billing is a ledger-movement basis over `meta.agency_id`. They are different queries over different stores.

4. **Only `withdrawal.pay` is ever written**, by `execute_host_withdrawal` (partner_ops.py:4840), and the comment at partner_ops.py:4822-4828 states that shape is "exactly the shape `commission.agency_billing` aggregates on".

So: host salary paid through `salaryRequests` **produces no commission for the agency**. (The surrounding comment at partner_ops.py:4636-4646 describes the same structural fact for the pre-withdrawal era: "A host's earnings were therefore paid in cash — by bank transfer, outside this system… No withdrawal was ever executed, so no such row existed, so every agency billed nothing.")

---

## 9. WITHDRAWALS & PAYOUTS

### A. `withdrawalRequests` (Firestore, host-raised)

**Shape** — `WithdrawalRequest` (`zipper-crm/lib/firestore.ts:523-550`):
`id`, `uid`, `hostName`, `hostPhotoUrl`, `phoneNumber`, `agencyId`, `beans`, `inrAmount`, `status`, `paymentType?: 'india'|'foreign'`, `bankName?`, `accountNumber?`, `ifscCode?`, `upiId?`, `binanceUid?`, `requestedAt`, `processedAt`, `processedBy?`, `rejectionReason?`, `notes?`, `utrNumber?`, `transactionRef?`, `transactionProofUrl?`, `transactionDate?`, `paymentMode?`.

**State sequence:** `pending → approved → paid`, with `rejected` as a terminal branch (`'pending' | 'approved' | 'rejected' | 'paid'`, firestore.ts:532; the page docstring states "pending → approved → paid, with a required reason on a rejection", `zipper-crm/app/finance/withdrawals/page.tsx:5-9`).

**Functions** (`zipper-crm/lib/firestore.ts`):
| Function | Line | Writes |
|---|---|---|
| `getWithdrawalRequests(status?)` | 552-558 | reads; `orderBy('requestedAt','desc')`, `limit(100)` |
| `approveWithdrawal(id, notes?)` | 560-567 | `status:'approved'`, `processedAt`, `processedBy:'Admin'`, `notes?` |
| `markWithdrawalPaid(id, proof)` | 578-585 | `status:'paid'`, `processedAt`, `processedBy:'Admin'`, plus the `PaymentProof` spread |
| `rejectWithdrawal(id, reason)` | 587-594 | `status:'rejected'`, `rejectionReason`, `processedAt`, `processedBy:'Admin'` |

`PaymentProof` (firestore.ts:569-576): `utrNumber?`, `transactionRef?`, `transactionProofUrl?`, `transactionDate?`, `paymentMode?`, `notes?`. The proof screenshot goes through `UploadField` (withdrawals/page.tsx:28).

**Payment modes** (withdrawals/page.tsx:71-74): `NEFT`, `IMPS`, `UPI`, `Binance`, `USDT TRC20`, `USDT ERC20`, `Bank Transfer`; `FOREIGN_MODES = ['Binance', 'USDT TRC20', 'USDT ERC20']`.

**Who approves:** `firestore.rules` — create by the host themselves (`hostUid == request.auth.uid` **and** `status == 'pending'`) or by Finance/SuperAdmin; **update by `isFinance() || isSuperAdmin()` only**; delete by SuperAdmin only. Read by Finance, Admin, or the host whose `hostUid` matches. The rules comment records that pinning only `hostUid` had allowed a host to file their own request already marked `approved` or `paid`, and that `isAdmin()` had let every department admin approve one. CRM page gate: `FINANCE_ROLES = ['superadmin', 'finance_admin']` (withdrawals/page.tsx:66), with `finance_member` deliberately excluded.

**Queue cap:** `QUEUE_LIMIT = 100` (withdrawals/page.tsx:69) — stated rather than implied complete.

### B. The money-board host withdrawal (Mongo, the authoritative path)

**`request_host_withdrawal`** (`backend/app/services/partner_ops.py:4664-4761`):
- Reason required (`_require_reason`), beans must be positive (`_positive`), host uid required.
- Reads `firebase.read_host_wallet(uid)`; an unreadable wallet refuses outright — "there is no figure to check this withdrawal against" (:4688-4696). A missing `users` document refuses (:4698-4703).
- **Ceiling:** `beans > wallet["beans_available"]` → refused, with the release explanation (:4705-4712).
- Raises `CardType.HOST_WITHDRAWAL`, `Team.FINANCE`, `currency: beans`, `subject_type: user`, `subject_id: uid`; payload carries `beans`, `host_id`, `host_name`, `agency_id`, `beans_available_at_request`, `is_verified_host` (:4729-4758).
- **Two warnings, not blocks:** no `agencyId` on the user document → "this payout will bill no agency and no commission will be earned on it"; `not is_verified_host` → the weekly release will not release another week (:4715-4727).

**`execute_host_withdrawal`** (partner_ops.py:4764-4915):
- **A payment reference is mandatory** — "a payout with no reference cannot be reconciled against the bank" (:4787-4792).
- `_card_ready(card_id, CardType.HOST_WITHDRAWAL)` — only an `approved` card is accepted, so a `failed` card can never be retried (:4783-4785).
- **Step 1, Firestore first:** `firebase.debit_host_beans(host_uid, beans)` under a Firestore transaction that re-reads `beansAvailable`. `HostBeansUnavailable` → card marked failed with both figures named (:4799-4818). Order is justified at :4769-4785: Mongo-first would leave "a ledger saying the host was paid while the beans are still in their wallet".
- **Step 2, the ledger row:** `holder_type: user`, `holder_id: host_uid`, `currency: beans`, `amount: -beans`, `action: WITHDRAWAL_PAY`, `idempotency_key: card:{card_id}:withdrawal`, meta `{payment_ref, agency_id, host_id, beans_available_before, beans_before}`, `allow_negative=True`, `replica_applied_by_caller=True` (:4834-4861). This is the row commission billing aggregates on.
- A step-2 failure leaves the card `failed` with `firestore_debited` and `needs_manual_correction: true` (:4862-4888).
- The card is updated with `payload.payment_ref`, `payload.paid_at`, `payload.agency_id` (:4891-4900).

`replica_applied_by_caller` exists so `apply_movement` does not debit `users/{uid}.beans` a second time (`money.py:71-86`, partner_ops.py:4648-4661).

### C. Sub-agency payouts — two legs
`request_subagency_payout` (partner_ops.py:4923-…), `execute_subagency_payout` (:5015), `confirm_subagency_leg` (:5115), `open_subagency_payouts` (:5170). Leg 1: Zipper pays the main agency. Leg 2: the main agency pays the sub, and an owner records it. **The payout is not closed until leg 2 is confirmed** — "otherwise money leaves us and the sub never sees it, with nothing on record showing that" (:4928-4934). Idempotency key `card:{card_id}:subagency` (:5046). Actions `SUBAGENCY_PAID_PARENT` / `SUBAGENCY_PARENT_PAID_SUB` (`core/audit.py`). Refused if it would overpay: "This sub-agency has {outstanding} in commission outstanding" (:4952). Open legs surface on the sub's own row in `agency_week` with a warning (reports.py:4039-4052, :4179-4191).

### D. The money-board payout card types
`PAYOUT_CARD_TYPES` (`zipper-crm/app/finance/payouts/page.tsx:66-72`, mirrored at `zipper-crm/app/finance/page.tsx:72` and `backend/app/services/reports.py:5054-5060`):
`commission_payout`, `subagency_payout`, `host_withdrawal`, `weekly_payout`, `salary_request`.

### E. Minimum / maximum / fees / KYC
- **Minimum (app-side):** `MIN_WITHDRAWAL_BEANS = 100_000` beans = ₹1,000 at `BEANS_PER_RUPEE = 100`; `beansToRupees` returns 0 below it (`zipper-app/.../EconomyEngine.kt:81-114`).
- **Weekly eligibility minimum:** `appConfig/economy.weeklyMinPayoutInr`, fallback ₹2,000 (index.ts:158).
- **Maximum:** none on a host withdrawal beyond `beansAvailable` (partner_ops.py:4705-4712). The only ceiling in the system is `service_accrual_max_minor = ₹12,50,000`, which bounds an **unattended commission accrual**, not a payout.
- **Fees:** `commissionConfig` carries `binanceFeePercent` and `govtTaxPercent`, and `reports.py:4930-4942` states explicitly that both are **quoting rates that were never a booked cost** — the booked cost is whatever left the business on a `BINANCE_FEES` / `TAXES` expense card. **No fee is deducted from a host withdrawal anywhere in the implementation.**
- **KYC:** there is no field or check named `kyc` in this flow. The equivalent gate is `isVerifiedHost`, which blocks **release** into `beansAvailable` (payouts.ts:124-126) and therefore caps what can be withdrawn. `core/audit.py:125-128` names verification approval as "the moment someone becomes payable" and cites AML: "Sending money to an identity nobody has confirmed is the exposure India's AML rules exist for" (payouts.ts:121-123). `HOST_PENDING_CHANGES_APPLIED` exists as a separate audit action so "a redirected payout" cannot hide inside an old approval (`core/audit.py:114-120`).
- **Payment proof capture:** `PaymentProof` on `withdrawalRequests` (utrNumber, transactionRef, transactionProofUrl, transactionDate, paymentMode, notes) via `markWithdrawalPaid`; and a mandatory `payment_ref` on both `execute_host_withdrawal` and `execute_commission_payout`, stored on the ledger movement's `meta.payment_ref` and on `payload.payment_ref` / `payload.paid_at`.

---

## 10. COMMISSION ADJUSTMENTS / REVERSALS

**NOT FOUND.**

Exhaustive search over `backend/app`, `functions/src`, `zipper-crm/lib`, `zipper-crm/app` for `commission_revers`, `reverse_commission`, `commission_adjust`, `adjust_commission`, `COMMISSION_REVERS`, `COMMISSION_ADJUST`, `clawback`, `claw back` returned **zero matches**.

Supporting evidence that no such path exists:
- The commission audit vocabulary is exactly three actions: `COMMISSION_ACCRUE`, `COMMISSION_ACCRUE_REFUSED`, `COMMISSION_PAY` (`core/audit.py:51-57`). There is no reversal action.
- `apply_movement` rejects `amount == 0` (`money.py:117-118`) and rejects any movement taking a balance below zero unless `allow_negative=True` (`money.py:136-139`). `allow_negative=True` appears **once** in the entire services layer, at `partner_ops.py:4858` — the host bean withdrawal, not commission.
- The audit module has no update or delete path at all: "Nothing in this module updates or deletes. There is deliberately no such function — not even for owners" (`core/audit.py:7-9`).
- `accrue_commission` only ever applies **positive** movements (`amount=share`, where `share > 0` by the `lines` filter at partner_ops.py:4423).
- The only negative movement on `Currency.COMMISSION` is `execute_commission_payout` (`amount=-amount_minor`, action `COMMISSION_PAY`, partner_ops.py:4353-4354) — a settlement, bounded by `amount_minor > outstanding` refusal at :4307-4311, i.e. it cannot drive the balance negative.
- The idempotency key `commission:{agency}:{host}:{period}` makes re-running a period a no-op per host (partner_ops.py:4471, :4483-4490), so there is no "re-accrue at a corrected figure" path either.

The nearest adjacent mechanisms, none of which adjust an accrued commission:
- `COMMISSION_ACCRUE_REFUSED` — records an accrual that was **declined before anything was credited** (`core/audit.py:52-57`).
- `expected_amount_minor` mismatch — refuses **before** crediting (partner_ops.py:4444-4450).
- `reconcile.py` / `find_replica_drift` — reports Mongo↔Firestore divergence; "a drift entry means Mongo is right and Firestore is stale — never the other way round" (`money.py:288-295`).
- `partner_ops.py:4884` `needs_manual_correction: True` — on a *host withdrawal* half-failure, not commission.

---

## 11. STATEMENTS & REPORTS

### The weekly partner statement
**Job:** `scheduledPartnerStatements` (`functions/src/index.ts:3869-3879`)
- **Schedule:** `.schedule('0 9 * * 1').timeZone('Asia/Kolkata')` → **Monday 09:00 IST**, "ninety minutes after the business report, so the owners have seen the week before the partners are written to about it" (index.ts:3862-3863).
- Calls `POST /api/notifications/jobs/partner-statements?cadence=weekly&period=last-week` (index.ts:3876).
- `period=last-week` is "a name, not a date range. The backend resolves it through the same call that decides which days agency commission is billed over, so a statement and the commission on it cannot cover different days. This function does no calendar arithmetic at all, which is the point" (index.ts:3865-3868).

**Service:** `scheduling.partner_statements()` (`backend/app/services/scheduling.py:1126-1270`), reached via `backend/app/routers/notifications.py:208-263`.
- Defaults: `cadence="monthly"`, `spec="8A.3.10"`, `kinds=("agency","seller")`, `limit=1000`; `since`/`until` default to `last_month()` (:1150-1151).
- Recipients come from `notify.approved_partners(kind)` and `notify.partner_recipient(partner)` — **never from the request** (:1169, :1191; `security.py:1362-1368`).
- Section body is `rpt.agency_statement_range(...)` for agencies, `rpt.seller_statement_range(...)` for sellers (:1182-1189) — "the statement a partner is emailed and the statement a staff member pulls over HTTP are the same object" (:1140-1141).
- **Dedupe key:** `statement:{kind}:{partner_id}:{cadence}:{period_key}` where `period_key = f"{day_key(since)}_{day_key(until - 1s)}"` (:1154, :1226). `email_deliveries.dedupe_key` is unique, so the sweep is idempotent (:1285-1289).
- Sensitivity `PARTNER_OWN`, identity `TRANSACTIONAL`, **no unsubscribe header** — "their account record and the template says it is not optional mail" (:1225, :1234-1238).
- Subject: `Your Zipper statement — {label}`.
- Intro text: "generated from the same ledger the business runs on. If a figure here does not match your own record, reply to this email with the reference and we will show you the entries behind it — you should never have to ask what you are owed (0.2.2 / 9.16)" (:1193-1199).
- Historical periods reproduce exactly because the report reads the ledger entries rather than re-deriving from today's rates (:1143-1145).
- Monthly counterpart: `scheduledMonthlyReports`, `.schedule('0 8 1 * *')` Asia/Kolkata → **08:00 IST on the 1st** — "a different email from Monday's weekly one — different cadence, different period, different dedupe key — and is the record their accountant files" (index.ts:3884-3894).
- Related sweeps (`scheduling.py:1371-1409`): `_payout_cards` finds cards with `currency: "commission"` and `subject.type: "agency"`, driving `send_payout_approved` (amount, period, expected date) and the paid/UTR follow-up. `_sweep_deactivations` prints "Commission still owed to you" in paise (:1343-1366).

### The report functions in `backend/app/services/reports.py`

**Agency section — `agency_week(period_label, since, until, rates)`** (reports.py:4006-4223+)
- Title: `"Agencies — billing, band and commission"` (:4195).
- Calls `com.compute_for_period(agency_id, period_label, since, until, partner)` **once per agency — the same call the accrual makes** — "so what this report shows and what the agency is actually credited cannot drift apart" (:4014-4017, :4091-4093).
- A `CommissionError` on one agency produces **one row that says so**, with every money column `None` and `"why": f"NOT COMPUTED — {exc}"` — "That row shows unknown, not zero" (:4094-4117).
- **18 columns** (:4197-4216): agency_id, agency_name, agency_type, parent_agency_name, paid_via, status, hosts_cashed_out, beans_cashed_out, billing_inr_minor, billing_inr, band, rate_percent, commission_inr_minor, commission_inr, earns_commission, why, open_payment_legs, open_leg_inr_minor.
- `band` is the band `label` when matched, else `f"below the {rupee_text(floor_minor)} floor"` (:4138-4140). `why` is the engine's own `breakdown["explanation"]` (:4145).
- `paid_via` distinguishes main ("we pay it directly"), sub (two legs named), and a sub with no parent ("it cannot be paid") (:4061-4073).
- Warnings: any provisional agency (:4150-4157); an empty partner collection (:4158-4163); orphan sub-agencies listed by name (:4165-4177); open leg-2 payouts with their total (:4179-4191).
- Totals include `agencies_on_file`, `main_agencies`, `sub_agencies`, `agencies_earning_commission` (:4218-4223).

**Host section — `host_week(since, until, rates, thresholds)`** (reports.py:3716-…)
- Title: `"Hosts — work, payout due, and eligibility with the reason"` (scheduling.py:1898-1901).
- Beans from the Mongo ledger via `_host_bean_activity` (:3734, defined :3336-3382) — `beans_earned` = positive movements; `beans_cashed_out` = negative movements whose action is in `BEAN_PAYOUT_ACTIONS = [PAYOUT_EXECUTE, WITHDRAWAL_PAY]` (reports.py:662). Attribution is by `meta.agency_id` — "the field the commission engine bills on … one attribution rule, not two" (:3339-3341).
- Gifts and call time from Firestore, each fetched separately "so that losing one does not cost the others, and a column that could not be read is None with a warning rather than zero" (:3725-3728, :3741-3776).
- Per row: host_id, host_name, agency_id, agency_name, agency_type, parent_agency_id, parent_agency_name, paid_via, beans_earned, beans_cashed_out, bean_balance_after, gifts_received, gift_diamonds_received, gift_beans_earned, calls_received, call_minutes, … (:3827-3846).
- `_host_eligibility(beans, payout_minor, th)` (:3965-4000) — pure and directly testable; returns `(bool, str)` and **always states the figure and the shortfall**: "₹X earned against a ₹Y weekly minimum — ₹Z short".
- `thresholds_from_config` / `load_thresholds` (:3153-3240) supply `min_payout_minor` from `weeklyMinPayoutInr` and the optional `min_beans`.

**Supporting report functions:**
- `agency_statement_range(agency_id, since, until, rates)` (:1748-1845) — the emailed statement. Uses `_window_statement` (:1682-1745) for opening/closing balance (opening taken from the first in-window movement's `balance_before`, or the last prior movement's `balance_after` — "that is what makes a March statement still say what it said in March"). Groups the ledger by `action` and reports `opening_outstanding_minor`, `commission_earned_minor`, `commission_paid_minor`, `commission_outstanding_minor` plus `_inr` twins.
- `seller_statement_range` (:1848) — the seller equivalent.
- `payout_summary` (:1245), `_executed_payouts` (:834), `_commission_movement` (:1290), `all_partners_summary` (:1961), `profit_statement` (:4893), `_host_earnings` (:7086), `_open_subagency_legs` (:3590), `_partner_index` (:3385).
- `DEFINITIONS` (:415-441) carries the single canonical definitions of **revenue**, **payout** ("One definition, replacing the four that disagreed (10.7)"), **commission** ("Accrued = positive movements on an agency's commission balance in the period. Paid = negative movements. Amounts in the commission currency are minor units (paise)"), and **margin** (`net_margin = revenue − payouts − (commission accrued − commission paid)`).

**Weekly business report:** `scheduledWeeklyBusinessReport`, `.schedule('30 7 * * 1')` Asia/Kolkata → **Monday 07:30 IST** (index.ts:3848-3851), running `scheduling.weekly` (:1816) over `_weekly_window(label)` — which delegates to `commission.resolve_period` (:1672-1688). It stores an immutable document in `C.WEEKLY_BUSINESS_REPORTS` keyed `{label}` or `{label}#r{n}` (:1699-1700) — "written once and never updated. Re-reading this week later gives these figures, which is what makes it a record rather than a recomputation" (:1911-1915). Report label is always the week *before* the run week, so each ISO week is reported exactly once after it closes (:1660-1669).

### The CRM component: `CommissionDerivation`
**File:** `/Users/soumyaranjansingh/Documents/Projects/zippern/zipper-crm/app/agency-dashboard/CommissionDerivation.tsx`
**Consumed by:** `/Users/soumyaranjansingh/Documents/Projects/zippern/zipper-crm/app/agency-dashboard/AgencyMoney.tsx`

Props: `basis: CommissionBasis | null`, `basisError: string | null`, `rule: string`, `period: Period`, `loading: boolean`. Fed from `agency_statement`'s `commission_basis` / `commission_basis_error` / `commission_rule` (`backend/app/services/partners.py:59-61`, :152-154).

**Nothing is recomputed in the browser** (:12-16): "The commission engine (backend/app/services/commission.py) writes every sentence and every bound, and this file lays them out… a browser that does its own slab arithmetic can disagree with what is actually paid, and the CRM has already been down that road once."

What a partner sees, section header **"How your commission is worked out"**:

- **Refusal state** (:62-97) — when `basis` is null, the server's own `basisError` sentence is printed, with: "No figure was produced, so none is shown. This is not a commission of zero — a zero is what you see when a real billing total falls below the floor, and that is a different sentence. Your ledger below is unaffected: it records what actually moved."
- **Subtitle** (:114-117) — `Period {basis.period} · {since} → {until} · {billing.bounds}` ("[since, until) — start inclusive, end exclusive").
- **Lifetime notice** (:120-132) — when the period mode is lifetime, it says the derivation covers the current week instead, "Banding a lifetime total would pick a top band no single week ever earned."
- **Provisional banner** (:134-146) — "These rates are provisional, not the live table," plus `table.note`.
- **Step 1 — "What your hosts cashed out in this period"** (:149-182): beans cashed out, rate applied (`₹{bean_to_inr} per bean`, amber when provisional), billing in INR, `bean_rate_note`, the server's `billing.definition`, and — when non-zero — beans earned but not cashed out with "those are not billing yet — they bill in the period they are actually paid out."
- **Step 2 — "The floor — ₹X of billing"** (:185-236): below the floor, a red panel with billing, the floor (labelled sub-agency or main agency), the exact shortfall, and how many more beans to cash out to reach band 1; above it, a green panel with the headroom and "Your hosts are always paid their own payout in full either way — the floor applies to agency commission and to nothing else."
- **Step 3 — "The band your billing selects, and the rate it pays"** (:239-268): band number, rate %, commission for the period, the band `label`, then three verbatim server strings — the one-sentence explanation, `RULE`, and `ROUNDING`.
- **Warnings** (:270-282) — each `basis.warnings` entry rendered.
- **`SlabTable`** (:347-444) — **the whole table, not just the matched band** ("Spec 0.2.1 — no private rates, and an agency should be able to see what the next band pays"). Columns Band / Billing from / Billing to / Rate; the matched row highlighted and tagged "yours", the next row tagged "next"; `to_minor === null` renders as "no upper limit"; caption "Each slice of your billing is charged at its own band's rate — progressive, like income tax. No single rate is applied to the whole amount."; and a footer naming the next band's floor, rate, and exactly how much more billing it needs.
- **`HostShares`** (:453-523) — "Which hosts produced it": per host the id, the server's `share_note`, beans cashed out, their billing, their share; empty state reads "This is an emptiness, not a failure — the derivation ran and found nothing in the window." Caption: "Shares are Indian Rupees (INR) and add up to {total} exactly — the leftover paise go to the largest remainders, so nothing is lost in the split."

---

## Items not determined from implementation

1. **Whether `payout.execute` is ever written in production.** The action is in `cashout_actions()` and `BEAN_PAYOUT_ACTIONS`, but no service in this repo emits it. Only `withdrawal.pay` has a writer (partner_ops.py:4840).
2. **How `withdrawalRequests` documents are created.** No creator was found in `zipper-app`, `functions/src`, or `zipper-crm` — only the readers/updaters in `zipper-crm/lib/firestore.ts:552-594` and the `firestore.rules` create clause permitting a host to file their own. The app-side creation path is not determined from implementation.
3. **Whether `withdrawalRequests` and the Mongo `host_withdrawal` card are ever linked.** No field joins a `withdrawalRequests` document to a card id, and no code reads one to raise the other.
4. **The live `appConfig/economy` values at the time of reading.** All figures in §1 are the documented fallbacks (commission.py:551-573, dated 2026-08-20) and the CRM defaults (`economyConfig.ts:336-359`), which agree exactly. The actual Firestore document was not read.
5. **A maximum withdrawal amount.** None exists in the implementation beyond `beansAvailable`.
6. **Whether a host salary request is ever converted into an executed `salary_request` card.** The reports count executed `salary_request` cards, but nothing in `backend/app/services/*` raises one, and nothing reads `salaryRequests` to produce one.
7. **`processedBy` on withdrawals.** Hard-coded to the literal string `'Admin'` in all three write functions (`firestore.ts:564, 582, 592`) rather than the acting user's uid.
8. **Whether `agency_statement.host_count` reflects the same host set as billing.** It counts `agency_hosts` where `active: true` (`partners.py:136-138`), a different source from the ledger aggregation.