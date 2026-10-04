const admin = require('firebase-admin');
const serviceAccount = require('./serviceAccountKey.json');

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

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
