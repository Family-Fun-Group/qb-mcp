/**
 * qb-mcp — a QuickBooks Online MCP server over stdio.
 *
 * One process serves ONE QuickBooks company (realm). Cowork installs one
 * instance per company — quickbooks-acme, quickbooks-corp, … — which is how
 * Claude gets N simultaneous QuickBooks connections even though Intuit binds
 * every OAuth authorization to a single realm.
 *
 * No dependencies: the MCP wire protocol is JSON-RPC over stdio, the QBO API
 * is plain REST, and OAuth is two POSTs. Compiled to a standalone binary with
 * `bun build --compile`.
 *
 * Usage: qb-mcp <company-slug>
 * Env:   QB_CLIENT_ID, QB_CLIENT_SECRET  (required for connect/refresh)
 *        QB_SANDBOX=1                    (use Intuit's sandbox API base)
 */

import { createServer } from "node:http";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";

const slug = process.argv[2];
if (!slug || !/^[a-z0-9-]+$/.test(slug)) {
	process.stderr.write("usage: qb-mcp <company-slug> (lowercase letters, digits, dashes)\n");
	process.exit(2);
}

const CLIENT_ID = process.env.QB_CLIENT_ID ?? "";
const CLIENT_SECRET = process.env.QB_CLIENT_SECRET ?? "";
const API_BASE =
	process.env.QB_SANDBOX === "1"
		? "https://sandbox-quickbooks.api.intuit.com"
		: "https://quickbooks.api.intuit.com";
const TOKEN_URL = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";
const AUTHORIZE_URL = "https://appcenter.intuit.com/connect/oauth2";
const MINOR_VERSION = "75";
/** All three are registered on the Intuit app; serial sign-ins reuse 8791. */
const CALLBACK_PORTS = [8791, 8792, 8793];
const STORE_DIR = join(homedir(), ".cowork", "quickbooks");
const STORE_PATH = join(STORE_DIR, `${slug}.json`);

interface StoredTokens {
	realmId: string;
	companyName?: string;
	accessToken: string;
	/** epoch ms */
	accessExpiresAt: number;
	refreshToken: string;
	/** epoch ms — Intuit refresh tokens live 100 days and rotate on use */
	refreshExpiresAt: number;
}

function isStoredTokens(value: unknown): value is StoredTokens {
	if (typeof value !== "object" || value === null) return false;
	const record = value as Record<string, unknown>;
	return (
		typeof record.realmId === "string" &&
		typeof record.accessToken === "string" &&
		typeof record.refreshToken === "string" &&
		typeof record.accessExpiresAt === "number" &&
		typeof record.refreshExpiresAt === "number"
	);
}

let tokens: StoredTokens | null = null;
try {
	const stored: unknown = JSON.parse(await readFile(STORE_PATH, "utf8"));
	if (isStoredTokens(stored)) tokens = stored;
} catch {
	// Not connected yet — quickbooks_connect exists for exactly this.
}

async function saveTokens(): Promise<void> {
	if (!tokens) return;
	await mkdir(STORE_DIR, { recursive: true });
	const temp = `${STORE_PATH}.${process.pid}.tmp`;
	await writeFile(temp, `${JSON.stringify(tokens, null, 2)}\n`, { mode: 0o600 });
	await rename(temp, STORE_PATH);
}

function log(message: string): void {
	process.stderr.write(`[qb-mcp ${slug}] ${message}\n`);
}

// ---------------------------------------------------------------------------
// OAuth
// ---------------------------------------------------------------------------

async function tokenRequest(body: URLSearchParams): Promise<StoredTokens> {
	const response = await fetch(TOKEN_URL, {
		method: "POST",
		headers: {
			authorization: `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64")}`,
			"content-type": "application/x-www-form-urlencoded",
			accept: "application/json",
		},
		body,
		signal: AbortSignal.timeout(30_000),
	});
	if (!response.ok)
		throw new Error(
			`Intuit token endpoint: HTTP ${response.status} — ${await response.text()}`,
		);
	const raw: unknown = await response.json();
	if (!isIntuitTokenResponse(raw))
		throw new Error("Intuit token endpoint returned an unexpected shape");
	return {
		realmId: tokens?.realmId ?? "",
		accessToken: raw.access_token,
		accessExpiresAt: Date.now() + raw.expires_in * 1000,
		refreshToken: raw.refresh_token,
		refreshExpiresAt: Date.now() + raw.x_refresh_token_expires_in * 1000,
	};
}

