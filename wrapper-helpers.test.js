"use strict";

const assert = require("assert");
const fs = require("fs");
const { createPanelRouter, normalizePanelLine } = require("./wrapper-helpers");

let active = false;
let timestamp = 0;
const output = [];
const panel = createPanelRouter(
	(text) => output.push(text),
	() => active,
	1500,
	() => timestamp
);

// Wrapper status repeats remain visible before RCON.
panel.status("Waiting for RCON");
panel.status("Waiting for RCON");
assert.deepStrictEqual(output, ["Waiting for RCON", "Waiting for RCON"]);

// Exercise the actual process-to-RCON handoff routes. The decorated child copy
// wins if it arrives first; the matching plain RCON copy is suppressed.
timestamp = 100;
panel.process("\u001b[2K\u001b[32m[4.1s] Spawning World\u001b[0m");
active = true;
timestamp = 110;
panel.rcon("Spawning World");
assert.deepStrictEqual(output.slice(2), [
	"\u001b[2K\u001b[32m[4.1s] Spawning World\u001b[0m"
]);

// Process pipes only drain after RCON; the RCON route remains the sole writer.
timestamp = 200;
panel.process("\u001b[33mTerrain Mesh\u001b[0m");
panel.rcon("Terrain Mesh");
assert.strictEqual(output.at(-1), "Terrain Mesh");

// Repeated blocks suppress each pair's second copy without losing distinct lines.
timestamp = 300;
panel.rcon("Train Track Collation\nProcessing World\nGenerated ocean patrol path");
timestamp = 350;
panel.rcon(
	"[0.3s] Train Track Collation\n" +
	"12:34:56 Processing World\n" +
	"[stdout] Generated ocean patrol path\n" +
	"Ocean Patrol Paths"
);
assert.strictEqual(
	output.at(-1),
	"Ocean Patrol Paths"
);

// The same genuine RCON line is allowed after the 1500 ms window.
timestamp = 1900;
panel.rcon("Spawning World");
assert.strictEqual(output.at(-1), "Spawning World");

assert.strictEqual(
	normalizePanelLine("\u001b]0;title\u0007\u001b[2K\u001b[31m[4.1s] Finalizing World\r\u001b[0m"),
	"Finalizing World"
);

// Static integration guardrails for the wrapper's actual child and RCON paths.
const wrapper = fs.readFileSync(require.resolve("./wrapper"), "utf8");
assert.match(wrapper, /stdio:\s*\[['"]ignore['"],\s*['"]pipe['"],\s*['"]pipe['"]\]/);
assert.strictEqual(
	(wrapper.match(/\.on\("data", createGameOutputHandler\(\)\)/g) || []).length,
	2
);
assert.doesNotMatch(wrapper, /stdio:\s*["']inherit["']|\.pipe\(process\.(?:stdout|stderr)\)/);
assert.match(wrapper, /if \(filtered != null\) panel\.process\(filtered\)/);
assert.match(wrapper, /panel\.rcon\(json\.Message\)/);

console.log("wrapper helper tests passed");
