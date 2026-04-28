import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";

const CREDENTIALS_FILE = process.env.CLAUDE_USAGE_CREDENTIALS
	?? join(homedir(), ".claude", ".credentials.json");
const API_URL = "https://api.anthropic.com/api/oauth/usage";

const CACHE_TTL_MS = Number(process.env.CLAUDE_QUOTA_CACHE_TTL ?? 300) * 1000;
const POLL_MS = Math.max(CACHE_TTL_MS, 60_000);

const THRESHOLD_LOW = Number(process.env.CLAUDE_QUOTA_THRESHOLD_LOW ?? 50);
const THRESHOLD_MED = Number(process.env.CLAUDE_QUOTA_THRESHOLD_MED ?? 80);

const STATUS_KEY = "claude-quota";

interface UsageBucket {
	utilization?: number;
	resets_at?: string;
}
interface UsageResponse {
	five_hour?: UsageBucket;
	seven_day?: UsageBucket;
}

interface CacheEntry { fetchedAt: number; text: string }
let cache: CacheEntry | null = null;

function readTokenFromFile(): string | null {
	if (!existsSync(CREDENTIALS_FILE)) return null;
	try {
		const data = JSON.parse(readFileSync(CREDENTIALS_FILE, "utf-8"));
		return data?.claudeAiOauth?.accessToken ?? null;
	} catch {
		return null;
	}
}

function readTokenFromKeychain(): string | null {
	if (platform() !== "darwin") return null;
	try {
		const out = execFileSync(
			"security",
			["find-generic-password", "-s", "Claude Code-credentials", "-w"],
			{ encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], timeout: 3000 },
		).trim();
		const data = JSON.parse(out);
		return data?.claudeAiOauth?.accessToken ?? null;
	} catch {
		return null;
	}
}

function readToken(): string | null {
	return readTokenFromFile() ?? readTokenFromKeychain();
}

function fmtTimeUntil(iso?: string): string {
	if (!iso) return "?";
	const t = Date.parse(iso);
	if (!Number.isFinite(t)) return "?";
	const diff = t - Date.now();
	if (diff <= 0) return "0m";
	const m = Math.floor(diff / 60_000);
	const h = Math.floor(diff / 3_600_000);
	const d = Math.floor(diff / 86_400_000);
	if (h < 1) return `${m}m`;
	if (h < 24) return `${h}h`;
	return `${d}d`;
}

function colorPrefix(util: number): string {
	if (util < THRESHOLD_LOW) return "\x1b[1;37m";
	if (util < THRESHOLD_MED) return "\x1b[38;5;136m";
	return "\x1b[38;5;160m";
}

function colorize(util: number, text: string): string {
	return `${colorPrefix(util)}${text}\x1b[0m`;
}

const BAR_WIDTH = Number(process.env.CLAUDE_QUOTA_BAR_WIDTH ?? 8);

const WINDOW_5H_MS = 5 * 3600_000;
const WINDOW_7D_MS = 7 * 86400_000;

function elapsedFraction(resetsAt: string | undefined, windowMs: number): number | null {
	if (!resetsAt) return null;
	const end = Date.parse(resetsAt);
	if (!Number.isFinite(end)) return null;
	const remaining = end - Date.now();
	const frac = 1 - remaining / windowMs;
	if (!Number.isFinite(frac)) return null;
	return Math.max(0, Math.min(1, frac));
}

// Bar colors (256-color palette)
const FILL_BG = 250;    // light grey for filled cells
const TRACK_BG = 238;   // dim grey for empty cells
const MARKER_BG = 87;   // bright cyan