interface IntuitTokenResponse {
	access_token: string;
	refresh_token: string;
	expires_in: number;
	x_refresh_token_expires_in: number;
}

function isIntuitTokenResponse(value: unknown): value is IntuitTokenResponse {
	if (typeof value !== "object" || value === null) return false;
	const record = value as Record<string, unknown>;
	return (
		typeof record.access_token === "string" &&
		typeof record.refresh_token === "string" &&
		typeof record.expires_in === "number" &&
		typeof record.x_refresh_token_expires_in === "number"
	);
}

let refreshing: Promise<void> | null = null;
async function ensureAccessToken(): Promise<string> {
	if (!tokens) throw new Error("Not connected. Call quickbooks_connect first.");
	if (Date.now() < tokens.accessExpiresAt - 60_000) return tokens.accessToken;
	refreshing ??= (async () => {
		if (!tokens) return;
		if (Date.now() >= tokens.refreshExpiresAt)
			throw new Error(
				"The QuickBooks refresh token has expired (Intuit caps it at 100 days). Call quickbooks_connect to sign in again.",
			);
		const next = await tokenRequest(
			new URLSearchParams({ grant_type: "refresh_token", refresh_token: tokens.refreshToken }),
		);
		next.realmId = tokens.realmId;
		next.companyName = tokens.companyName;
		tokens = next;
		await saveTokens();
		log("access token refreshed");
	})().finally(() => {
		refreshing = null;
	});
	await refreshing;
	if (!tokens) throw new Error("Not connected. Call quickbooks_connect first.");
	return tokens.accessToken;
}

function openBrowser(url: string): void {
	const [command, args] =
		platform() === "win32"
			? (["cmd", ["/c", "start", "", url]] as const)
			: platform() === "darwin"
				? (["open", [url]] as const)
				: (["xdg-open", [url]] as const);
	spawn(command, [...args], { stdio: "ignore", detached: true }).unref();
}

interface PendingAuth {
	port: number;
	done: Promise<string>;
}

let pendingAuth: PendingAuth | null = null;

async function connect(): Promise<string> {
	if (!CLIENT_ID || !CLIENT_SECRET)
		throw new Error("QB_CLIENT_ID / QB_CLIENT_SECRET are not set on this server.");
	if (pendingAuth) {
		const url = authUrl(pendingAuth.port);
		openBrowser(url);
		return url;
	}
	pendingState = randomBytes(16).toString("hex");
	const { promise: codePromise, resolve: resolveCode, reject: rejectCode } =
		Promise.withResolvers<{ code: string; realmId: string }>();

	let lastError: unknown;
	for (const port of CALLBACK_PORTS) {
		try {
			const server = createServer((req, res) => {
				const url = new URL(req.url ?? "/", `http://localhost:${port}`);
				if (url.pathname !== "/callback") {
					res.writeHead(404).end();
					return;
				}
				const error = url.searchParams.get("error");
				if (error) {
					res.writeHead(400).end("Sign-in failed — you can close this tab.");
					rejectCode(new Error(error));
					return;
				}
				if (url.searchParams.get("state") !== pendingState) {
					// Stray or stale request — keep listening for the real one.
					res.writeHead(400).end("Stale sign-in link — use the one Cowork just opened.");
					return;
				}
				const realmId = url.searchParams.get("realmId") ?? "";
				res.writeHead(200, { "content-type": "text/html" }).end(
					"<h2>QuickBooks connected.</h2>You can close this tab and go back to Cowork.",
				);
				resolveCode({ code: url.searchParams.get("code") ?? "", realmId });
			});
			await new Promise<void>((resolve, reject) => {
				server.once("error", reject);
				server.listen(port, "127.0.0.1", resolve);
			});
			const done = codePromise.then(async ({ code, realmId }) => {
				const next = await tokenRequest(
					new URLSearchParams({
						grant_type: "authorization_code",
						code,
						redirect_uri: `http://localhost:${port}/callback`,
					}),
				);
				next.realmId = realmId;
				tokens = next;
				await fetchCompanyName();
				await saveTokens();
				server.close();
				pendingAuth = null;
				return tokens?.companyName ?? realmId;
			});
			done.catch(() => {
				server.close();
				pendingAuth = null;
			});
			pendingAuth = { port, done };
			const url = authUrl(port);
			openBrowser(url);
			return url;
		} catch (error) {
			lastError = error;
		}
	}
	throw new Error(
		`Could not listen on any callback port (${CALLBACK_PORTS.join(", ")}): ${lastError}`,
	);
}

