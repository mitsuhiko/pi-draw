import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";

const HOST = "127.0.0.1";
const TMP_DIR = "/tmp";
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
const TLDRAW_VERSION = "4.5.10";
const REACT_VERSION = "19.2.1";

type SubmitResult = {
	path: string;
	inserted: boolean;
};

export default function (pi: ExtensionAPI) {
	let server: Server | undefined;
	let baseUrl: string | undefined;
	let token = randomUUID();
	let lastCtx: ExtensionContext | undefined;
	let pageConnected = false;
	const eventClients = new Set<ServerResponse>();

	function setLastCtx(ctx: ExtensionContext) {
		lastCtx = ctx;
	}

	function setPageConnected(connected: boolean) {
		pageConnected = connected;
		if (lastCtx?.hasUI) {
			lastCtx.ui.setStatus("draw", connected ? "draw: open" : undefined);
		}
	}

	function insertScreenshotIntoPrompt(path: string): boolean {
		const ctx = lastCtx;
		if (!ctx?.hasUI) return false;

		const ref = `@${path}`;
		const current = ctx.ui.getEditorText();
		const separator = current.length === 0 || /\s$/.test(current) ? "" : " ";
		ctx.ui.setEditorText(`${current}${separator}${ref}`);
		ctx.ui.notify(`Added drawing to prompt: ${path}`, "info");
		return true;
	}

	async function handleSubmit(req: IncomingMessage): Promise<SubmitResult> {
		const body = await readRequestBody(req, MAX_UPLOAD_BYTES);
		if (body.length === 0) {
			throw httpError(400, "Empty screenshot upload.");
		}
		if (!isPng(body)) {
			throw httpError(415, "Expected a PNG screenshot.");
		}

		const fileName = `pi-draw-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}.png`;
		const filePath = join(TMP_DIR, fileName);
		await writeFile(filePath, body, { mode: 0o600 });

		const inserted = insertScreenshotIntoPrompt(filePath);
		return { path: filePath, inserted };
	}

	async function handleRequest(req: IncomingMessage, res: ServerResponse) {
		const url = new URL(req.url ?? "/", `http://${HOST}`);

		if (req.method === "GET" && url.pathname === "/favicon.ico") {
			res.writeHead(204);
			res.end();
			return;
		}

		if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/draw")) {
			if (url.searchParams.get("token") !== token) {
				writeText(res, 403, "Forbidden");
				return;
			}
			writeHtml(res, renderDrawPage(token));
			return;
		}

		if (req.method === "GET" && url.pathname === "/events") {
			if (url.searchParams.get("token") !== token) {
				writeText(res, 403, "Forbidden");
				return;
			}
			handleEvents(req, res);
			return;
		}

		if (req.method === "POST" && url.pathname === "/closed") {
			if (url.searchParams.get("token") !== token) {
				writeJson(res, 403, { ok: false, error: "Forbidden" });
				return;
			}
			for (const client of eventClients) {
				client.end();
			}
			eventClients.clear();
			setPageConnected(false);
			writeJson(res, 200, { ok: true });
			return;
		}

		if (req.method === "POST" && url.pathname === "/submit") {
			if (url.searchParams.get("token") !== token) {
				writeJson(res, 403, { ok: false, error: "Forbidden" });
				return;
			}

			try {
				const result = await handleSubmit(req);
				writeJson(res, 200, { ok: true, ...result });
			} catch (error) {
				const statusCode = getHttpStatus(error);
				writeJson(res, statusCode, { ok: false, error: error instanceof Error ? error.message : String(error) });
			}
			return;
		}

		writeText(res, 404, "Not found");
	}

	function handleEvents(req: IncomingMessage, res: ServerResponse) {
		res.writeHead(200, {
			"Content-Type": "text/event-stream; charset=utf-8",
			"Cache-Control": "no-cache, no-store, must-revalidate",
			Connection: "keep-alive",
			"X-Accel-Buffering": "no",
		});
		res.write("event: ready\ndata: {}\n\n");
		eventClients.add(res);
		setPageConnected(true);

		const ping = setInterval(() => {
			if (!res.destroyed) res.write(": ping\n\n");
		}, 15_000);

		req.on("close", () => {
			clearInterval(ping);
			eventClients.delete(res);
			setPageConnected(eventClients.size > 0);
		});
	}

	async function ensureServer(): Promise<string> {
		if (server && baseUrl) return baseUrl;

		token = randomUUID();
		server = createServer((req, res) => {
			void handleRequest(req, res).catch((error) => {
				const message = error instanceof Error ? error.message : String(error);
				if (!res.headersSent) {
					writeJson(res, 500, { ok: false, error: message });
				} else {
					res.end();
				}
			});
		});

		await new Promise<void>((resolve, reject) => {
			server!.once("error", reject);
			server!.listen(0, HOST, () => resolve());
		});

		const address = server.address();
		if (!address || typeof address === "string") {
			throw new Error("Could not determine draw server port.");
		}

		baseUrl = `http://${HOST}:${address.port}`;
		return baseUrl;
	}

	async function openCanvas(ctx: ExtensionContext) {
		setLastCtx(ctx);
		const urlBase = await ensureServer();
		const url = `${urlBase}/draw?token=${encodeURIComponent(token)}`;

		if (pageConnected) {
			ctx.ui.notify("Drawing canvas is already open. Click Submit there to add screenshots to the prompt.", "info");
			return;
		}

		try {
			await openBrowser(url);
			ctx.ui.notify("Drawing canvas opened. Click Submit to add a screenshot to the prompt.", "info");
		} catch (error) {
			ctx.ui.notify(`Could not open browser: ${error instanceof Error ? error.message : String(error)}. Open ${url} manually.`, "error");
		}
	}

	async function shutdownServer() {
		for (const client of eventClients) {
			client.end();
		}
		eventClients.clear();
		setPageConnected(false);

		if (!server) return;
		const serverToClose = server;
		server = undefined;
		baseUrl = undefined;
		await new Promise<void>((resolve) => serverToClose.close(() => resolve()));
	}

	pi.on("session_start", (_event, ctx) => {
		setLastCtx(ctx);
	});

	pi.on("session_shutdown", async () => {
		await shutdownServer();
		lastCtx = undefined;
	});

	pi.registerShortcut("ctrl+shift+c", {
		description: "Open tldraw canvas and add submitted screenshots to the prompt",
		handler: async (ctx) => {
			await openCanvas(ctx);
		},
	});

	pi.registerCommand("draw", {
		description: "Open tldraw canvas and add submitted screenshots to the prompt",
		handler: async (_args, ctx) => {
			await openCanvas(ctx);
		},
	});
}

