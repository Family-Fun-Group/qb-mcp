# Privacy Policy — qb-mcp / Cowork QuickBooks connector

**Last updated: 2026-07-30**

This app (the QuickBooks connector inside Cowork, backed by `qb-mcp`) is an
internal tool built and used by Family Fun Group. It connects Cowork's AI
assistant to a user's own QuickBooks Online company data, at that user's
explicit request, so the assistant can read and act on it on their behalf.

## What data it accesses

Whatever the signed-in QuickBooks account can already see: company info,
customers, vendors, invoices, bills, payments, items, accounts, and
standard reports (P&L, balance sheet, etc.), as permitted by the OAuth
scopes granted during sign-in.

## Where data goes

- Nothing is sent to Family Fun Group's own servers. `qb-mcp` runs entirely
  on the user's own machine.
- QuickBooks API requests go directly from the user's machine to Intuit's
  API (`quickbooks.api.intuit.com`) — never through a third-party relay.
- OAuth tokens are stored locally on the user's machine
  (`~/.cowork/quickbooks/`), never transmitted anywhere except to Intuit's
  own token endpoint for refresh.
- The only shared infrastructure involved is an internal credential broker
  that hands the app's own OAuth *client ID* (not the user's data or
  tokens) to the Cowork app at install time, so users don't have to create
  their own Intuit developer app.

## Data retention

Tokens persist locally until the user disconnects the company in Cowork or
uninstalls the app. No QuickBooks data is copied to any Family Fun Group
server or third party.

## Contact

`carrie@familyfungroup.com`
