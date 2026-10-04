import { db } from '@/lib/firebase'
import {
  doc, getDoc, setDoc, getDocs, deleteDoc,
  collection, serverTimestamp, Timestamp,
} from 'firebase/firestore'

// ─────────────────────────────────────────────────────────────────────────────
// CURRENCY SETTINGS
// Controls how prices are shown to users outside India/USA
// Firestore: appConfig/currencySettings
// ─────────────────────────────────────────────────────────────────────────────

export interface CurrencySettings {
  markupPct: number   // % added on top of live exchange rate for non-INR/non-USD users (e.g. 5 = 5%)
  updatedAt?: Timestamp | null
}

export const DEFAULT_CURRENCY_SETTINGS: Omit<CurrencySettings, 'updatedAt'> = {
  markupPct: 5,
}

export async function getCurrencySettings(): Promise<CurrencySettings> {
  const snap = await getDoc(doc(db, 'appConfig', 'currencySettings'))
  if (!snap.exists()) return { ...DEFAULT_CURRENCY_SETTINGS }
  return snap.data() as CurrencySettings
}

export async function saveCurrencySettings(
  data: Omit<CurrencySettings, 'updatedAt'>,
): Promise<void> {
  await setDoc(doc(db, 'appConfig', 'currencySettings'), {
    ...data,
    updatedAt: serverTimestamp(),
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// PAYMENT CREDENTIALS
// Replaces hardcoded bank + Binance UID in BuyCoinScreen.kt
// Firestore: appConfig/paymentCredentials
// ─────────────────────────────────────────────────────────────────────────────

export interface PaymentCredentials {
  binanceUid: string
  bankName: string
  bankIfsc: string
  bankAccount: string
  bankHolder: string
  bankBranch: string
  updatedAt?: Timestamp | null
}

export async function getPaymentCredentials(): Promise<PaymentCredentials | null> {
  const snap = await getDoc(doc(db, 'appConfig', 'paymentCredentials'))
  if (!snap.exists()) return null
  return snap.data() as PaymentCredentials
}

export async function savePaymentCredentials(
  data: Omit<PaymentCredentials, 'updatedAt'>,
): Promise<void> {
  await setDoc(doc(db, 'appConfig', 'paymentCredentials'), {
    ...data,
    updatedAt: serverTimestamp(),
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// DAILY REWARDS
// Replaces hardcoded DAILY_REWARDS_SCHEDULE in DailyReward.kt
// Firestore: appConfig/dailyRewards  →  { schedule: DayReward[] }
// ─────────────────────────────────────────────────────────────────────────────

export interface DayReward {
  day: number
  diamonds: number
  callCards: number
}

export const DEFAULT_DAILY_REWARDS: DayReward[] = [
  { day: 1, diamonds: 50,  callCards: 0 },
  { day: 2, diamonds: 75,  callCards: 0 },
  { day: 3, diamonds: 100, callCards: 1 },
  { day: 4, diamonds: 100, callCards: 0 },
  { day: 5, diamonds: 150, callCards: 1 },
  { day: 6, diamonds: 150, callCards: 0 },
  { day: 7, diamonds: 200, callCards: 2 },
]

export async function getDailyRewards(): Promise<DayReward[]> {
  const snap = await getDoc(doc(db, 'appConfig', 'dailyRewards'))
  if (!snap.exists()) return [...DEFAULT_DAILY_REWARDS]
  return (snap.data().schedule as DayReward[]) ?? [...DEFAULT_DAILY_REWARDS]
}

export async function saveDailyRewards(schedule: DayReward[]): Promise<void> {
  await setDoc(doc(db, 'appConfig', 'dailyRewards'), {
    schedule,
    updatedAt: serverTimestamp(),
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// RECHARGE PACKAGES  (user-facing diamond shop)
// Replaces hardcoded PACKAGES in DiamondShopScreen.kt
// Firestore: rechargePackages/{id}
// ─────────────────────────────────────────────────────────────────────────────

export interface RechargePackage {
  id: string
  label: string
  priceInr: number
  priceUsd: number       // USD price shown to international users
  baseDiamonds: number
  bonusDiamonds: number
  badge: string          // 'MOST POPULAR' | 'BEST VALUE' | ''
  isActive: boolean
  sortOrder: number
  localPrices?: Record<string, number>   // per-currency prices, e.g. { EUR: 25, GBP: 22 }
}

export const DEFAULT_RECHARGE_PACKAGES: Omit<RechargePackage, 'id'>[] = [
  { label: 'Starter',  priceInr: 200,  priceUsd: 2,  baseDiamonds: 8500,   bonusDiamonds: 500,   badge: '',             isActive: true, sortOrder: 1 },
  { label: 'Basic',    priceInr: 400,  priceUsd: 5,  baseDiamonds: 17000,  bonusDiamonds: 1500,  badge: '',             isActive: true, sortOrder: 2 },
  { label: 'Standard', priceInr: 800,  priceUsd: 10, baseDiamonds: 34000,  bonusDiamonds: 4000,  badge: '',             isActive: true, sortOrder: 3 },
  { label: 'Popular',  priceInr: 1600, priceUsd: 19, baseDiamonds: 68000,  bonusDiamonds: 10000, badge: '',             isActive: true, sortOrder: 4 },
  { label: 'Value',    priceInr: 2290, priceUsd: 28, baseDiamonds: 90000,  bonusDiamonds: 10000, badge: 'MOST POPULAR', isActive: true, sortOrder: 5 },
  { label: 'Elite',    priceInr: 4580, priceUsd: 55, baseDiamonds: 180000, bonusDiamonds: 20000, badge: 'BEST VALUE',   isActive: true, sortOrder: 6 },
]

export async function getRechargePackages(): Promise<RechargePackage[]> {
  const snap = await getDocs(collection(db, 'rechargePackages'))
  if (snap.empty) return []
  return snap.docs
    .map(d => ({ id: d.id, ...d.data() } as RechargePackage))
    .sort((a, b) => a.sortOrder - b.sortOrder)
}

export async function saveRechargePackage(pkg: RechargePackage): Promise<void> {
  const { id, ...data } = pkg
  await setDoc(doc(db, 'rechargePackages', id), data)
}

export async function deleteRechargePackage(id: string): Promise<void> {
  await deleteDoc(doc(db, 'rechargePackages', id))
}

// ─────────────────────────────────────────────────────────────────────────────
// DIAMOND PACKS  (wholesale — seller buys from Zipper)
// Replaces hardcoded DIAMOND_PACKS in DiamondPack.kt
// Firestore: diamondPacks/{id}
// ─────────────────────────────────────────────────────────────────────────────

export interface DiamondPack {
  id: string
  label: string
  priceInr: number
  priceUsd: number       // USD price for international sellers
  baseDiamonds: number
  bonusDiamonds: number
  isActive: boolean
  sortOrder: number
  localPrices?: Record<string, number>   // per-currency prices
}

export const DEFAULT_DIAMOND_PACKS: Omit<DiamondPack, 'id'>[] = [
  { label: 'Bronze',   priceInr: 2290,   priceUsd: 28,   baseDiamonds: 100000,   bonusDiamonds: 0, isActive: true, sortOrder: 1 },
  { label: 'Silver',   priceInr: 11450,  priceUsd: 138,  baseDiamonds: 500000,   bonusDiamonds: 0, isActive: true, sortOrder: 2 },
  { label: 'Gold',     priceInr: 22900,  priceUsd: 275,  baseDiamonds: 1000000,  bonusDiamonds: 0, isActive: true, sortOrder: 3 },
  { label: 'Platinum', priceInr: 57250,  priceUsd: 688,  baseDiamonds: 2500000,  bonusDiamonds: 0, isActive: true, sortOrder: 4 },
  { label: 'Diamond',  priceInr: 114500, priceUsd: 1375, baseDiamonds: 5000000,  bonusDiamonds: 0, isActive: true, sortOrder: 5 },
  { label: 'Elite',    priceInr: 229000, priceUsd: 2750, baseDiamonds: 10000000, bonusDiamonds: 0, isActive: true, sortOrder: 6 },
]

export async function getDiamondPacks(): Promise<DiamondPack[]> {
  const snap = await getDocs(collection(db, 'diamondPacks'))
  if (snap.empty) return []
  return snap.docs
    .map(d => ({ id: d.id, ...d.data() } as DiamondPack))
    .sort((a, b) => a.sortOrder - b.sortOrder)
}

export async function saveDiamondPack(pkg: DiamondPack): Promise<void> {
  const { id, ...data } = pkg
  await setDoc(doc(db, 'diamondPacks', id), data)
}

export async function deleteDiamondPack(id: string): Promise<void> {
  await deleteDoc(doc(db, 'diamondPacks', id))
}

// ─────────────────────────────────────────────────────────────────────────────
// COIN PACKAGES  (seller buy-coin flow)
// Replaces hardcoded COIN_PACKAGES in BuyCoinScreen.kt
// Firestore: coinPackages/{id}
// ─────────────────────────────────────────────────────────────────────────────

export interface CoinPackage {
  id: string
  coins: number
  priceInr: number
  priceUsd: number
  isActive: boolean
  sortOrder: number
}

export const DEFAULT_COIN_PACKAGES: Omit<CoinPackage, 'id'>[] = [
  { coins: 100000, priceInr: 2290,  priceUsd: 28,  isActive: true, sortOrder: 1 },
  { coins: 200000, priceInr: 4580,  priceUsd: 56,  isActive: true, sortOrder: 2 },
  { coins: 500000, priceInr: 11450, priceUsd: 140, isActive: true, sortOrder: 3 },
]

export async function getCoinPackages(): Promise<CoinPackage[]> {
  const snap = await getDocs(collection(db, 'coinPackages'))
  if (snap.empty) return []
  return snap.docs
    .map(d => ({ id: d.id, ...d.data() } as CoinPackage))
    .sort((a, b) => a.sortOrder - b.sortOrder)
}

export async function saveCoinPackage(pkg: CoinPackage): Promise<void> {
  const { id, ...data } = pkg
  await setDoc(doc(db, 'coinPackages', id), data)
}

export async function deleteCoinPackage(id: string): Promise<void> {
  await deleteDoc(doc(db, 'coinPackages', id))
}

// ─────────────────────────────────────────────────────────────────────────────
// PROFILE OPTIONS
// Replaces hardcoded HOBBY_OPTIONS, LIKE_OPTIONS, liveCategories, CATEGORIES
// in HomeScreen.kt, EditProfileScreen.kt, GoLiveScreen.kt, FeedbackScreen.kt
// Firestore: appConfig/profileOptions
// ─────────────────────────────────────────────────────────────────────────────

export interface ProfileOptions {
  hobbies: string[]
  likes: string[]
  liveCategories: string[]
  supportCategories: string[]
  maxLanguages: number
  updatedAt?: Timestamp | null
}

export const DEFAULT_PROFILE_OPTIONS: Omit<ProfileOptions, 'updatedAt'> = {
  hobbies: [
    'Travelling','Dancing','Singing','Gaming','Reading',
    'Fitness','Cooking','Photography','Movies','Sports',
    'Music','Art','Fashion','Tech','Yoga',
  ],
  likes: [
    'Friendship','Dating','Long Talks','Video Calls','Live Streaming',
    'Music','Party Rooms','Gaming','Shopping','Travel',
  ],
  liveCategories: ['general','music','dance','gaming','talk'],
  supportCategories: ['login','payment','recharge','video_call','live_stream','account','bug','general'],
  maxLanguages: 10,
}

export async function getProfileOptions(): Promise<ProfileOptions> {
  const snap = await getDoc(doc(db, 'appConfig', 'profileOptions'))
  if (!snap.exists()) return { ...DEFAULT_PROFILE_OPTIONS }
  return snap.data() as ProfileOptions
}

export async function saveProfileOptions(
  data: Omit<ProfileOptions, 'updatedAt'>,
): Promise<void> {
  await setDoc(doc(db, 'appConfig', 'profileOptions'), {
    ...data,
    updatedAt: serverTimestamp(),
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// USER LEVEL CONFIG
// Replaces USER_THRESHOLDS in LevelEngine.kt + USER_LEVELS in LevelScreen.kt
// Firestore: levelConfig/user/levels/{0..20}
// ─────────────────────────────────────────────────────────────────────────────

export interface UserLevelConfig {
  level: number
  xpRequired: number        // cumulative diamonds spent (totalXp on user doc)
  frameName: string
  entranceName: string
  entranceAsset: string     // Lottie JSON path e.g. entries/entry_king.json
  profileCard: string       // e.g. "Gold Card"
  bonusDiamonds: number
}

export const DEFAULT_USER_LEVELS: UserLevelConfig[] = [
  { level: 0,  xpRequired: 0,                frameName: '',                  entranceName: '',               entranceAsset: '',                          profileCard: '',            bonusDiamonds: 0         },
  { level: 1,  xpRequired: 100_000,           frameName: 'Basic Frame',       entranceName: '',               entranceAsset: '',                          profileCard: '',            bonusDiamonds: 0         },
  { level: 2,  xpRequired: 200_000,           frameName: 'Silver Ring',       entranceName: '',               entranceAsset: '',                          profileCard: 'Basic Card',  bonusDiamonds: 0         },
  { level: 3,  xpRequired: 400_000,           frameName: 'Bronze Crown',      entranceName: '',               entranceAsset: '',                          profileCard: 'Bronze Card', bonusDiamonds: 0         },
  { level: 4,  xpRequired: 600_000,           frameName: 'Silver Crown',      entranceName: 'Tiger Rush',     entranceAsset: 'entries/entry_tiger.json',  profileCard: '',            bonusDiamonds: 0         },
  { level: 5,  xpRequired: 900_000,           frameName: 'Gold Crown',        entranceName: "King's Entry",   entranceAsset: 'entries/entry_king.json',   profileCard: 'Gold Card',   bonusDiamonds: 0         },
  { level: 6,  xpRequired: 1_800_000,         frameName: 'War Crown',         entranceName: 'Horse Rider',    entranceAsset: 'entries/entry_horse.json',  profileCard: 'Warlord Card',bonusDiamonds: 100       },
  { level: 7,  xpRequired: 5_000_000,         frameName: 'Diamond Crown',     entranceName: 'Royal Ship',     entranceAsset: 'entries/entry_ship.json',   profileCard: 'Diamond Card',bonusDiamonds: 500       },
  { level: 8,  xpRequired: 25_000_000,        frameName: 'Master Crown',      entranceName: 'Rocket Launch',  entranceAsset: 'entries/entry_rocket.json', profileCard: 'Master Card', bonusDiamonds: 1000      },
  { level: 9,  xpRequired: 50_000_000,        frameName: 'Legend Crown',      entranceName: 'Fighter Jet',    entranceAsset: 'entries/entry_jet.json',    profileCard: 'Legend Card', bonusDiamonds: 2000      },
  { level: 10, xpRequired: 100_000_000,       frameName: 'Elite Crown',       entranceName: 'VIP Plane',      entranceAsset: 'entries/entry_vip_plane.json', profileCard: 'Elite Card', bonusDiamonds: 5000 },
  { level: 11, xpRequired: 200_000_000,       frameName: 'Mythic Crown',      entranceName: '',               entranceAsset: '',                          profileCard: '',            bonusDiamonds: 10000     },
  { level: 12, xpRequired: 500_000_000,       frameName: 'Mythic Crown+',     entranceName: '',               entranceAsset: '',                          profileCard: '',            bonusDiamonds: 20000     },
  { level: 13, xpRequired: 1_000_000_000,     frameName: 'Ancient Crown',     entranceName: '',               entranceAsset: '',                          profileCard: '',            bonusDiamonds: 50000     },
  { level: 14, xpRequired: 2_000_000_000,     frameName: 'Ancient Crown+',    entranceName: '',               entranceAsset: '',                          profileCard: '',            bonusDiamonds: 100000    },
  { level: 15, xpRequired: 6_000_000_000,     frameName: 'Eternal Crown',     entranceName: '',               entranceAsset: '',                          profileCard: '',            bonusDiamonds: 200000    },
  { level: 16, xpRequired: 9_000_000_000,     frameName: 'Eternal Crown+',    entranceName: '',               entranceAsset: '',                          profileCard: '',            bonusDiamonds: 500000    },
  { level: 17, xpRequired: 18_000_000_000,    frameName: 'Galaxy Crown',      entranceName: '',               entranceAsset: '',                          profileCard: '',            bonusDiamonds: 1000000   },
  { level: 18, xpRequired: 54_000_000_000,    frameName: 'Galaxy Crown+',     entranceName: '',               entranceAsset: '',                          profileCard: '',            bonusDiamonds: 2000000   },
  { level: 19, xpRequired: 158_000_000_000,   frameName: 'Cosmic Crown',      entranceName: '',               entranceAsset: '',                          profileCard: '',            bonusDiamonds: 5000000   },
  { level: 20, xpRequired: 550_000_000_000,   frameName: 'Zipper God Crown',  entranceName: 'Yamraj Special', entranceAsset: 'entries/entry_yamraj.json', profileCard: "God's Card",  bonusDiamonds: 10000000  },
]

export async function getUserLevels(): Promise<UserLevelConfig[]> {
  const snap = await getDocs(collection(db, 'levelConfig', 'user', 'levels'))
  if (snap.empty) return [...DEFAULT_USER_LEVELS]
  return snap.docs
    .map(d => d.data() as UserLevelConfig)
    .sort((a, b) => a.level - b.level)
}

export async function saveUserLevel(entry: UserLevelConfig): Promise<void> {
  await setDoc(doc(db, 'levelConfig', 'user', 'levels', String(entry.level)), entry)
}

export async function seedUserLevels(): Promise<void> {
  await Promise.all(
    DEFAULT_USER_LEVELS.map(l =>
      setDoc(doc(db, 'levelConfig', 'user', 'levels', String(l.level)), l),
    ),
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// HOST LEVEL CONFIG
// Replaces HOST_THRESHOLDS in LevelEngine.kt + HOST_LEVELS in LevelScreen.kt
// Firestore: levelConfig/host/levels/{0..10}
// ─────────────────────────────────────────────────────────────────────────────

export interface HostLevelConfig {
  level: number
  beansRequired: number     // cumulative beans earned (totalBeansEarned on user doc)
  frameName: string
  entranceName: string
  entranceAsset: string     // Lottie JSON path e.g. entries/entry_lambo.json
  bonusBeans: number
  bonusDiamonds: number
  /**
   * The ceiling a host at this level may set their own call rate to, in
   * beans/min. Read by `getHostHome` in the functions and by the rate slider
   * in the app. Level 0 is 700; level 10 is 2400.
   *
   * This field was missing from the interface, so the CRM never wrote it —
   * and because `saveHostLevel` used `setDoc` without merge, saving any level
   * from the CRM erased the value the seed script had put there, and every
   * host's ceiling silently became 0.
   */
  maxCallRateBeans: number
}

export const DEFAULT_HOST_LEVELS: HostLevelConfig[] = [
  { level: 0,  beansRequired: 0,          frameName: '',                    entranceName: '',           entranceAsset: '',                        bonusBeans: 0,        bonusDiamonds: 0, maxCallRateBeans: 700 },
  { level: 1,  beansRequired: 10_000,     frameName: 'Host Starter Frame',  entranceName: '',           entranceAsset: '',                        bonusBeans: 0,        bonusDiamonds: 0, maxCallRateBeans: 850 },
  { level: 2,  beansRequired: 100_000,    frameName: 'Bronze Host Frame',   entranceName: '',           entranceAsset: '',                        bonusBeans: 30000,    bonusDiamonds: 0, maxCallRateBeans: 1000 },
  { level: 3,  beansRequired: 300_000,    frameName: 'Silver Host Frame',   entranceName: '',           entranceAsset: '',                        bonusBeans: 50000,    bonusDiamonds: 0, maxCallRateBeans: 1150 },
  { level: 4,  beansRequired: 600_000,    frameName: 'Gold Host Frame',     entranceName: '',           entranceAsset: '',                        bonusBeans: 100000,   bonusDiamonds: 500, maxCallRateBeans: 1350 },
  { level: 5,  beansRequired: 1_000_000,  frameName: 'Platinum Host Frame', entranceName: '',           entranceAsset: '',                        bonusBeans: 200000,   bonusDiamonds: 1000, maxCallRateBeans: 1550 },
  { level: 6,  beansRequired: 2_000_000,  frameName: 'Diamond Host Frame',  entranceName: 'Biker Entry',entranceAsset: 'entries/entry_bike.json', bonusBeans: 300000,   bonusDiamonds: 2000, maxCallRateBeans: 1750 },
  { level: 7,  beansRequired: 4_000_000,  frameName: 'Master Host Frame',   entranceName: '',           entranceAsset: '',                        bonusBeans: 500000,   bonusDiamonds: 3000, maxCallRateBeans: 1950 },
  { level: 8,  beansRequired: 8_000_000,  frameName: 'Legend Host Frame',   entranceName: 'Royal Entry',entranceAsset: 'entries/entry_lv8.json',  bonusBeans: 800000,   bonusDiamonds: 5000, maxCallRateBeans: 2150 },
  { level: 9,  beansRequired: 16_000_000, frameName: 'Elite Host Frame',    entranceName: '',           entranceAsset: '',                        bonusBeans: 1200000,  bonusDiamonds: 10000, maxCallRateBeans: 2300 },
  { level: 10, beansRequired: 32_000_000, frameName: 'Mythic Host Crown',   entranceName: 'Lambo Entry',entranceAsset: 'entries/entry_lambo.json',bonusBeans: 2000000,  bonusDiamonds: 20000, maxCallRateBeans: 2400 },
]

export async function getHostLevels(): Promise<HostLevelConfig[]> {
  const snap = await getDocs(collection(db, 'levelConfig', 'host', 'levels'))
  if (snap.empty) return [...DEFAULT_HOST_LEVELS]
  return snap.docs
    .map(d => d.data() as HostLevelConfig)
    .sort((a, b) => a.level - b.level)
}

export async function saveHostLevel(entry: HostLevelConfig): Promise<void> {
  // merge: true. A plain setDoc replaced the whole document, so a field this
  // form does not know about — which maxCallRateBeans was until now — was
  // wiped by every save. Merging means the form only owns what it shows.
  await setDoc(doc(db, 'levelConfig', 'host', 'levels', String(entry.level)), entry, { merge: true })
}

export async function seedHostLevels(): Promise<void> {
  await Promise.all(
    DEFAULT_HOST_LEVELS.map(l =>
      setDoc(doc(db, 'levelConfig', 'host', 'levels', String(l.level)), l, { merge: true }),
    ),
  )
}
