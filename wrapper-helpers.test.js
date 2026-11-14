"use strict";

const assert = require("assert");
const { createPanelWriter, normalizePanelLine } = require("./wrapper-helpers");

let active = false;
let timestamp = 0;
const output = [];
const writePanel = createPanelWriter(
	(text) => output.push(text),
	() => active,
	1000,
	() => timestamp
);

writePanel("Waiting for RCON");
writePanel("Waiting for RCON");
assert.deepStrictEqual(output, ["Waiting for RCON", "Waiting for RCON"]);

active = true;
writePanel("Spawning World");
timestamp = 999;
writePanel("\u001b[32mSpawning World\u001b[0m");
assert.deepStrictEqual(output.slice(2), ["Spawning World"]);

timestamp = 1000;
writePanel("Spawning World");
assert.deepStrictEqual(output.slice(2), ["Spawning World", "Spawning World"]);

timestamp = 1100;
writePanel("Terrain Mesh\nTerrain Mesh\nRail Meshes");
assert.strictEqual(output.at(-1), "Terrain Mesh\nRail Meshes");
assert.strictEqual(normalizePanelLine("\u001b[31m  Finalizing World\r\u001b[0m"), "Finalizing World");

console.log("wrapper helper tests passed");
