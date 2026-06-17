/**
 * seedGifts.ts — One-time admin script to seed the `gifts` Firestore collection.
 *
 * Run locally (NOT deployed as a Cloud Function):
 *   ts-node seedGifts.ts
 *
 * Prerequisites:
 *   npm install firebase-admin ts-node typescript
 *   export GOOGLE_APPLICATION_CREDENTIALS="/path/to/serviceAccountKey.json"
 *
 * After seeding, the Android app reads gift data from Firestore on startup.
 * To update a gift's Lottie URL later, just update the Firestore doc — no redeploy needed.
 *
 * ── Lottie Asset Hosting ────────────────────────────────────────────────────
 * The lottieUrl values below point to LottieFiles public CDN for development.
 * For production:
 *   1. Download each .json from LottieFiles
 *   2. Upload to Firebase Storage: gs://your-project.appspot.com/gifts/lottie/
 *   3. Replace lottieUrl with the Firebase Storage download URL
 * ─────────────────────────────────────────────────────────────────────────────
 */

import * as admin from "firebase-admin";

admin.initializeApp();
const db = admin.firestore();

// ─────────────────────────────────────────────────────────────────────────────
// Gift catalog (mirrors GiftCatalogData.kt)
// ─────────────────────────────────────────────────────────────────────────────

interface GiftDoc {
  id: string;
  name: string;
  category: string;           // REGULAR | PREMIUM | VIP | LUCKY
  giftType: string;           // REGULAR | LUCKY
  price: number;              // diamonds to send
  sortOrder: number;
  isActive: boolean;
  lottieUrl: string | null;
  videoUrl: string | null;
  thumbnailUrl: string;
  soundUrl: string | null;
  // bean split
  recipientBeanPercent: number; // 50 for REGULAR, 5 for LUCKY
}

