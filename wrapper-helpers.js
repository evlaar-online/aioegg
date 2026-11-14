"use strict";

const fs = require("fs");

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

const SQLITE_CONFIG_MARKER = "aioegg-sqlite-compat";

function atomicWrite(fsImpl, path, contents, mode) {
	const tempPath = `${path}.aioegg-tmp-${process.pid}`;
	try {
		fsImpl.writeFileSync(tempPath, contents, { encoding: "utf8", mode });
		fsImpl.chmodSync(tempPath, mode);
		fsImpl.renameSync(tempPath, path);
	} catch (error) {
		try { fsImpl.unlinkSync(tempPath); } catch {}
		throw error;
	}
}

function restoreSqliteConfig(fsImpl, configPath, backupPath) {
	if (fsImpl.existsSync(backupPath)) {
		const backup = fsImpl.readFileSync(backupPath);
		const mode = fsImpl.statSync(backupPath).mode & 0o777;
		const tempPath = `${configPath}.aioegg-tmp-${process.pid}`;
		try {
			fsImpl.writeFileSync(tempPath, backup, { mode });
			fsImpl.chmodSync(tempPath, mode);
			fsImpl.renameSync(tempPath, configPath);
		} catch (error) {
			try { fsImpl.unlinkSync(tempPath); } catch {}
			throw error;
		}
		return true;
	}

	if (fsImpl.existsSync(configPath) &&
		fsImpl.readFileSync(configPath, "utf8").includes(SQLITE_CONFIG_MARKER)) {
		fsImpl.unlinkSync(configPath);
		return true;
	}
	return false;
}

function prepareSqliteCompatibility(options = {}) {
	const fsImpl = options.fs || fs;
	const env = options.env || process.env;
	const write = options.write || (() => {});
	const root = options.root || "/home/container";
	const childEnv = { ...env };
	const framework = String(env.FRAMEWORK || "").trim().toLowerCase();

	if (framework !== "oxide" && framework !== "oxide-staging") return childEnv;

	const managedDir = `${root}/RustDedicated_Data/Managed`;
	const configPath = `${managedDir}/System.Data.SQLite.dll.config`;
	const backupPath = `${configPath}.aioegg-backup`;
	const targetPath = `${root}/RustDedicated_Data/Plugins/x86_64/libsqlite3.so.0`;
	const enabled = String(env.AIO_SQLITE_COMPAT === undefined ? "1" : env.AIO_SQLITE_COMPAT).trim() !== "0";

	if (!enabled) {
		if (restoreSqliteConfig(fsImpl, configPath, backupPath)) {
			write("AIO SQLite compatibility disabled; restored the official config.");
		}
		return childEnv;
	}

	if (!fsImpl.existsSync(targetPath)) {
		restoreSqliteConfig(fsImpl, configPath, backupPath);
		write(`Warning: AIO SQLite compatibility skipped; target is missing: ${targetPath}`);
		return childEnv;
	}

	let mode = 0o644;
	if (fsImpl.existsSync(configPath)) {
		mode = fsImpl.statSync(configPath).mode & 0o777;
		if (!fsImpl.existsSync(backupPath)) {
			fsImpl.copyFileSync(configPath, backupPath);
			fsImpl.chmodSync(backupPath, mode);
		}
	}

	const xml = [
		"<?xml version=\"1.0\" encoding=\"utf-8\"?>",
		"<configuration>",
		`<!-- ${SQLITE_CONFIG_MARKER} -->`,
		`<dllmap dll="sqlite3" target="${targetPath}" os="!windows,osx" cpu="x86-64" />`,
		"</configuration>",
		""
	].join("\n");
	atomicWrite(fsImpl, configPath, xml, mode);
	childEnv.No_PreLoadSQLite = "1";
	write("AIO SQLite compatibility enabled; using Rust's x86_64 SQLite library.");
	return childEnv;
}

module.exports = {
	createGameOutputHandler,
	createRconMessageHandler,
	prepareSqliteCompatibility
};
