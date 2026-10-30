// Checks the site's data: levels are complete and point at files that exist,
// every quiz question is well formed, and the references hang together.
// Run with: node tests/check_site_data.js
"use strict";
const fs = require("fs");
const path = require("path");
const assert = require("assert");

const root = path.resolve(__dirname, "..");
global.window = {};
require(path.join(root, "site/data.js"));
require(path.join(root, "site/quiz-bank.js"));
const Q = window.QUEST;
const quiz = window.QUEST_QUIZ;
const ticks = (text, where) => assert.strictEqual((text.match(/`/g) || []).length % 2, 0, `${where}: unbalanced backticks in "${text}"`);

Q.levels.forEach((lv, i) => {
  assert.strictEqual(lv.id, String(i).padStart(2, "0"), `level ids run in order: ${lv.id}`);
  assert.ok(lv.title && lv.topic && lv.stage, `level ${lv.id}: title, topic, stage`);
  assert.ok(lv.learn.length >= 2 && lv.lab.length >= 2, `level ${lv.id}: what you learn and a lab`);
  assert.ok(fs.existsSync(path.join(root, lv.docs)), `level ${lv.id}: ${lv.docs} exists in the repository`);
});
const stages = [...new Set(Q.levels.map((l) => l.stage))];
for (const s of stages) {
  const ids = Q.levels.map((l, i) => (l.stage === s ? i : -1)).filter((i) => i >= 0);
  assert.strictEqual(ids[ids.length - 1] - ids[0] + 1, ids.length, `stage "${s}" levels are contiguous`);
}

let total = 0;
assert.deepStrictEqual(Object.keys(quiz).sort(), Q.levels.map((l) => l.id), "a quiz for every level and no other");
for (const lv of Q.levels) {
  const items = quiz[lv.id];
  assert.ok(items.length >= 3, `level ${lv.id} needs at least 3 quiz questions, has ${items.length}`);
  const seen = new Set();
  for (const item of items) {
    total++;
    const where = `level ${lv.id}: "${item.q}"`;
    assert.ok(typeof item.q === "string" && item.q.length > 10, `${where}: question text`);
    assert.ok(!seen.has(item.q), `${where}: duplicate question`);
    seen.add(item.q);
    assert.strictEqual(item.options.length, 4, `${where}: needs 4 options`);
    assert.strictEqual(new Set(item.options).size, 4, `${where}: options must differ`);
    assert.ok(Number.isInteger(item.answer) && item.answer >= 0 && item.answer < 4, `${where}: answer index`);
    assert.ok(typeof item.why === "string" && item.why.length > 40, `${where}: explanation`);
    for (const text of [item.q, item.why, ...item.options]) ticks(text, where);
  }
}

const slug = (t) => t.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
assert.ok(Q.doctor.length >= 10, "at least 10 troubleshooting entries");
for (const d of Q.doctor) {
  assert.ok(d.meaning && d.causes.length && d.commands.length, `doctor "${d.status}": meaning, causes, commands`);
  assert.ok(Q.levels.some((l) => l.id === d.level), `doctor "${d.status}" links to a missing level`);
}
assert.strictEqual(new Set(Q.doctor.map((d) => slug(d.status))).size, Q.doctor.length, "doctor links must be unique");
assert.deepStrictEqual(Q.doctorGroups.flatMap(([, s]) => s).sort(), Q.doctor.map((d) => d.status).sort(), "every troubleshooting entry belongs to exactly one group");

for (const c of Q.architecture.components) {
  assert.ok(c.id && c.name && c.short && c.where && c.role && c.does.length && c.breaks && c.look.length, `architecture ${c.id}: complete`);
  ticks(c.breaks, `architecture ${c.id}`);
}
for (const [key, g] of Object.entries(Q.guides)) assert.ok(g.what && g.steps.length && g.uses.length && g.tips.length, `guide ${key}: complete`);
for (const row of Q.cheats) {
  assert.ok(row.length === 3 || row.length === 4, `cheat "${row[0]}": [command, what, group, where?]`);
  assert.ok(row[0].length && row[1].length && row[2].length, `cheat "${row[0]}": filled in`);
}
assert.strictEqual(new Set(Q.cheats.map((r) => r[0])).size, Q.cheats.length, "cheat sheet commands are unique");

// The page: one script per file, the CSP, and no inline styles or handlers.
const html = fs.readFileSync(path.join(root, "site/index.html"), "utf8");
assert.match(html, /<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'none'; base-uri 'none'; form-action 'none'">/);
assert.doesNotMatch(html, /\sstyle=|\son[a-z]+=|<script>(?!<\/script>)|https?:\/\/(?!github\.com|codespaces)/i, "no inline styles, handlers, scripts or third-party loads");
for (const src of html.match(/src="[^"]+"/g)) assert.ok(fs.existsSync(path.join(root, "site", src.slice(5, -1))), `${src} exists`);
assert.match(html, /© 2024–2026 Sandeep Komal Pothu and contributors\./);
assert.match(html, /Docker® is a registered trademark of Docker, Inc\. This project is independent and not affiliated with Docker, Inc\./);
for (const f of fs.readdirSync(path.join(root, "site")).filter((x) => x.endsWith(".js"))) {
  const src = fs.readFileSync(path.join(root, "site", f), "utf8");
  assert.doesNotMatch(src, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|fetch\(|XMLHttpRequest/, `${f}: no HTML injection or network calls`);
}

console.log(`site data ok: ${Q.levels.length} levels, ${total} quiz questions, ${Q.doctor.length} troubleshooting entries, ${Q.architecture.components.length} components`);
