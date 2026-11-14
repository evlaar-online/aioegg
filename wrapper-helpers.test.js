"use strict";

const assert = require("assert");
const fs = require("fs");
const {
	createGameOutputHandler,
	createRconMessageHandler
} = require("./wrapper-helpers");

const output = [];
const childOutput = createGameOutputHandler(
	(text) => output.push(text),
	(line) => line.replace(/\r/g, ""),
	() => null
);

// Child output is printed once and genuine repeated lines remain repeated.
childOutput(Buffer.from("Spawning World\n"));
assert.deepStrictEqual(output, ["Spawning World"]);
childOutput(Buffer.from("Processing World\nProcessing World\n"));
assert.deepStrictEqual(output, [
	"Spawning World",
	"Processing World",
	"Processing World"
]);

// Split child chunks still produce one panel line.
childOutput(Buffer.from("Finalizing "));
childOutput(Buffer.from("World\n"));
assert.strictEqual(output.at(-1), "Finalizing World");

// RCON game messages are parsed but have no panel writer and emit zero lines.
const beforeRcon = output.length;
let parsedRcon;
const rconMessage = createRconMessageHandler((data) => {
	parsedRcon = JSON.parse(String(data));
	return [parsedRcon];
});
rconMessage(Buffer.from('{"Message":"Spawning World","Identifier":1}'));
assert.strictEqual(parsedRcon.Message, "Spawning World");
assert.strictEqual(output.length, beforeRcon);

// Static integration guardrails for the wrapper's actual child and RCON paths.
const wrapper = fs.readFileSync(require.resolve("./wrapper"), "utf8");
assert.match(wrapper, /stdio:\s*\[['"]ignore['"],\s*['"]pipe['"],\s*['"]pipe['"]\]/);
assert.strictEqual(
	(wrapper.match(/gameProcess\.(?:stdout|stderr)\.on\("data", createGameOutputHandler\(/g) || []).length,
	2
);
assert.doesNotMatch(wrapper, /stdio:\s*["']inherit["']|\.pipe\(process\.(?:stdout|stderr)\)/);
assert.doesNotMatch(wrapper, /json\.Message|panel\.rcon|appendFile\(["']latest\.log|writeFile\(["']latest\.log/);

// RCON close/error only schedule reconnects; they never terminate the wrapper.
const rconLifecycle = wrapper.slice(
	wrapper.indexOf("function finish(wasConnected)"),
	wrapper.lastIndexOf("\npoll();")
);
assert.doesNotMatch(rconLifecycle, /process\.exit(?:Code)?\s*=|process\.exit\(/);
assert.match(rconLifecycle, /setTimeout\(function \(\) \{[\s\S]*poll\(\)/);

// Only the Rust child exit determines the wrapper's resulting exit code.
const childExit = wrapper.slice(
	wrapper.indexOf("gameProcess.on('exit'"),
	wrapper.indexOf("function initialListener")
);
assert.match(childExit, /process\.exitCode = typeof code === "number" \? code : 1/);
assert.strictEqual((wrapper.match(/process\.exitCode\s*=/g) || []).length, 1);

console.log("wrapper helper tests passed");
