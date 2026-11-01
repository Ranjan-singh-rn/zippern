/*
 * P0-10 (OPS-A) — QUARANTINED. This deletes EVERY Firebase Auth user in the
 * project it reaches. It used to load ./serviceAccountKey.json — the production
 * key — with no prompt and no guard.
 *
 * It now runs ONLY against the Auth emulator on this machine, under a demo-
 * project, and never reads a key:
 *
 *   FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9099 node deleteUsers.js --project demo-zipper
 *
 * There is no production mode. Removing the file itself awaits owner approval.
 */
(() => {
  const args = process.argv.slice(2);
  const i = args.indexOf('--project');
  const project = i >= 0 ? String(args[i + 1] || '').trim() : '';
  const emulator = String(process.env.FIREBASE_AUTH_EMULATOR_HOST || '').trim();
  const loopback = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\]|::1)(:\d+)?$/.test(emulator);
  if (!project.startsWith('demo-') || !loopback) {
    console.error(
      'deleteUsers.js: refusing — this deletes EVERY Firebase Auth user. It runs only ' +
      'against the Auth emulator on this machine:\n' +
      '  FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9099 node deleteUsers.js --project demo-<name>',
    );
    process.exit(2);
  }
  module.exports.__project = project;
})();

const admin = require('firebase-admin');

admin.initializeApp({ projectId: module.exports.__project });

async function deleteAllUsers() {
  let nextPageToken;
  let totalDeleted = 0;

  console.log('Starting user deletion...');

  do {
    const listResult = await admin.auth().listUsers(1000, nextPageToken);
    const uids = listResult.users.map(u => u.uid);

    if (uids.length > 0) {
      const result = await admin.auth().deleteUsers(uids);
      totalDeleted += result.successCount;
      console.log(`✓ Deleted ${result.successCount} users (total: ${totalDeleted})`);

      if (result.errors.length > 0) {
        result.errors.forEach(e => console.log(`✗ Failed: ${e.error.message}`));
      }
    }

    nextPageToken = listResult.pageToken;
  } while (nextPageToken);

  console.log(`\nDone! ${totalDeleted} users deleted.`);
  process.exit(0);
}

deleteAllUsers().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
