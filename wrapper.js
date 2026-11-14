#!/usr/bin/env node

var startupCmd = "";
const fs = require("fs");
fs.writeFile("latest.log", "", (err) => {
	if (err) console.log("Callback error in appendFile:" + err);
});

var args = process.argv.splice(process.execArgv.length + 2);
for (var i = 0; i < args.length; i++) {
	if (i === args.length - 1) {
		startupCmd += args[i];
	} else {
		startupCmd += args[i] + " ";
	}
}

if (startupCmd.length < 1) {
	console.log("Error: Please specify a startup command.");
	process.exit();
}

const seenPercentage = {};

function filterLine(line) {
    const str = String(line).replace(/\r/g, "");
    if (!str) return null;
    if(str.startsWith("Fallback handler could not load library")) return null; // Remove fallback
    if(str.includes("Filename:")) return null; //Remove bindings.h
	if(str.includes("ERROR: Shader ")) return null; //Remove shader errors
	if(str.includes("WARNING: Shader ")) return null; //Remove shader errors
    if (str.startsWith("Loading Prefab Bundle ")) { // Rust seems to spam the same percentage, so filter out any duplicates.
        const percentage = str.substr("Loading Prefab Bundle ".length);
        if (seenPercentage[percentage]) return null;

        seenPercentage[percentage] = true;
    }

    return str;
}

const { spawn } = require("child_process");
console.log("Starting Rust...");

// Networking/runtime mitigations for Mono/Unity
// - Disable IPv6 in Mono to avoid dual-stack socket issues on some hosts
process.env.MONO_DISABLE_IPV6 = process.env.MONO_DISABLE_IPV6 || '1';
process.env.DOTNET_SYSTEM_NET_DISABLEIPV6 = process.env.DOTNET_SYSTEM_NET_DISABLEIPV6 || '1';
// Optional: enable verbose Mono logging via env toggle MONO_LOGGING
// Accepts: 1/true/yes/on (case-insensitive)
const _monoLoggingRaw = (process.env.MONO_LOGGING || '').toLowerCase();
const _monoLogging = _monoLoggingRaw === '1' || _monoLoggingRaw === 'true' || _monoLoggingRaw === 'yes' || _monoLoggingRaw === 'on';
if (_monoLogging) {
    process.env.MONO_LOG_LEVEL = process.env.MONO_LOG_LEVEL || 'debug';
    process.env.MONO_LOG_MASK = process.env.MONO_LOG_MASK || 'all';
    process.env.MONO_LOG_DEST = process.env.MONO_LOG_DEST || 'file:/home/container/mono-debug.log';
}

// Optional: prevent stdio fds (0/1/2) from being closed via LD_PRELOAD shim
// Controlled by PREVENT_FD toggle: 1/true/yes/on
const _preventFdRaw = (process.env.PREVENT_FD || '').toLowerCase();
const _preventFd = _preventFdRaw === '1' || _preventFdRaw === 'true' || _preventFdRaw === 'yes' || _preventFdRaw === 'on';
if (_preventFd) {
    const preloadPath = '/usr/local/lib/libkeepstdio.so';
    process.env.LD_PRELOAD = process.env.LD_PRELOAD
        ? `${preloadPath}:${process.env.LD_PRELOAD}`
        : preloadPath;
}

// Prefer keeping stdin (fd 0) open to avoid Mono fd reuse
// Spawn via bash -lc to preserve shell expansions present in the startup string
var exited = false;
// Ensure child stdin (fd 0) is a valid file descriptor (map to /dev/null)
// This avoids Mono reusing fd 0 for sockets/files and aborting.
// When MONO_LOGGING is enabled, also run under a PTY via `script` to provide a
// controlling terminal which further reduces the chance of stdio being closed.
let usePty = _monoLogging; // tie PTY usage to MONO_LOGGING as requested
// If PREVENT_FD is enabled, prefer launching directly via bash to avoid any env sanitization by `script`
if (_preventFd) usePty = false;
const spawnCmd = usePty ? 'script' : 'bash';
const spawnArgs = usePty
    ? ['-qfec', startupCmd, '/dev/null']
    : ['-lc', startupCmd];

const gameProcess = spawn(spawnCmd, spawnArgs, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env
});
// If MONO_LOGGING is enabled, tee raw stdout/stderr to mono-debug.log as a fallback
let monoLogStream = null;
if (_monoLogging) {
    try {
        monoLogStream = fs.createWriteStream('/home/container/mono-debug.log', { flags: 'a' });
    } catch (e) {
        console.log('Failed to open mono-debug.log for writing: ' + (e?.message || e));
    }
}

