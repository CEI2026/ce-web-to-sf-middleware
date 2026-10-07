# ce-web-to-sf-middleware

Catholic Energies public web forms to Salesforce, in one app. Successor to
`ce-solar-middleware` (v7.6). Node 20 or 22, Express.

## What it does

| Endpoint | What it does | Status |
|---|---|---|
| `GET /` | Health check: version, Instant Audit mode, Freddie contact | new format |
| `GET /accounts?zip=` | Institutions by ZIP | **moved unchanged** |
| `GET /buildings?accountId=` | An institution's buildings | **moved unchanged** |
| `GET /institutions` | Ecclesiastical institutions for the affiliation picker | **moved unchanged** |
| `POST /accounts` | Self-register a new organization ("In Review") | **moved unchanged** |
| `POST /submit` | Solar Assessment Form | **moved unchanged** |
| `POST /screening-request`, `/screening-file`, `/screening-complete` | Desk Audit intake (building details, then one bill per request) | **moved unchanged** |
| `POST /instant-audit`, `GET /instant-audit/:id`, `GET /instant-audit/:id/report` | Instant Audit for the browser | **new** |
| `GET /instant-audit/jobs/next`, `POST /instant-audit/jobs/:jobId/result`, `.../report` | The relay Freddie uses (signed requests only) | **new** |
| `GET /procurement`, `POST /procurement-request` | Stub: "coming soon" (501). Nothing is saved | **stub** |

**Still on `ce-solar-middleware`:** `POST /lead-submit` (Lead and Community forms) and the old
`POST /leads`. They were not part of this move. Leave that app running for them.

"Moved unchanged" is proven, not claimed: the handler code was moved line for line (see the
header of each file in `lib/` and `routes/`), and `node tools/characterize.js` runs the old
server and this app side by side against the same fake Salesforce, sending 19 requests and
comparing every response and every Salesforce call. Result: 19 of 19 identical. (Put the two
old files in `tools/legacy/` first; see the README there.)

## Instant Audit in one paragraph

The browser posts the client's entries. The app validates them, **saves them to Salesforce
first**, and puts a job in a queue. **Freddie** (the only scoring engine, on the Mac Studio)
calls out to this app, long-polling `GET /instant-audit/jobs/next`, scores the job, and posts
back the result and a PDF report. The app returns the result to the waiting browser (up to 12
seconds), or answers "queued" and keeps the result for when Freddie answers. Nothing ever
connects in to Freddie. The app never scores anything itself. Design: the build spec,
`UI_and_Middleware_Build_Spec.md`.

### The contract Freddie follows

- Every Freddie request carries `X-CE-Timestamp` (Unix seconds, within 5 minutes of now) and
  `X-CE-Signature`: hex HMAC-SHA256, key `FREDDIE_JOB_SECRET`, of
  `timestamp + "\n" + METHOD + "\n" + path + "\n" + body`.
  **`path` is the URL path without the query string**; `body` is the exact request body text
  (empty for GET). Anything else gets `401`.
- `GET /instant-audit/jobs/next?wait=25`: long poll (the wait is capped at 25 s).
  `200` with `{job_id, submission_id, received_utc, payload}`, or `204` if there is nothing.
  A job that is claimed but not answered within 2 minutes goes back in the queue.
- `POST /instant-audit/jobs/:jobId/result` with `{submission_id, result}`. Posting again is
  harmless (`{ok:true, duplicate:true}`). To report a failure: `{submission_id, error:"..."}`;
  the job goes back in the queue. `result` needs `light`, `headline`, `annual_spend`, and
  `summary {used[], means, next}`; see `fixtures/response_complete_*.json`.
- `POST /instant-audit/jobs/:jobId/report` with `{submission_id, filename, pdf_base64}`
  (a real PDF, up to 3 MB).

### Things the form must know

- After a `queued` answer, poll `GET /instant-audit/:id`. **A `404` means the app restarted and
  forgot the entry**: stop polling and show the queued message. The entry is safe in
  Salesforce and is requeued automatically (below).
- Report links last 7 days. The PDF is also filed in Salesforce when writes are on. The
  in-memory copy is lost on a restart, after which the link returns `404`.