async function readRequestBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
	const chunks: Buffer[] = [];
	let total = 0;

	for await (const chunk of req) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		total += buffer.length;
		if (total > maxBytes) {
			throw httpError(413, `Screenshot is too large. Maximum size is ${Math.round(maxBytes / 1024 / 1024)}MB.`);
		}
		chunks.push(buffer);
	}

	return Buffer.concat(chunks);
}

function isPng(buffer: Buffer): boolean {
	return (
		buffer.length >= 8 &&
		buffer[0] === 0x89 &&
		buffer[1] === 0x50 &&
		buffer[2] === 0x4e &&
		buffer[3] === 0x47 &&
		buffer[4] === 0x0d &&
		buffer[5] === 0x0a &&
		buffer[6] === 0x1a &&
		buffer[7] === 0x0a
	);
}

function httpError(statusCode: number, message: string): Error & { statusCode: number } {
	const error = new Error(message) as Error & { statusCode: number };
	error.statusCode = statusCode;
	return error;
}

function getHttpStatus(error: unknown): number {
	if (error && typeof error === "object" && "statusCode" in error) {
		const statusCode = Number((error as { statusCode: unknown }).statusCode);
		if (Number.isInteger(statusCode) && statusCode >= 400 && statusCode < 600) return statusCode;
	}
	return 500;
}

function writeHtml(res: ServerResponse, html: string) {
	res.writeHead(200, {
		"Content-Type": "text/html; charset=utf-8",
		"Cache-Control": "no-cache, no-store, must-revalidate",
	});
	res.end(html);
}

function writeText(res: ServerResponse, statusCode: number, text: string) {
	res.writeHead(statusCode, {
		"Content-Type": "text/plain; charset=utf-8",
		"Cache-Control": "no-cache, no-store, must-revalidate",
	});
	res.end(text);
}

function writeJson(res: ServerResponse, statusCode: number, value: unknown) {
	res.writeHead(statusCode, {
		"Content-Type": "application/json; charset=utf-8",
		"Cache-Control": "no-cache, no-store, must-revalidate",
	});
	res.end(JSON.stringify(value));
}

function openBrowser(url: string): Promise<void> {
	const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
	const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];

	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { detached: true, stdio: "ignore" });
		child.once("error", reject);
		child.once("spawn", () => {
			child.unref();
			resolve();
		});
	});
}