// True until RCON is delivering game lines. While false, the pipes are drained
// and not written to the panel. A dropped socket turns this back on so map
// generation stays visible, then the next open silences it again.
let forwardGameOutput = true;
let pendingStdout = "";
const recentConsoleLines = new Map();
// Rust sends the same line again inside a later multi-line RCON payload.
// Reprinting that whole payload is what doubled Spawning World, the track
// burst, Finalizing World, and the Chaos check. Suppress a line already shown.
const DEDUPE_MS = 10000;

function lineKey(line) {
    return String(line).replace(/\u001b\[[0-9;]*m/g, "").replace(/\r/g, "").trim();
}

function emitConsoleLines(text) {
    const now = Date.now();
    const fresh = [];
    const parts = String(text).split("\n");
    for (const part of parts) {
        const display = String(part).replace(/\r/g, "");
        const key = lineKey(display);
        if (!key) continue;
        const at = recentConsoleLines.get(key);
        if (at !== undefined && now - at < DEDUPE_MS) continue;
        recentConsoleLines.set(key, now);
        fresh.push(display);
    }
    if (recentConsoleLines.size > 500) {
        for (const [key, at] of recentConsoleLines) {
            if (now - at > DEDUPE_MS) recentConsoleLines.delete(key);
        }
    }
    if (!fresh.length) return "";
    const shown = fresh.join("\n");
    console.log(shown);
    return shown;
}

function onGameOutput(data) {
    if (monoLogStream) monoLogStream.write(data);
    if (!forwardGameOutput) return;
    pendingStdout += data.toString();
    let nl = pendingStdout.indexOf("\n");
    while (nl !== -1) {
        const line = pendingStdout.slice(0, nl);
        pendingStdout = pendingStdout.slice(nl + 1);
        const filtered = filterLine(line);
        if (filtered != null) emitConsoleLines(filtered);
        nl = pendingStdout.indexOf("\n");
    }
}

function drainGameOutput(data) {
    if (monoLogStream) monoLogStream.write(data);
}

function watchGameOutput(stream, handler) {
    if (!stream) return;
    stream.removeAllListeners("data");
    stream.on("data", handler);
}

function silenceGameOutput() {
    forwardGameOutput = false;
    pendingStdout = "";
    watchGameOutput(gameProcess.stdout, drainGameOutput);
    watchGameOutput(gameProcess.stderr, drainGameOutput);
}

function resumeGameOutput() {
    if (forwardGameOutput) return;
    forwardGameOutput = true;
    pendingStdout = "";
    watchGameOutput(gameProcess.stdout, onGameOutput);
    watchGameOutput(gameProcess.stderr, onGameOutput);
}

watchGameOutput(gameProcess.stdout, onGameOutput);
watchGameOutput(gameProcess.stderr, onGameOutput);
gameProcess.on('exit', function (code, signal) {
	exited = true;
	if (retryTimer) {
		clearTimeout(retryTimer);
		retryTimer = null;
	}

	if (code) {
		console.log("Main game process exited with code " + code);
		// process.exit(code);
	}
    if (monoLogStream) {
        try { monoLogStream.end(); } catch {}
    }
});

function initialListener(data) {
	const command = data.toString().trim();
	if (command === 'quit') {
		gameProcess.kill('SIGTERM');
	} else {
		console.log('Unable to run "' + command + '" due to RCON not being connected yet.');
	}
}
process.stdin.resume();
process.stdin.setEncoding("utf8");
process.stdin.on('data', initialListener);

process.on('exit', function (code) {
	if (exited) return;

	console.log("Received request to stop the process, stopping the game...");
	gameProcess.kill('SIGTERM');
});

function createPacket(command) {
	var packet = {
		Identifier: -1,
		Message: command,
		Name: "WebRcon"
	};
	return JSON.stringify(packet);
}

var waiting = true;
var consoleSocket = null;
var retryTimer = null;
var attemptId = 0;
var stdinHooked = false;
var dialing = false;
var connectedOnce = false;

function splitJsonObjects(text) {
	var out = [];
	var depth = 0;
	var start = -1;
	var inStr = false;
	var esc = false;
	for (var i = 0; i < text.length; i++) {
		var ch = text[i];
		if (inStr) {
			if (esc) esc = false;
			else if (ch === "\\") esc = true;
			else if (ch === "\"") inStr = false;
			continue;
		}
		if (ch === "\"") {
			inStr = true;
			continue;
		}
		if (ch === "{") {
			if (depth === 0) start = i;
			depth++;
		} else if (ch === "}") {
			depth--;
			if (depth === 0 && start !== -1) {
				try {
					out.push(JSON.parse(text.slice(start, i + 1)));
				} catch (e) {}
				start = -1;
			}
		}
	}
	return out;
}

function payloadsFromFrame(data) {
	var text = Buffer.isBuffer(data) ? data.toString() : String(data);
	try {
		var one = JSON.parse(text);
		return one === undefined ? [] : [one];
	} catch (e) {
		var parts = splitJsonObjects(text);
		if (!parts.length && e) console.log(e);
		return parts;
	}
}

var poll = function () {
	if (dialing) return;
	if (consoleSocket && (consoleSocket.readyState === 0 || consoleSocket.readyState === 1)) return;

	dialing = true;
	var myId = ++attemptId;
	var serverHostname = process.env.RCON_IP ? process.env.RCON_IP : "localhost";
	var serverPort = process.env.RCON_PORT;
	var serverPassword = process.env.RCON_PASS;
	var WebSocket = require("ws");
	var ws = new WebSocket("ws://" + serverHostname + ":" + serverPort + "/" + serverPassword);
	var finished = false;
	var errorTimer = null;

	// A dropped socket must not exit the wrapper. Exit code 0 is what made the
	// panel restart Rust during map generation. Reconnect on this socket only.
	function finish(liveClose) {
		if (finished) return;
		finished = true;
		dialing = false;
		if (errorTimer) {
			clearTimeout(errorTimer);
			errorTimer = null;
		}
		try { ws.removeAllListeners("message"); } catch (e) {}
		if (consoleSocket === ws) consoleSocket = null;
		if (ws.readyState === 0 || ws.readyState === 1) {
			try { ws.close(); } catch (e) {}
		}
		if (exited) return;
		if (liveClose) {
			console.log("Connection to server closed.");
			waiting = true;
			resumeGameOutput();
		} else if (myId === attemptId) {
			waiting = true;
			console.log("Waiting for RCON to come up...");
		}
		if (myId !== attemptId) return;
		if (retryTimer) clearTimeout(retryTimer);
		retryTimer = setTimeout(function () {
			retryTimer = null;
			poll();
		}, liveClose ? 1000 : 5000);
	}

	ws.on("open", function open() {
		if (myId !== attemptId) {
			finished = true;
			try { ws.removeAllListeners("message"); } catch (e) {}
			try { ws.close(); } catch (e) {}
			return;
		}
		dialing = false;
		consoleSocket = ws;
		// One source after this. Stdout stays drained until the socket drops.
		silenceGameOutput();
		if (!connectedOnce) {
			connectedOnce = true;
			console.log("Connected to RCON. Generating the map now. Please wait until the server status switches to \"Running\".");
		} else {
			console.log("Reconnected to RCON.");
		}
		waiting = false;

		// Hack to fix broken console output
		try { ws.send(createPacket("status")); } catch (e) {}

		process.stdin.removeListener("data", initialListener);
		if (!stdinHooked) {
			stdinHooked = true;
			process.stdin.on("data", function (text) {
				if (consoleSocket && consoleSocket.readyState === 1) {
					try { consoleSocket.send(createPacket(text)); } catch (e) {}
				} else if (String(text).trim() === "quit") {
					gameProcess.kill("SIGTERM");
				}
			});
		}
	});

	ws.on("message", function (data) {
		if (ws !== consoleSocket) return;
		var payloads = payloadsFromFrame(data);
		for (var p = 0; p < payloads.length; p++) {
			var json = payloads[p];
			if (!json || typeof json.Message !== "string" || json.Message.length === 0) continue;
			var shown = emitConsoleLines(json.Message);
			if (!shown) continue;
			fs.appendFile("latest.log", "\n" + shown, function (err) {
				if (err) console.log("Callback error in appendFile:" + err);
			});
		}
	});

	ws.on("error", function () {
		if (finished || (myId !== attemptId && consoleSocket !== ws)) return;
		if (ws.readyState === 1) return;
		if (errorTimer) clearTimeout(errorTimer);
		errorTimer = setTimeout(function () {
			errorTimer = null;
			if (finished || (myId !== attemptId && consoleSocket !== ws)) return;
			finish(consoleSocket === ws);
		}, 250);
	});

	ws.on("close", function () {
		if (finished || (myId !== attemptId && consoleSocket !== ws)) return;
		if (errorTimer) {
			clearTimeout(errorTimer);
			errorTimer = null;
		}
		finish(consoleSocket === ws);
	});
}
poll();
