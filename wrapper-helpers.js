"use strict";

function normalizePanelLine(line) {
	return String(line)
		// OSC sequences (for example terminal-title controls).
		.replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, "")
		// DCS/SOS/PM/APC strings terminated by ST.
		.replace(/\u001b[PX^_][\s\S]*?\u001b\\/g, "")
		// CSI sequences, including non-colour cursor/erase controls.
		.replace(/(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]/g, "")
		// Remaining two-character ANSI escape sequences.
		.replace(/\u001b[@-_]/g, "")
		.replace(/\r/g, "")
		// Rust's wrapper timing prefix and common timestamp/log-level decoration.
		.replace(/^\s*\[\d+(?:\.\d+)?s\]\s*/i, "")
		.replace(/^\s*(?:\[[^\]]*(?:\d{1,4}[:./-]\d{1,4}|stdout|stderr|info|warn|error)[^\]]*\]\s*)+/i, "")
		.replace(/^\s*\d{1,2}:\d{2}:\d{2}(?:[.,]\d+)?\s+/, "")
		.replace(/^\s*(?:stdout|stderr|info|warn|error)\s*[:|]\s*/i, "")
		.trim();
}

function createPanelRouter(write, isRconActive, windowMs, now) {
	const recent = new Map();
	const clock = now || Date.now;

	function clean(timestamp) {
		for (const [key, seenAt] of recent) {
			if (timestamp - seenAt >= windowMs) recent.delete(key);
		}
	}

	function emit(text, deduplicate) {
		const timestamp = clock();
		const fresh = [];

		for (const part of String(text).split("\n")) {
			const display = part.replace(/\r/g, "");
			const key = normalizePanelLine(display);
			if (!key) continue;

			if (deduplicate) {
				const previous = recent.get(key);
				if (previous !== undefined && timestamp - previous < windowMs) continue;
			}

			recent.set(key, timestamp);
			fresh.push(display);
		}

		clean(timestamp);

		if (!fresh.length) return "";
		const output = fresh.join("\n");
		write(output);
		return output;
	}

	return {
		// Process output is visible only before the first RCON open. Recording it
		// here lets the first matching RCON line be suppressed across the handoff.
		process(text) {
			if (isRconActive()) return "";
			return emit(text, false);
		},
		// RCON is the only game-output panel route after connection.
		rcon(text) {
			return emit(text, true);
		},
		// Wrapper lifecycle/status messages must not disappear as duplicate game
		// output and remain visible while RCON is unavailable.
		status(text) {
			return emit(text, false);
		}
	};
}

function createPanelWriter(write, isRconActive, windowMs, now) {
	const router = createPanelRouter(write, isRconActive, windowMs, now);
	return function writePanel(text) {
		return isRconActive() ? router.rcon(text) : router.status(text);
	};
}

module.exports = {
	createPanelRouter,
	createPanelWriter,
	normalizePanelLine
};
