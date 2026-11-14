"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
	createGameOutputHandler,
	createRconMessageHandler,
	prepareSqliteCompatibility
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

function sqliteFixture({ framework = "oxide", target = true, config = "official-config" } = {}) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "aioegg-sqlite-"));
	const managed = path.join(root, "RustDedicated_Data", "Managed");
	const plugins = path.join(root, "RustDedicated_Data", "Plugins", "x86_64");
	fs.mkdirSync(managed, { recursive: true });
	fs.mkdirSync(plugins, { recursive: true });
	const configPath = path.join(managed, "System.Data.SQLite.dll.config");
	const targetPath = path.join(plugins, "libsqlite3.so.0");
	if (config !== null) {
		fs.writeFileSync(configPath, config, { mode: 0o640 });
		fs.chmodSync(configPath, 0o640);
	}
	if (target) fs.writeFileSync(targetPath, "ELF");
	const logs = [];
	const env = { FRAMEWORK: framework };
	const childEnv = prepareSqliteCompatibility({
		env,
		root: root.replace(/\\/g, "/"),
		write: (line) => logs.push(line)
	});
	return { root, managed, configPath, targetPath, logs, env, childEnv };
}

// Oxide gets valid dllmap XML, a preserved one-time backup, and child-only preload control.
const compat = sqliteFixture();
const originalConfigMode = fs.statSync(compat.configPath).mode & 0o777;
const compatXml = fs.readFileSync(compat.configPath, "utf8");
assert.match(compatXml, /^<\?xml version="1\.0" encoding="utf-8"\?>/);
assert.match(compatXml, /<configuration>[\s\S]*<dllmap dll="sqlite3"/);
assert.match(compatXml, /os="!windows,osx" cpu="x86-64"/);
assert.match(compatXml, /RustDedicated_Data\/Plugins\/x86_64\/libsqlite3\.so\.0/);
assert.strictEqual(compat.childEnv.No_PreLoadSQLite, "1");
assert.strictEqual(compat.env.No_PreLoadSQLite, undefined);
const backupPath = `${compat.configPath}.aioegg-backup`;
assert.strictEqual(fs.readFileSync(backupPath, "utf8"), "official-config");
assert.strictEqual(fs.statSync(backupPath).mode & 0o777, originalConfigMode);
fs.writeFileSync(compat.configPath, "changed");
prepareSqliteCompatibility({
	env: { FRAMEWORK: "oxide" },
	root: compat.root.replace(/\\/g, "/")
});
assert.strictEqual(fs.readFileSync(backupPath, "utf8"), "official-config");

// Opt-out restores the immutable first backup and does not set the child variable.
const disabledEnv = prepareSqliteCompatibility({
	env: { FRAMEWORK: "oxide", AIO_SQLITE_COMPAT: "0", No_PreLoadSQLite: "parent-value" },
	root: compat.root.replace(/\\/g, "/")
});
assert.strictEqual(fs.readFileSync(compat.configPath, "utf8"), "official-config");
assert.strictEqual(disabledEnv.No_PreLoadSQLite, "parent-value");

// Missing targets and non-Oxide frameworks preserve the official config.
const missing = sqliteFixture({ target: false });
assert.strictEqual(fs.readFileSync(missing.configPath, "utf8"), "official-config");
assert.strictEqual(missing.childEnv.No_PreLoadSQLite, undefined);
assert.match(missing.logs[0], /^Warning: AIO SQLite compatibility skipped/);
const carbon = sqliteFixture({ framework: "carbon" });
assert.strictEqual(fs.readFileSync(carbon.configPath, "utf8"), "official-config");
assert.strictEqual(carbon.childEnv.No_PreLoadSQLite, undefined);
assert.strictEqual(carbon.logs.length, 0);

// oxide-staging is gated in, and a config created without a backup is removable.
const staging = sqliteFixture({ framework: "oxide-staging", config: null });
assert.strictEqual(staging.childEnv.No_PreLoadSQLite, "1");
assert.strictEqual(fs.existsSync(`${staging.configPath}.aioegg-backup`), false);
prepareSqliteCompatibility({
	env: { FRAMEWORK: "oxide-staging", AIO_SQLITE_COMPAT: "0" },
	root: staging.root.replace(/\\/g, "/")
});
assert.strictEqual(fs.existsSync(staging.configPath), false);

// Static integration guardrails for the wrapper's actual child and RCON paths.
const wrapper = fs.readFileSync(require.resolve("./wrapper"), "utf8");
assert.match(wrapper, /stdio:\s*\[['"]ignore['"],\s*['"]pipe['"],\s*['"]pipe['"]\]/);
assert.strictEqual(
	(wrapper.match(/gameProcess\.(?:stdout|stderr)\.on\("data", createGameOutputHandler\(/g) || []).length,
	2
);
assert.doesNotMatch(wrapper, /stdio:\s*["']inherit["']|\.pipe\(process\.(?:stdout|stderr)\)/);
assert.doesNotMatch(wrapper, /json\.Message|panel\.rcon|appendFile\(["']latest\.log|writeFile\(["']latest\.log/);
assert.match(wrapper, /prepareSqliteCompatibility\(\{ env: process\.env, write: writePanel \}\)/);
assert.match(wrapper, /env:\s*childEnv/);

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
