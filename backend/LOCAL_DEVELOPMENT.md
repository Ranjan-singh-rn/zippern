# Local development — isolated from production

Outside production the API reaches **only this machine**. This is enforced in
code (`app/core/isolation.py`), not left to whatever an env file says.

| Destination | Outside production (`ENVIRONMENT` = development / test) |
|---|---|
| MongoDB | `mongodb://` on `localhost`, `127.0.0.1` or `::1` only. `mongodb+srv://` is refused. Checked in `mongo.connect()` and in the email recorder's own client, **before** a client exists — so `ensure_indexes()` can never run anywhere else. |
| Firebase | A `demo-` project only, with the Firestore, Auth and Storage emulator hosts all set and all on this machine. Checked in `firebase.init()` **before** any credential is read. The SDK then runs with anonymous credentials: no service-account key, no Application Default Credentials. |
| Email | Never sent. `SENDGRID_API_KEY` is dropped when settings load; every delivery is recorded as `not_configured`. |
| Firebase Auth sign-in (`scripts/signin.py`) | The Auth emulator only, and `API_BASE` on this machine only. |

Every refusal names the variable and never prints a value.

In **production** (`ENVIRONMENT=production`) nothing changes on Cloud Run
(`K_SERVICE` is set there by the platform). Anywhere else the run must be
confirmed for that one command — see [Deliberate production operations](#deliberate-production-operations).

## Which settings file is read

Exactly one file, never a merge (relative to the working directory, normally `backend/`):

1. `ZIPPER_ENV_FILE`, if set;
2. otherwise `.env.local`, if it exists;
3. otherwise `.env`.

`.env.local` holds the local configuration (copy of `.env.example`). `.env` is
left as it is. If `.env.local` is missing and `.env` points at production, the
API refuses to start rather than connecting.

## One-time setup

You need:
- the backend virtualenv from `README.md`;
- a MongoDB **replica set** on this machine;
- the Firebase CLI and a JDK (21 or newer) for the emulators.

Nothing below is installed or downloaded for you.

```bash
cd backend
cp .env.example .env.local            # already done once; contains no secrets

# MongoDB: a single-node replica set, published on loopback only.
docker run -d -p 127.0.0.1:27017:27017 --name zipper-mongo mongo:7 --replSet rs0
docker exec zipper-mongo mongosh --quiet --eval 'rs.initiate()'

# Firebase emulator binaries, once (downloads from Google — your decision):
firebase setup:emulators:firestore
firebase setup:emulators:storage
```

## Every day

```bash
# terminal 1 — emulators, always under a demo- project
backend/scripts/start_local_emulators.sh          # Auth 9099 · Firestore 8080 · Storage 9199

# terminal 2 — the API (port 8000: the Firestore emulator owns 8080)
cd backend && source .venv/bin/activate
uvicorn app.main:app --reload --port 8000
#   log line:  Isolation: local isolation: MongoDB on this machine, Firebase emulators (project demo-zipper), outbound email disabled

python -m scripts.seed_accounts                    # seeds the LOCAL database and the Auth emulator
python -m scripts.signin <email>                   # signs in against the Auth emulator
```

`.firebaserc`'s default project is production. Do not run a bare
`firebase emulators:start`: use the script, which always passes
`--project demo-zipper`. It does not start the Functions emulator, because that
would load `functions/.env`, which holds production credentials.

## What does not work locally

- Signed URLs for host-verification photographs: anonymous credentials cannot
  sign. The review screen shows an error instead of the photo.
- Anything that needs a real third party (SendGrid, Agora tokens valid for real
  rooms).
- The CRM dev server (`npm run dev`) and Android debug builds still use the
  production Firebase project. They have no emulator mode yet, so do not use
  them against local data.

## Deliberate production operations

An operator script that must touch production (a verified backfill, a read-only
verifier) runs only when all three are given **for that one command**:

```bash
ZIPPER_ENV_FILE=.env ENVIRONMENT=production ZIPPER_ALLOW_PRODUCTION_ACCESS=<project-id> \
  python -m scripts.<name> ...
```

- `ZIPPER_ALLOW_PRODUCTION_ACCESS` must equal `FIREBASE_PROJECT_ID`.
- Never put it in a file or export it in a shell profile.
- `scripts/verify_deployed_*_rules.py` call Google's API directly. They only
  read, but they bypass these checks. Run them only on purpose.