- Mock mode (`INSTANT_AUDIT_MOCK=true`) chooses the canned answer by the entered **total
  cost**: $25,000 or more is green, $8,000 up is yellow, below is red. It does no scoring, so
  the 8-month sample (about $27,700) comes back green in mock mode; the real Freddie returns
  yellow for it.
- `?force=queued` and `?force=error` on `POST /instant-audit` exercise those paths in mock mode.

## Configuration

Copy the first group from the Heroku app of `ce-solar-middleware` (same Salesforce app).

| Variable | Needed | Meaning |
|---|---|---|
| `SF_CLIENT_ID`, `SF_CLIENT_SECRET`, `SF_LOGIN_URL` | yes | Salesforce login (same values as the old app) |
| `NEW_ACCOUNTS_ENABLED`, `DEMO_MODE`, `EI_UNKNOWN_ID` | as on the old app | Account registration settings |
| `SCREENING_UPLOAD_SECRET` | as on the old app | Signs Desk Audit upload tokens. **Use the same value as the old app**, so a client mid-upload is not stranded during cutover |
| `FREDDIE_JOB_SECRET` | for live Instant Audit | Make one with `openssl rand -hex 32`; give the same value to Freddie |
| `INSTANT_AUDIT_MOCK` | no | `true` for form development |
| `INSTANT_AUDIT_SF_WRITE` | no | Leave **off** until change request CR-S3 is live and the API names are confirmed |
| `INSTANT_AUDIT_ALLOWED_ORIGINS` | recommended | Comma-separated website origins (the Netlify sites) allowed to call Instant Audit |
| `PUBLIC_BASE_URL` | recommended | This app's address, for report links |
| `REPORT_LINK_SECRET` | no | Signs report links; defaults to `FREDDIE_JOB_SECRET` |
| `INSTANT_AUDIT_WAIT_MS`, `..._RATE_PER_HOUR`, `..._RATE_PER_BUILDING_DAY`, `..._CLAIM_TIMEOUT_MS`, `..._REPORT_GRACE_MS` | no | Tuning; defaults 12000, 10, 5, 120000, 120000 |

Every Salesforce API name Instant Audit uses is in `lib/instant/schema.js`. If the CE
Salesforce admin confirms different names, change them there only.

## Run and test

    npm install
    npm test                    # 47 tests, no network, no Salesforce
    INSTANT_AUDIT_MOCK=true SF_CLIENT_ID=x SF_CLIENT_SECRET=y npm start

## Deploy (first time)

1. Create the empty GitHub repo `CEI2026/ce-web-to-sf-middleware`, then push this folder to it.
2. In Heroku, create the app (basic dyno; the Freddie poll keeps it awake, so do not use a
   dyno that sleeps), connect it to the repo, and set the variables above. **Check the
   "GitHub Repo" field says `CEI2026/ce-web-to-sf-middleware` before editing any variable.**
3. Start with `INSTANT_AUDIT_MOCK=true`. **Deploy manually** (Deploy tab, Manual deploy, `main`);
   do not rely on auto-deploy.
4. Check: `curl https://<app>.herokuapp.com/` shows `"version":"8.0.0"` and `"mode":"mock"`.

## Cutover, one form at a time (the old app stays up the whole time)

For each form, the only change is the app address it calls. Do the next one only after the
previous one has worked for a few days.

1. **Resource Center and Instant Audit** use this app from the start.
2. **Desk Audit form** (`ce-forms/screening`): change its API address. Submit one test
   building with a bill; confirm it appears in Salesforce with status "Requested" and the file.
3. **Solar Assessment form**: same; confirm the building update, contact and files.
4. **Retire `ce-solar-middleware`** only after `/lead-submit` has also moved and
   `heroku logs --app ce-solar-middleware-c282cb05db3f -n 1500` shows no traffic.

Rollback for any form is putting its old address back.

## Known limits

- One dyno, in-memory queue. A restart loses waiting work from memory; when Salesforce writes
  are on, unfinished submissions (building status "Instant audit pending") are found again and
  requeued 30 seconds after start and every 5 minutes.
- Report PDFs are served from memory (7 days). A later version can serve them from the file in
  Salesforce.
- CORS on the moved endpoints is open to any website, exactly as on the old app. Instant Audit
  can be restricted with `INSTANT_AUDIT_ALLOWED_ORIGINS`.