function renderDrawPage(token: string): string {
	const tokenJson = JSON.stringify(token);
	const tldrawVersion = encodeURIComponent(TLDRAW_VERSION);
	const reactVersion = encodeURIComponent(REACT_VERSION);
	return `<!doctype html>
<html lang="en">
<head>
	<meta charset="utf-8" />
	<meta name="viewport" content="width=device-width, initial-scale=1" />
	<title>pi draw</title>
	<link rel="stylesheet" href="https://unpkg.com/tldraw@${tldrawVersion}/tldraw.css" />
	<style>
		:root {
			--ink: #16130f;
			--paper: #f8f0da;
			--panel: rgba(248, 240, 218, 0.92);
			--accent: #f05a28;
			--accent-dark: #a63416;
			--ok: #176d3a;
			--warn: #9d6500;
			--err: #a31919;
			--shadow: 0 12px 34px rgba(22, 19, 15, 0.22);
		}

		* { box-sizing: border-box; }
		html, body, #root { width: 100%; height: 100%; margin: 0; }
		body {
			background: var(--paper);
			color: var(--ink);
			font-family: ui-serif, Georgia, Cambria, "Times New Roman", serif;
			overflow: hidden;
		}
		#root { position: fixed; inset: 0; }

		.draw-submit-wrap {
			position: fixed;
			right: 0;
			bottom: 0;
			z-index: 10000;
			padding: 8px;
			border: 1px solid rgba(0, 0, 0, 0.08);
			border-right: 0;
			border-bottom: 0;
			border-radius: 20px 0 0 0;
			background: rgba(255, 255, 255, 0.94);
			box-shadow: 0 3px 10px rgba(0, 0, 0, 0.16), 0 18px 42px rgba(0, 0, 0, 0.12);
			backdrop-filter: blur(18px) saturate(1.15);
		}

		.draw-button {
			appearance: none;
			border: 0;
			border-radius: 12px;
			background: #2f80ed;
			color: white;
			cursor: pointer;
			font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
			font-size: 15px;
			font-weight: 700;
			line-height: 1;
			padding: 17px 22px;
			box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.22);
			transition: transform 120ms ease, background 120ms ease, opacity 120ms ease;
		}

		.draw-button:hover:not(:disabled) {
			background: #2374df;
		}

		.draw-button:active:not(:disabled) {
			transform: scale(0.97);
		}

		.draw-button:disabled {
			opacity: 0.5;
			cursor: default;
		}

		.draw-button.is-submitting {
			opacity: 0.72;
		}

		.draw-button.did-submit {
			background: #1f9d55;
		}

		.draw-button.did-error {
			background: #d64545;
		}

		@media (prefers-reduced-motion: reduce) {
			.draw-button { transition: none; }
		}
	</style>
</head>
<body>
	<div id="root"></div>
	<div class="draw-submit-wrap">
		<button id="submit" class="draw-button" type="button" disabled>Submit to Pi</button>
	</div>

	<script type="module">
		import React from "https://esm.sh/react@${reactVersion}";
		import { createRoot } from "https://esm.sh/react-dom@${reactVersion}/client";
		import { Tldraw } from "https://esm.sh/tldraw@${tldrawVersion}?deps=react@${reactVersion},react-dom@${reactVersion}";

		const TOKEN = ${tokenJson};
		const submitButton = document.getElementById("submit");
		let editor = null;
		let submitting = false;
		let feedbackTimer = null;

		function flashButton(className) {
			submitButton.classList.remove("did-submit", "did-error");
			if (feedbackTimer) clearTimeout(feedbackTimer);
			submitButton.classList.add(className);
			feedbackTimer = setTimeout(() => submitButton.classList.remove(className), 650);
		}

		function updateButton() {
			submitButton.disabled = !editor || submitting;
			submitButton.classList.toggle("is-submitting", submitting);
			submitButton.setAttribute("aria-busy", submitting ? "true" : "false");
		}

		async function submitDrawing() {
			if (!editor || submitting) return;

			const ids = Array.from(editor.getCurrentPageShapeIds());
			if (ids.length === 0) {
				flashButton("did-error");
				return;
			}

			submitting = true;
			updateButton();

			try {
				if (editor.fonts?.loadRequiredFontsForCurrentPage) {
					await editor.fonts.loadRequiredFontsForCurrentPage(editor.options.maxFontsToLoadBeforeRender);
				}

				const result = await editor.toImage(ids, {
					format: "png",
					background: true,
					padding: 48,
					scale: 2,
					darkMode: false,
				});
				if (!result?.blob) throw new Error("Could not render this drawing.");

				const response = await fetch("/submit?token=" + encodeURIComponent(TOKEN), {
					method: "POST",
					headers: { "Content-Type": "image/png" },
					body: result.blob,
				});
				const data = await response.json().catch(() => ({}));
				if (!response.ok || !data.ok) {
					throw new Error(data.error || response.statusText || "Submit failed");
				}

				flashButton(data.inserted ? "did-submit" : "did-error");
			} catch (error) {
				console.error(error);
				flashButton("did-error");
			} finally {
				submitting = false;
				updateButton();
			}
		}

		submitButton.addEventListener("click", submitDrawing);

		const events = new EventSource("/events?token=" + encodeURIComponent(TOKEN));

		function notifyClosed() {
			try {
				navigator.sendBeacon("/closed?token=" + encodeURIComponent(TOKEN), new Blob([], { type: "text/plain" }));
			} catch (_) {
				// Best effort only.
			}
		}
		window.addEventListener("pagehide", notifyClosed);
		window.addEventListener("beforeunload", notifyClosed);

		function App() {
			return React.createElement(Tldraw, {
				persistenceKey: "pi-draw-canvas",
				autoFocus: true,
				onMount: (mountedEditor) => {
					editor = mountedEditor;
					updateButton();
					return () => {
						editor = null;
						updateButton();
					};
				},
			});
		}

		createRoot(document.getElementById("root")).render(React.createElement(App));
	</script>
</body>
</html>`;
}