function authUrl(port: number): string {
	const params = new URLSearchParams({
		client_id: CLIENT_ID,
		scope: "com.intuit.quickbooks.accounting",
		redirect_uri: `http://localhost:${port}/callback`,
		response_type: "code",
		state: pendingState,
	});
	return `${AUTHORIZE_URL}?${params}`;
}

let pendingState = "";

async function fetchCompanyName(): Promise<void> {
	if (!tokens) return;
	try {
		const data: unknown = await qboFetch(`companyinfo/${tokens.realmId}`);
		if (typeof data !== "object" || data === null || !("CompanyInfo" in data)) return;
		const info: unknown = data.CompanyInfo;
		if (typeof info !== "object" || info === null || !("CompanyName" in info)) return;
		if (typeof info.CompanyName === "string") tokens.companyName = info.CompanyName;
	} catch {
		// Cosmetic only.
	}
}

// ---------------------------------------------------------------------------
// QBO API
// ---------------------------------------------------------------------------

async function qboFetch(path: string, init?: RequestInit, retried = false): Promise<unknown> {
	const accessToken = await ensureAccessToken();
	if (!tokens) throw new Error("Not connected.");
	const separator = path.includes("?") ? "&" : "?";
	const response = await fetch(
		`${API_BASE}/v3/company/${tokens.realmId}/${path}${separator}minorversion=${MINOR_VERSION}`,
		{
			...init,
			headers: {
				authorization: `Bearer ${accessToken}`,
				accept: "application/json",
				...(init?.body ? { "content-type": "application/json" } : {}),
			},
			signal: AbortSignal.timeout(60_000),
		},
	);
	if (response.status === 401 && !retried) {
		if (tokens) tokens.accessExpiresAt = 0; // force refresh
		return qboFetch(path, init, true);
	}
	const text = await response.text();
	if (!response.ok) throw new Error(`QuickBooks API: HTTP ${response.status} — ${text.slice(0, 800)}`);
	return text ? (JSON.parse(text) as unknown) : {};
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

const TOOLS = [
	{
		name: "quickbooks_status",
		description:
			"Connection status for this QuickBooks company: whether it is signed in, which company file (realm) it is bound to, and when the sign-in expires.",
		inputSchema: { type: "object", properties: {} },
	},
	{
		name: "quickbooks_connect",
		description:
			"Start QuickBooks sign-in for this company. Returns a URL — show it to the user; it also opens in their browser. After they finish, call quickbooks_status to confirm. One sign-in binds this server to exactly one QuickBooks company.",
		inputSchema: { type: "object", properties: {} },
	},
	{
		name: "quickbooks_query",
		description:
			"Run a QuickBooks query (SQL-like): e.g. 'SELECT * FROM Invoice WHERE Balance > 0', 'SELECT * FROM Customer MAXRESULTS 100'. Entities include Customer, Invoice, Bill, Vendor, Item, Account, Payment, Estimate, Purchase, SalesReceipt, JournalEntry, Employee, and more. This is the primary read tool.",
		inputSchema: {
			type: "object",
			properties: { query: { type: "string", description: "QBO query language statement" } },
			required: ["query"],
		},
	},
	{
		name: "quickbooks_get_report",
		description:
			"Fetch a standard QuickBooks report: ProfitAndLoss, BalanceSheet, GeneralLedger, TrialBalance, CashFlow, CustomerSales, VendorExpenses, AccountList, AgedReceivables, AgedPayables, etc.",
		inputSchema: {
			type: "object",
			properties: {
				report: { type: "string", description: "Report name, e.g. ProfitAndLoss" },
				params: {
					type: "object",
					description: "Report parameters: start_date, end_date, accounting_method, customer, vendor, …",
				},
			},
			required: ["report"],
		},
	},
	{
		name: "quickbooks_api",
		description:
			"Raw QuickBooks API call for anything the other tools do not cover: create/update/delete entities, send invoices, attach notes. Path is relative to the company, e.g. 'customer', 'invoice', 'bill?operation=delete', 'invoice/123'. Use POST with a JSON body to create; include Id and SyncToken plus sparse:true to update.",
		inputSchema: {
			type: "object",
			properties: {
				method: { type: "string", enum: ["GET", "POST"] },
				path: { type: "string" },
				body: { type: "object" },
			},
			required: ["method", "path"],
		},
	},
];

async function callTool(name: string, args: Record<string, unknown>): Promise<string> {
	switch (name) {
		case "quickbooks_status": {
			if (pendingAuth)
				return JSON.stringify({
					connected: false,
					connecting: true,
					message:
						"Sign-in is open in the user's browser. Ask them to finish it, then call quickbooks_status again.",
				});
			if (!tokens)
				return JSON.stringify({
					connected: false,
					message: "Not signed in. Call quickbooks_connect and give the user the URL.",
				});
			return JSON.stringify({
				connected: Date.now() < tokens.refreshExpiresAt,
				company: tokens.companyName ?? null,
				realmId: tokens.realmId,
				signInExpiresAt: new Date(tokens.refreshExpiresAt).toISOString(),
			});
		}
		case "quickbooks_connect": {
			const url = await connect();
			return JSON.stringify({
				url,
				message:
					"Sign-in page opened in the user's browser. Tell the user to finish it there (pick THIS company when Intuit asks), then call quickbooks_status to confirm.",
			});
		}
		case "quickbooks_query": {
			const query = String(args.query ?? "");
			const data = await qboFetch(`query?query=${encodeURIComponent(query)}`);
			return JSON.stringify(data, null, 2);
		}
		case "quickbooks_get_report": {
			const report = String(args.report ?? "");
			const params = (args.params ?? {}) as Record<string, string>;
			const qs = new URLSearchParams(params).toString();
			const data = await qboFetch(`reports/${encodeURIComponent(report)}${qs ? `?${qs}` : ""}`);
			return JSON.stringify(data, null, 2);
		}
		case "quickbooks_api": {
			const method = String(args.method ?? "GET").toUpperCase();
			const path = String(args.path ?? "").replace(/^\/+/, "");
			const body = args.body === undefined ? undefined : JSON.stringify(args.body);
			const data = await qboFetch(path, { method, body });
			return JSON.stringify(data, null, 2);
		}
		default:
			throw new Error(`Unknown tool: ${name}`);
	}
}

// ---------------------------------------------------------------------------
// Minimal MCP stdio server
// ---------------------------------------------------------------------------

function send(message: unknown): void {
	process.stdout.write(`${JSON.stringify(message)}\n`);
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
	buffer += chunk;
	let newline = buffer.indexOf("\n");
	while (newline !== -1) {
		const line = buffer.slice(0, newline).trim();
		buffer = buffer.slice(newline + 1);
		if (line) void handleLine(line);
		newline = buffer.indexOf("\n");
	}
});

