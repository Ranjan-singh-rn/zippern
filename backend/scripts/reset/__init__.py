"""ZIPPER backup → verify → plan → execute → seed → postcheck tooling (spec §14).

Every module here is import-light (stdlib only at import time). The SDKs —
firebase_admin, google-cloud-firestore, google-cloud-storage, pymongo — are
imported lazily inside `live.py`, so the pure logic is unit-tested against
in-memory fakes with no network and no credentials.

Read RESET-RUNBOOK.md before running anything.
"""