// Half-block edge characters used as soft caps:
//   ▐ (right half block) drawn in fill/track color = filled-right-half cell -> left cap
//   ▌ (left half block)  drawn in fill/track color = filled-left-half  cell -> right cap
function bar(util: number, paceMarker: number | null, _restoreColor: string, width = BAR_WIDTH): string {
	const clamped = Math.max(0, Math.min(100, util));
	const filled = Math.round((clamped / 100) * width);
	const cells: string[] = [];
	for (let i = 0; i < width; i++) {
		const bg = i < filled ? FILL_BG : TRACK_BG;
		cells.push(`\x1b[48;5;${bg}m \x1b[0m`);
	}
	if (paceMarker !== null && width > 0) {
		const idx = Math.max(0, Math.min(width - 1, Math.round(paceMarker * (width - 1))));
		cells[idx] = `\x1b[48;5;${MARKER_BG}m \x1b[0m`;
	}
	const leftColor = filled > 0 ? FILL_BG : TRACK_BG;
	const rightColor = filled >= width ? FILL_BG : TRACK_BG;
	const left = `\x1b[38;5;${leftColor}m▐\x1b[0m`;
	const right = `\x1b[38;5;${rightColor}m▌\x1b[0m`;
	return `${left}${cells.join("")}${right}`;
}

function paceMarker(util: number, elapsed: number | null): number | null {
	if (elapsed === null) return null;
	const expected = elapsed * 100;
	if (expected <= 0) return util > 0 ? 1 : 0;
	const ratio = util / expected; // 1 == on pace
	return Math.max(0, Math.min(1, ratio / 2)); // 1 -> 0.5
}

function format(usage: UsageResponse): string {
	const u5 = Math.floor(usage.five_hour?.utilization ?? 0);
	const u7 = Math.floor(usage.seven_day?.utilization ?? 0);
	const t5 = fmtTimeUntil(usage.five_hour?.resets_at);
	const t7 = fmtTimeUntil(usage.seven_day?.resets_at);
	const e5 = elapsedFraction(usage.five_hour?.resets_at, WINDOW_5H_MS);
	const e7 = elapsedFraction(usage.seven_day?.resets_at, WINDOW_7D_MS);
	const m5 = paceMarker(u5, e5);
	const m7 = paceMarker(u7, e7);
	const c5 = colorPrefix(u5);
	const c7 = colorPrefix(u7);
	return `${c5}5h ${bar(u5, m5, c5)} ${u5}%·${t5}\x1b[0m ${c7}7d ${bar(u7, m7, c7)} ${u7}%·${t7}\x1b[0m`;
}

async function fetchUsage(): Promise<string | null> {
	const token = readToken();
	if (!token) return null;
	try {
		const res = await fetch(API_URL, {
			headers: {
				Authorization: `Bearer ${token}`,
				"anthropic-beta": "oauth-2025-04-20",
				"Content-Type": "application/json",
			},
			signal: AbortSignal.timeout(5000),
		});
		if (!res.ok) return null;
		const data = (await res.json()) as UsageResponse;
		return format(data);
	} catch {
		return null;
	}
}

async function getStatus(): Promise<string> {
	if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) return cache.text;
	const fresh = await fetchUsage();
	if (fresh) {
		cache = { fetchedAt: Date.now(), text: fresh };
		return fresh;
	}
	if (cache) return cache.text + "~"; // stale marker
	return "5h:--(?) 7d:--(?)";
}

export default function (pi: ExtensionAPI) {
	let timer: NodeJS.Timeout | null = null;
	let ctxRef: ExtensionContext | null = null;

	async function refresh() {
		if (!ctxRef) return;
		const text = await getStatus();
		ctxRef.ui.setStatus(STATUS_KEY, text);
	}

	pi.on("session_start", async (_e, ctx) => {
		ctxRef = ctx;
		if (timer) clearInterval(timer);
		timer = setInterval(() => { void refresh(); }, POLL_MS);
		void refresh();
	});

	pi.on("session_shutdown", () => {
		if (timer) { clearInterval(timer); timer = null; }
		ctxRef = null;
	});

	pi.registerCommand("claude-quota", {
		description: "Refresh Claude Code 5h/7d API quota display",
		handler: async (_args, ctx) => {
			cache = null;
			ctxRef = ctx;
			await refresh();
			const text = await getStatus();
			ctx.ui.notify(`Claude quota: ${text.replace(/\x1b\[[0-9;]*m/g, "")}`, "info");
		},
	});
}
