# qb-mcp

A QuickBooks Online MCP server over stdio. **One process serves one QuickBooks
company (realm)** — run one instance per company and your agent talks to all of
them at once, sidestepping Intuit's one-company-per-authorization limit that
pins other integrations to a single company file.

No dependencies. Standalone binaries (Windows/Linux/macOS) are on the
[releases page](https://github.com/Family-Fun-Group/qb-mcp/releases); no
runtime required.

## Usage

```
qb-mcp <company-slug>
```

```
qb-mcp --connect
```

One-shot company discovery: runs the OAuth round trip, prints
`{"url": "..."}` immediately (open it, or let the caller's own browser-open
win), then on completion prints
`{"realmId","companyName","accessToken","accessExpiresAt","refreshToken","refreshExpiresAt"}`
and exits 0 — or `{"error": "..."}` and exits 1. Callers use this to learn
which company the user picked in Intuit's own account/company selector
*before* deciding what to name the persistent server, instead of asking the
user to type a company name that has to somehow match their pick.

Environment:

| Var | Purpose |
|---|---|
| `QB_CLIENT_ID` / `QB_CLIENT_SECRET` | Intuit app credentials (required for sign-in and token refresh) |
| `QB_SANDBOX=1` | Use Intuit's sandbox API instead of production |

## Tools

- `quickbooks_status` — which company this instance is bound to, sign-in expiry
- `quickbooks_connect` — OAuth sign-in via a localhost callback (ports 8791–8793,
  register `http://localhost:<port>/callback` on your Intuit app); opens the
  browser, one sign-in binds this instance to one company
- `quickbooks_query` — QBO query language (`SELECT * FROM Invoice WHERE Balance > 0`)
- `quickbooks_get_report` — ProfitAndLoss, BalanceSheet, GeneralLedger, …
- `quickbooks_api` — raw GET/POST escape hatch for creates, sparse updates,
  deletes, sends

Tokens live in `~/.cowork/quickbooks/<slug>.json` (mode 0600), access tokens
refresh automatically, and the 100-day refresh token rotates on every use.

## Intuit app setup

1. Create an app at <https://developer.intuit.com> (QuickBooks Online
   Accounting scope, `com.intuit.quickbooks.accounting`).
2. Add redirect URIs: `http://localhost:8791/callback`,
   `http://localhost:8792/callback`, `http://localhost:8793/callback`.
3. Export the production client ID/secret as `QB_CLIENT_ID`/`QB_CLIENT_SECRET`.
