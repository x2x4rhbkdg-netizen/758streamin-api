# Local HLS Process Validation

## Observed Local Results: 2026-11-10

- Full API regression suite: 409 passed, zero failed.
- Managed database-pool suite: six passed, zero failed.
- Independent-process integration: five scenarios passed (six tests when Node's
  enclosing test is included), zero failed, using MariaDB 11.4.13.
- Each process reached ten connections under the 80-request burst and stayed
  within its ten-connection limit. The deliberate saturation test recovered.
- Encrypted assets passed stable-URL failover and process replacement. Legacy
  UUID cache entries remained owner-dependent, as expected.

These observations apply to the local fixtures described below. Production
validation and the legacy-session migration strategy remain pending.

## Running The Tests

Requirements: Node 20+, installed project dependencies, and a running local Docker
runtime (on this Mac, `colima start`). Run from the API_APP directory:

```sh
node --test src/routes/playbackHlsHttp.test.cjs
node --test src/db/managedPool.test.cjs
npm test
npm run test:hls:process
```

The process test starts a disposable `mariadb:11.4` container with a unique name,
random credentials, a random loopback-only port, and a test-only schema. The image
can be overridden with `HLS_TEST_MARIADB_IMAGE`, including a digest-pinned image.
It starts two separate Node processes using the real `src/app.js` and
`src/server.js`. The test environments are built from scratch; no application
`.env`, production credentials, WHMCS jobs, or transfer cleanup jobs are loaded.
Child processes, local HTTP servers, database connections, and the test container
are closed at the end, including on assertion failures. Docker/Colima and the
downloaded image remain available. An externally killed test runner may require
manual cleanup of its uniquely named `streamin-hls-test-*` container.

Only provider networking is redirected to local HTTP fixtures: the logical
provider is `http://upstream.example`, with a test DNS result and transport adapter.
The real playback asset reader still checks origins, addresses, and redirects and
handles the fixture's actual HTTP response streams. The database, managed mysql2
pools, JWT validation, credential decryption, router, and Express app are real.
The three database tables contain only the fields needed for these playback
tests; this is not a full schema-migration test.

## What Is Verified

- Worker A issues a playback JWT through the authenticated API route and serves
  a master playlist; Worker B decrypts its portable asset ID without A's cache.
- Nested playlists, AES key bytes, and binary segment bytes are delivered across
  separate process boundaries with fresh device authorization through MariaDB.
- SQL changes to suspension, pending status, expiry, and deletion are enforced
  independently by both processes.
- An 80-request segment burst succeeds across the two pools. Each worker stays
  within the production pool's ten-connection limit and releases its connections.
- Holding all ten connections per worker causes a 24-request burst to receive
  controlled `503 DATABASE_BUSY` responses with `Retry-After: 5`, without upstream
  asset requests. Playback recovers after release and pending checkouts drain.
- After A is killed, the same client-facing encrypted segment/key URLs work
  through a local retry proxy to B. New master/nested playlists retain that public
  proxy origin. A replacement process can also serve the earlier encrypted URL.
- A fixture representing an old Passenger UUID cache entry works on its owner
  and fails on another process or after the owner has been lost.

This demonstrates local process interoperability and connect-failure retry. It
does not prove production throughput, actual Apache failover configuration,
recovery of an HTTP body already interrupted mid-transfer, or physical TV player
compatibility. Pool limits are per process: two workers allow up to 20 connections,
in addition to dashboard jobs, the validation connection, and any other clients.
Production worker counts must fit the actual MariaDB connection budget.

## Tampered Assets

Malformed, noncanonical, oversized, wrongly sized, and unauthentic encrypted asset
tokens receive controlled `400` responses from the decoder. Node's HTTP parser
may reject overlong request URLs first with `431`. Error responses do not expose
crypto details, do not call the internal-error handler, and do not fetch upstream
assets. Expiry and playback-token binding checks remain separate. An invalid or
expired playback JWT is still denied before database authorization or decryption.

## Legacy Passenger URLs: Cutover Blocker

Old UUID identifiers do not contain a recoverable upstream URL. Only their
issuing process's in-memory map knows the target. Sharing JWT and encryption
secrets cannot reconstruct that map. Cache compatibility preserves old links
only while the original owning process and its cache remain alive.

The test explicitly seeds the old cache record shape; it does not launch Passenger
or claim that Passenger's request routing sends each UUID to its owner. No
production cache export, shared legacy lookup, or routing change has been added.

Do not restart Passenger or send existing UUID requests to the standalone workers
on the strength of portable encrypted-asset tests alone. A noninterrupting move
requires a verified routing/drain strategy that preserves existing owners until
old sessions have expired and legacy requests have ceased, or an authenticated
shared mapping exported by those still-running owners. The source code on disk
does not provide access to another live process's cache. If neither strategy is
available, uninterrupted legacy playback has not been established and cutover
must remain pending. Newly issued encrypted IDs remove this limitation for future
sessions but do not retroactively convert issued UUIDs.

## Next Server Validation (Not Performed)

1. Inventory current Passenger workers, URL formats in use, configured token TTL,
   request routing/affinity, MariaDB limits, and background-job ownership. Record
   a rollback procedure before making service or routing changes.
2. Prepare a separate standalone checkout/service with the same intended JWT and
   credential-encryption keys. Provision secrets securely through the service's
   environment. Keep it bound to an unused loopback port with background jobs
   disabled while Passenger remains the active owner of those jobs.
3. Using an authorized test device, exercise token issuance, master/variant/key/
   segment requests and account revocation directly against that private listener.
   Measure authorization queries, checked-out/queued connections, error responses,
   and upstream timings at a bounded load appropriate to the server's capacity.
4. Verify worker replacement behind the proposed proxy using unchanged public
   playback URLs, then test actual Samsung/Android TV players and provider streams.
5. Demonstrate the legacy-owner/drain strategy with evidence from still-running
   Passenger workers. Only then consider a separately approved Apache cutover.

No SSH commands, Passenger restarts, Apache changes, or production deployment are
part of the local validation command.
