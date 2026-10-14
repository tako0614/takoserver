# WfP community acceptance app

This is synthetic staging data: members, rooms, posts, attachments, cached
feeds and scheduled summaries. It imports no customer or Hosted application
source. Required bindings are `DB` (D1-compatible SQL), `MEDIA`
(R2-compatible ObjectBucket), and `CACHE` (KV-compatible namespace).

After deploying through the owning WfP/Host lane, initialize the **app-owned**
database with `POST /api/setup`. Create members/rooms/posts with their matching
`/api` endpoints, upload a bounded attachment with a member ID, read it, and
delete it. Read `/api/status` for SQL counts and scheduled receipts. A
scheduled handler writes the same receipt to SQL, KV and an R2 summary;
`GET /api/summary` returns the latest stored summary.

The intended staging load is 100 synthetic members, 20 rooms, 1,000 posts and
20 attachments. First verify one full journey, then apply that bounded load
and report observed timings. After the initial request arms the private
fallback, wait at least two UTC minute boundaries without manual scheduled
injection or HTTP traffic; prove automatic delivery with persisted receipts.
Schedule registration and Miniflare's explicit `scheduled()` test are not
live automatic-clock acceptance.

Use a fresh dedicated staging namespace/resources and retain fixture custody.
The fixture is a disposable synthetic demo; it is not an authenticated
community product. Never place real users, secrets, production records or
operator control-state in these bindings.
