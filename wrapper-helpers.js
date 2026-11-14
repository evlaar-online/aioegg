"use strict";

function createGameOutputHandler(write, filterLine, getLogStream) {
	let pending = "";

	return function onGameOutput(data) {
		const logStream = getLogStream && getLogStream();
		if (logStream) logStream.write(data);

		pending += data.toString();
		let newline = pending.indexOf("\n");
		while (newline !== -1) {
			const line = pending.slice(0, newline);
			pending = pending.slice(newline + 1);
			const filtered = filterLine(line);
			if (filtered != null) write(filtered);
			newline = pending.indexOf("\n");
		}
	};
}

function createRconMessageHandler(parseFrame) {
	return function onRconMessage(data) {
		return parseFrame(data);
	};
}

module.exports = {
	createGameOutputHandler,
	createRconMessageHandler
};
