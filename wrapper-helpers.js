"use strict";

function normalizePanelLine(line) {
	return String(line)
		.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
		.replace(/\r/g, "")
		.trim();
}

function createPanelWriter(write, isRconActive, windowMs, now) {
	const recent = new Map();
	const clock = now || Date.now;

	return function writePanel(text) {
		const timestamp = clock();
		const fresh = [];

		for (const part of String(text).split("\n")) {
			const display = part.replace(/\r/g, "");
			const key = normalizePanelLine(display);
			if (!key) continue;

			if (isRconActive()) {
				const previous = recent.get(key);
				if (previous !== undefined && timestamp - previous < windowMs) continue;
				recent.set(key, timestamp);
			}

			fresh.push(display);
		}

		for (const [key, seenAt] of recent) {
			if (timestamp - seenAt >= windowMs) recent.delete(key);
		}

		if (!fresh.length) return "";
		const output = fresh.join("\n");
		write(output);
		return output;
	};
}

module.exports = {
	createPanelWriter,
	normalizePanelLine
};