const GIFTS: GiftDoc[] = [
  // ── Tier 1 — Casual ──────────────────────────────────────────────────────
  {
    id: "1", name: "Rose", category: "REGULAR", giftType: "REGULAR",
    price: 10, sortOrder: 1, isActive: true, recipientBeanPercent: 50,
    thumbnailUrl: "",
    lottieUrl: "https://assets9.lottiefiles.com/packages/lf20_j3oxj2ta.json",
    videoUrl: null,
    soundUrl: null,
  },
  {
    id: "2", name: "Fire", category: "REGULAR", giftType: "REGULAR",
    price: 20, sortOrder: 2, isActive: true, recipientBeanPercent: 50,
    thumbnailUrl: "",
    lottieUrl: "https://assets2.lottiefiles.com/packages/lf20_jvftm4zt.json",
    videoUrl: null,
    soundUrl: null,
  },
  {
    id: "3", name: "Bouquet", category: "REGULAR", giftType: "REGULAR",
    price: 50, sortOrder: 3, isActive: true, recipientBeanPercent: 50,
    thumbnailUrl: "",
    lottieUrl: "https://assets5.lottiefiles.com/packages/lf20_lfpby0yp.json",
    videoUrl: null,
    soundUrl: null,
  },
  {
    id: "4", name: "Cake", category: "REGULAR", giftType: "REGULAR",
    price: 99, sortOrder: 4, isActive: true, recipientBeanPercent: 50,
    thumbnailUrl: "",
    lottieUrl: "https://assets10.lottiefiles.com/packages/lf20_obhph2.json",
    videoUrl: null,
    soundUrl: null,
  },

  // ── Tier 2 — Premium ─────────────────────────────────────────────────────
  {
    id: "5", name: "Diamond", category: "PREMIUM", giftType: "REGULAR",
    price: 199, sortOrder: 5, isActive: true, recipientBeanPercent: 50,
    thumbnailUrl: "",
    lottieUrl: "https://assets3.lottiefiles.com/packages/lf20_ikaU3M.json",
    videoUrl: null,
    soundUrl: null,
  },
  {
    id: "6", name: "Crown", category: "PREMIUM", giftType: "REGULAR",
    price: 299, sortOrder: 6, isActive: true, recipientBeanPercent: 50,
    thumbnailUrl: "",
    lottieUrl: "https://assets2.lottiefiles.com/packages/lf20_wCl4RK.json",
    videoUrl: null,
    soundUrl: null,
  },
  {
    id: "7", name: "Rocket", category: "PREMIUM", giftType: "REGULAR",
    price: 499, sortOrder: 7, isActive: true, recipientBeanPercent: 50,
    thumbnailUrl: "",
    lottieUrl: "https://assets5.lottiefiles.com/packages/lf20_M9p23l.json",
    videoUrl: null,
    soundUrl: null,
  },
  {
    id: "8", name: "Lightning", category: "PREMIUM", giftType: "REGULAR",
    price: 699, sortOrder: 8, isActive: true, recipientBeanPercent: 50,
    thumbnailUrl: "",
    lottieUrl: "https://assets3.lottiefiles.com/packages/lf20_vBBK7u.json",
    videoUrl: null,
    soundUrl: null,
  },

  // ── Tier 3 — VIP (full-screen entrance) ──────────────────────────────────
  {
    id: "9", name: "Super Car", category: "VIP", giftType: "REGULAR",
    price: 1000, sortOrder: 9, isActive: true, recipientBeanPercent: 50,
    thumbnailUrl: "",
    lottieUrl: "https://assets1.lottiefiles.com/packages/lf20_fklalxu4.json",
    videoUrl: null,   // TODO: upload to Firebase Storage
    soundUrl: null,
  },
  {
    id: "10", name: "Private Jet", category: "VIP", giftType: "REGULAR",
    price: 3000, sortOrder: 10, isActive: true, recipientBeanPercent: 50,
    thumbnailUrl: "",
    lottieUrl: "https://assets9.lottiefiles.com/packages/lf20_pKcncK.json",
    videoUrl: null,
    soundUrl: null,
  },
  {
    id: "11", name: "Castle", category: "VIP", giftType: "REGULAR",
    price: 5000, sortOrder: 11, isActive: true, recipientBeanPercent: 50,
    thumbnailUrl: "",
    lottieUrl: "https://assets1.lottiefiles.com/packages/lf20_castle.json",
    videoUrl: null,
    soundUrl: null,
  },

  // ── Lucky Gifts (5% beans to host, 95% to company) ───────────────────────
  {
    id: "lucky_1", name: "Lucky Rose", category: "LUCKY", giftType: "LUCKY",
    price: 10, sortOrder: 20, isActive: true, recipientBeanPercent: 5,
    thumbnailUrl: "",
    lottieUrl: "https://assets9.lottiefiles.com/packages/lf20_j3oxj2ta.json",
    videoUrl: null,
    soundUrl: null,
  },
  {
    id: "lucky_2", name: "Lucky Diamond", category: "LUCKY", giftType: "LUCKY",
    price: 99, sortOrder: 21, isActive: true, recipientBeanPercent: 5,
    thumbnailUrl: "",
    lottieUrl: "https://assets3.lottiefiles.com/packages/lf20_ikaU3M.json",
    videoUrl: null,
    soundUrl: null,
  },
  {
    id: "lucky_3", name: "Lucky Crown", category: "LUCKY", giftType: "LUCKY",
    price: 199, sortOrder: 22, isActive: true, recipientBeanPercent: 5,
    thumbnailUrl: "",
    lottieUrl: "https://assets2.lottiefiles.com/packages/lf20_wCl4RK.json",
    videoUrl: null,
    soundUrl: null,
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// Seeder
// ─────────────────────────────────────────────────────────────────────────────

async function seedGifts(): Promise<void> {
  console.log(`Seeding ${GIFTS.length} gifts into Firestore...`);
  const batch = db.batch();

  for (const gift of GIFTS) {
    const ref = db.collection("gifts").doc(gift.id);
    batch.set(ref, {
      ...gift,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
    console.log(`  ✓ gifts/${gift.id} — ${gift.name} (💎${gift.price})`);
  }

  await batch.commit();
  console.log("\n✅ Gift catalog seeded successfully!\n");
  console.log("Next steps:");
  console.log("  1. Go to Firebase Console → Firestore → gifts collection");
  console.log("  2. For each gift, upload the .json Lottie file to Firebase Storage");
  console.log("  3. Update the lottieUrl field with the Storage download URL");
  console.log("  4. For VIP gifts (9, 10, 11), upload MP4 video + update videoUrl");
}

seedGifts()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("❌ Seeding failed:", err);
    process.exit(1);
  });