interface McpRequest {
	jsonrpc: string;
	id?: number | string;
	method: string;
	params?: Record<string, unknown>;
}

function isMcpRequest(value: unknown): value is McpRequest {
	if (typeof value !== "object" || value === null) return false;
	const record = value as Record<string, unknown>;
	return (
		typeof record.method === "string" &&
		(record.id === undefined ||
			typeof record.id === "number" ||
			typeof record.id === "string")
	);
}

async function handleLine(line: string): Promise<void> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch {
		return;
	}
	if (!isMcpRequest(parsed)) return;
	const request = parsed;
	const { id, method } = request;
	if (id === undefined) return; // notification — nothing we need
	try {
		switch (method) {
			case "initialize": {
				const params = request.params;
				const clientVersion =
					params && typeof params.protocolVersion === "string"
						? params.protocolVersion
						: "2024-11-05";
				send({
					jsonrpc: "2.0",
					id,
					result: {
						protocolVersion: clientVersion,
						capabilities: { tools: {} },
						serverInfo: { name: `qb-mcp-${slug}`, version: "1.0.0" },
					},
				});
				return;
			}
			case "ping":
				send({ jsonrpc: "2.0", id, result: {} });
				return;
			case "tools/list":
				send({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
				return;
			case "tools/call": {
				const params = request.params;
				if (!params || typeof params.name !== "string")
					throw new Error("tools/call without a tool name");
				const toolArgs =
					typeof params.arguments === "object" && params.arguments !== null
						? (params.arguments as Record<string, unknown>)
						: {};
				const text = await callTool(params.name, toolArgs);
				send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text }] } });
				return;
			}
			default:
				send({
					jsonrpc: "2.0",
					id,
					error: { code: -32601, message: `Method not found: ${method}` },
				});
		}
	} catch (error) {
		send({
			jsonrpc: "2.0",
			id,
			result: {
				content: [
					{ type: "text", text: error instanceof Error ? error.message : String(error) },
				],
				isError: true,
			},
		});
	}
}

log(`ready (connected: ${tokens ? (tokens.companyName ?? tokens.realmId) : "no"})`);
