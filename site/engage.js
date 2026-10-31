// Learning loop: continue where you left off, an on-call shift against the clock,
// a score, a skill radar and a learning-uptime status page, and a "put the lab in order" check in every level.
// Everything stays in this browser under the site's own storage prefix.
"use strict";
(function () {
  const Q = window.TRACK;
  const { h } = window.DQUI;
  const PREFIX = "dq-docker:";
  const get = (k, d) => { try { return JSON.parse(localStorage.getItem(PREFIX + k)) ?? d; } catch { return d; } };
  const set = (k, v) => { try { localStorage.setItem(PREFIX + k, JSON.stringify(v)); } catch { /* private mode */ } };
  const day = (d) => d.toLocaleDateString("en-CA"); // YYYY-MM-DD in local time
  const today = () => day(new Date());
  const clock = (ms) => { const s = Math.round(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };

  // Learning actions per local day, {date: count}: the streak and the activity graph read it.
  function active() {
    const log = get("log", {});
    log[today()] = (log[today()] || 0) + 1;
    const cut = new Date();
    cut.setDate(cut.getDate() - 371);
    for (const k of Object.keys(log)) if (k < day(cut)) delete log[k];
    set("log", log);
    render();
  }
  function streaks() {
    const log = get("log", {});
    const d = new Date();
    if (!log[today()]) d.setDate(d.getDate() - 1);
    let now = 0;
    while (log[day(d)]) { now++; d.setDate(d.getDate() - 1); }
    let best = 0, run = 0, prev;
    for (const k of Object.keys(log).sort()) {
      const t = new Date(k + "T12:00");
      run = prev && (t - prev) / 864e5 < 1.5 ? run + 1 : 1;
      best = Math.max(best, run);
      prev = t;
    }
    return { now, best };
  }

  // Points come from what is already saved, so they never drift from real progress.
  const RANKS = [[0, "Getting started"], [50, "Apprentice"], [200, "Practitioner"], [500, "Responder"], [900, "On-call ready"]];
  function score() {
    const quiz = Object.values(get("quiz", {}));
    const s = {
      solved: get("pg-solved", []).length, levels: get("done", []).length, passed: quiz.filter((p) => p >= 80).length,
      shifts: get("shifts", { count: 0 }).count, orders: get("orders", []).length
    };
    s.total = s.solved * 10 + s.levels * 20 + quiz.reduce((a, p) => a + Math.round(p / 10), 0) + s.shifts * 5 + s.orders * 5;
    return s;
  }
  // The session starts with the first page view in this tab.
  const session = (() => {
    try {
      const k = PREFIX + "session";
      const was = JSON.parse(sessionStorage.getItem(k));
      if (was) return was;
      const now = { at: Date.now(), from: score().total };
      sessionStorage.setItem(k, JSON.stringify(now));
      return now;
    } catch { return { at: Date.now(), from: score().total }; }
  })();

  // --- on-call shift: a random unsolved incident, a pager and a timer ---------
  let shift = get("shift", null);
  let tick;
  function startShift() {
    const all = window.DQPlayground.scenarios;
    const solved = new Set(get("pg-solved", []));
    const pool = all.filter((s) => !solved.has(s.id));
    const pick = (pool.length ? pool : all)[Math.floor(Math.random() * (pool.length || all.length))];
    shift = { id: pick.id, at: Date.now() };
    set("shift", shift);
    render();
  }
  function endShift(id) {
    if (!shift || shift.id !== id) return active();
    const took = Date.now() - shift.at;
    const log = get("shifts", { count: 0, best: null });
    set("shifts", { count: log.count + 1, best: log.best == null ? took : Math.min(log.best, took), last: took });
    shift = null;
    set("shift", null);
    active();
  }
  document.addEventListener("dq:solved", (e) => endShift(e.detail));

  function shiftCard() {
    clearInterval(tick);
    const log = get("shifts", { count: 0, best: null });
    if (!shift) {
      return h("div.eng-card.eng-shift", null,
        h("p.eng-k", null, "On-call shift"),
        h("h3", null, log.last ? `Resolved in ${clock(log.last)}.` : "Can you fix it before the pager goes again?"),
        h("p", null, log.count ? `${log.count} shift${log.count > 1 ? "s" : ""} done · best ${clock(log.best)}` : "A random incident you have not solved yet, against the clock."),
        h("button.pill.primary", { type: "button", onclick: startShift }, log.count ? "Take another shift" : "Start a shift"));
    }
    const s = window.DQPlayground.scenarios.find((x) => x.id === shift.id);
    if (!s) { shift = null; return shiftCard(); }
    const time = h("span.eng-time", { "aria-live": "off" }, clock(Date.now() - shift.at));
    tick = setInterval(() => { time.textContent = clock(Date.now() - shift.at); }, 1000);
    return h("div.eng-card.eng-shift.paging", { role: "status" },
      h("p.eng-k", null, h("span.eng-dot", { "aria-hidden": "true" }), "Paged · ", time),
      h("h3", null, s.title),
      h("p", null, s.story),
      h("div.eng-row", null,
        h("a.pill.primary", { href: "#play/" + s.id }, "Acknowledge"),
        h("button.more", { type: "button", onclick: () => { shift = null; set("shift", null); render(); } }, "Hand it back")));
  }

  // --- continue where you left off, and progress at a glance -----------------
  function continueCard() {
    const done = new Set(get("done", []));
    const next = Q.levels.find((l) => !done.has(l.id));
    if (!next) return h("div.eng-card", null, h("p.eng-k", null, "Your path"), h("h3", null, "Every level done."), h("p", null, "Keep your skills sharp with on-call shifts."));
    return h("div.eng-card", null,
      h("p.eng-k", null, done.size ? "Continue" : "Start here"),
      h("h3", null, `Level ${next.id} · ${next.title}`),
      h("p", null, next.topic),
      h("a.pill", { href: "#lv-" + next.id, onclick: (e) => { e.preventDefault(); openLevel(next.id); } }, done.size ? "Continue" : "Start level " + next.id));
  }
  function scoreCard() {
    const sc = score();
    const i = RANKS.findLastIndex(([min]) => sc.total >= min);
    const next = RANKS[i + 1];
    const bar = h("span.eng-bar-fill");
    bar.style.width = next ? ((sc.total - RANKS[i][0]) / (next[0] - RANKS[i][0]) * 100) + "%" : "100%";
    const gained = sc.total - session.from;
    return h("div.eng-card", null,
      h("p.eng-k", null, "Your score"),
      h("p.eng-score", null, String(sc.total), h("span", null, RANKS[i][1])),
      h("span.eng-bar", { role: "progressbar", "aria-label": next ? `Progress to ${next[1]}` : "Top rank", "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": String(Math.round(parseFloat(bar.style.width))) }, bar),
      h("p", null, next ? `${next[0] - sc.total} points to ${next[1]}` : "Top rank. Keep the streak going."),
      h("p.eng-session", null, `This session: ${gained > 0 ? "+" + gained : "0"} points · ${Math.max(1, Math.round((Date.now() - session.at) / 60000))} min`));
  }

  // --- scoreboard: a skill radar and a status page for your own learning ----
  const svg = (tag, attrs, ...kids) => {
    const el = document.createElementNS("http://www.w3.org/2000/svg", tag);
    for (const [k, v] of Object.entries(attrs || {})) el.setAttribute(k, v);
    el.append(...kids);
    return el;
  };
  // One axis per stage: half for levels done, half for its incidents fixed.
  function radar() {
    const done = new Set(get("done", []));
    const solved = new Set(get("pg-solved", []));
    const stages = [...new Set(Q.levels.map((l) => l.stage))].map((name) => {
      const ids = Q.levels.filter((l) => l.stage === name).map((l) => l.id);
      const scn = window.DQPlayground.scenarios.filter((s) => ids.includes(s.level));
      const lv = ids.filter((id) => done.has(id)).length / ids.length;
      return { name, v: scn.length ? (lv + scn.filter((s) => solved.has(s.id)).length / scn.length) / 2 : lv };
    });
    const R = 92;
    const at = (i, r) => { const a = (i / stages.length) * 2 * Math.PI - Math.PI / 2; return [r * Math.cos(a), r * Math.sin(a)]; };
    const ring = (f) => stages.map((_, i) => at(i, R * f).map((n) => n.toFixed(1)).join(",")).join(" ");
    const shape = stages.map((st, i) => at(i, R * Math.max(st.v, .04)).map((n) => n.toFixed(1)).join(",")).join(" ");
    const pic = svg("svg", { viewBox: "-150 -122 300 244", class: "eng-radar", role: "img",
      "aria-label": "Skill radar: " + stages.map((st) => `${st.name} ${Math.round(st.v * 100)}%`).join(", ") },
      ...[.25, .5, .75, 1].map((f) => svg("polygon", { points: ring(f), class: "eng-r-grid" })),
      ...stages.map((_, i) => { const [x, y] = at(i, R); return svg("line", { x1: 0, y1: 0, x2: x, y2: y, class: "eng-r-grid" }); }),
      svg("polygon", { points: shape, class: "eng-r-shape" }),
      ...stages.map((st, i) => { const [x, y] = at(i, R * Math.max(st.v, .04)); return svg("circle", { cx: x, cy: y, r: 3.5, class: "eng-r-dot" }); }),
      ...stages.map((st, i) => {
        const [x, y] = at(i, R + 12);
        return svg("text", { x, y: y + 4, "text-anchor": Math.abs(x) < 8 ? "middle" : x > 0 ? "start" : "end", class: "eng-r-label" }, st.name);
      }));
    const top = stages.reduce((a, b) => (b.v > a.v ? b : a));
    return h("div.eng-panel", null, h("p.eng-k", null, "Your skill shape"), pic,
      h("p", null, top.v ? `Strongest: ${top.name}. Grow the other corners to round it out.` : "Fix incidents and finish levels to grow your shape."));
  }
  // Your learning, read like a service: uptime over 30 days, an SLO of 4 days a week,
  // and an error budget of 3 rest days each week.
  function uptime() {
    const log = get("log", {});
    const bars = [];
    const d = new Date();
    d.setDate(d.getDate() - 89);
    let up30 = 0;
    for (let i = 0; i < 90; i++, d.setDate(d.getDate() + 1)) {
      const on = Boolean(log[day(d)]);
      if (on && i >= 60) up30++;
      bars.push(h("span.eng-up" + (on ? ".on" : ""), { title: `${d.toLocaleDateString(undefined, { day: "numeric", month: "short" })}: ${on ? "practised" : "rest day"}` }));
    }
    const pct = up30 / 30 * 100;
    const ok = pct >= 4 / 7 * 100;
    const w = new Date();
    let rest = 0;
    for (w.setDate(w.getDate() - ((w.getDay() + 6) % 7)); day(w) < today(); w.setDate(w.getDate() + 1)) if (!log[day(w)]) rest++;
    const left = Math.max(0, 3 - rest);
    return h("div.eng-panel", null,
      h("p.eng-k", null, "Learning uptime"),
      h("p.eng-score", null, pct.toFixed(1) + "%", h("span.eng-slo" + (ok ? ".ok" : ".low"), null, ok ? "Meeting SLO" : "Below SLO")),
      h("p", null, "Last 30 days · SLO: practise 4 days a week"),
      h("div.eng-uptime", { role: "img", "aria-label": `Practised on ${bars.filter((b) => b.classList.contains("on")).length} of the last 90 days` }, bars),
      h("div.eng-up-axis", { "aria-hidden": "true" }, h("span", null, h("span.eng-90", null, "90"), h("span.eng-30", null, "30"), " days ago"), h("span", null, "Today")),
      h("div.eng-budget", null,
        h("span.eng-pips", { "aria-hidden": "true" }, [0, 1, 2].map((i) => h("span" + (i < left ? ".on" : "")))),
        h("span", null, left ? `Error budget: ${left} rest day${left > 1 ? "s" : ""} left this week` : "Error budget spent this week. Practise today to stay on SLO.")));
  }
  function board() {
    const sc = score();
    const st = streaks();
    const shifts = get("shifts", { count: 0, best: null });
    const stat = (v, label) => h("div", null, h("b", null, v), h("span", null, label));
    return h("div.eng-board", null,
      h("div.eng-panels", null, radar(), uptime()),
      h("div.eng-stats", null,
        stat(`${sc.solved}/${window.DQPlayground.scenarios.length}`, "incidents fixed"),
        stat(`${sc.levels}/${Q.levels.length}`, "levels done"),
        stat(`${sc.passed}/${Q.levels.length}`, "quizzes passed"),
        stat(String(shifts.count), shifts.best ? `shifts · best ${clock(shifts.best)}` : "on-call shifts"),
        stat(`${st.now}d`, `streak · best ${st.best}d`)),
      carry());
  }

  // --- carry progress to another device as a file the learner keeps ---------
  function download() {
    const data = {};
    for (const k of Object.keys(localStorage)) if (k.startsWith(PREFIX)) data[k] = localStorage.getItem(k);
    const url = URL.createObjectURL(new Blob([JSON.stringify({ site: PREFIX, saved: today(), data })], { type: "application/json" }));
    h("a", { href: url, download: `devops-nimbus-${PREFIX.slice(3, -1)}-progress.json` }).click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  // Only this track's keys with valid JSON values are accepted; anything else changes nothing.
  function load(file, msg) {
    if (!file) return;
    if (file.size > 256e3) { msg.textContent = "That file is too big to be a progress file. Nothing was changed."; return; }
    file.text().then((text) => {
      const f = JSON.parse(text);
      const entries = Object.entries(f && f.site === PREFIX && typeof f.data === "object" ? f.data : {})
        .filter(([k, v]) => k.startsWith(PREFIX) && typeof v === "string" && JSON.parse(v) !== undefined);
      if (!entries.length) throw new Error("not a progress file");
      if (!confirm("Replace the progress in this browser with the one in the file?")) return;
      for (const k of Object.keys(localStorage)) if (k.startsWith(PREFIX)) localStorage.removeItem(k);
      for (const [k, v] of entries) localStorage.setItem(k, v);
      location.reload();
    }).catch(() => { msg.textContent = "That is not a progress file for this track. Nothing was changed."; });
  }
  function carry() {
    const msg = h("span.eng-msg", { "aria-live": "polite" }, "Progress lives in this browser. Keep a copy to move it to another device.");
    return h("div.eng-carry", null,
      h("button.pill.small-pill", { type: "button", onclick: download }, "Download my progress"),
      h("label.pill.small-pill.eng-file", null, "Load my progress",
        h("input", { type: "file", accept: "application/json,.json", onchange: (e) => { load(e.target.files[0], msg); e.target.value = ""; } })),
      msg);
  }

  function openLevel(id) {
    const li = document.getElementById("lv-" + id);
    if (!li) return;
    location.hash = "#path";
    li.querySelector("details").open = true;
    li.scrollIntoView({ block: "center", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  }

  function render() {
    const box = document.getElementById("engage");
    if (!box || !window.DQPlayground) return;
    box.replaceChildren(continueCard(), shiftCard(), scoreCard(), board());
  }

  // --- put the lab in order before seeing it ---------------------------------
  // Recalling the steps beats rereading them; the lab shows once they are right or asked for.
  function order(lv, lab) {
    const want = lv.lab;
    if (want.length < 3 || new Set(want).size !== want.length) return lab;
    const now = [...want];
    while (now.every((c, i) => c === want[i])) {
      for (let i = now.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [now[i], now[j]] = [now[j], now[i]]; }
    }
    const list = h("ol.eng-order");
    const msg = h("p.eng-msg", { "aria-live": "polite" });
    const draw = (focus) => {
      msg.textContent = "";
      list.replaceChildren(...now.map((cmd, i) => h("li", null,
        h("code", null, cmd),
        h("span.eng-moves", null, [[-1, "up", "↑"], [1, "down", "↓"]].map(([by, word, arrow]) =>
          h("button", { type: "button", "aria-label": `Move ${word}: ${cmd}`, disabled: !now[i + by], onclick: () => {
            [now[i], now[i + by]] = [now[i + by], now[i]];
            draw(i + by);
          } }, arrow))))));
      if (focus != null) [...list.children[focus].querySelectorAll("button")].find((b) => !b.disabled).focus();
    };
    const box = h("div.eng-orderbox");
    const reveal = (text) => { box.replaceChildren(lab, h("p.eng-msg", { "aria-live": "polite" }, text)); };
    const check = () => {
      const right = now.filter((c, i) => c === want[i]).length;
      [...list.children].forEach((li, i) => { li.className = now[i] === want[i] ? "ok" : "off"; });
      if (right === want.length) {
        set("orders", [...new Set([...get("orders", []), lv.id])]);
        reveal("Right order. +5 points. Now run it on your machine.");
        active();
      }
      else msg.textContent = `${right} of ${want.length} in place. What does each step need first?`;
    };
    draw();
    box.append(h("p.eng-msg", null, "Put the steps in order first, then run them."), list,
      h("div.eng-row", null, h("button.pill.small-pill", { type: "button", onclick: check }, "Check my order"),
        h("button.more", { type: "button", onclick: () => reveal("") }, "Show the lab"), msg));
    return box;
  }

  window.DQEngage = { order, active, render };
  window.addEventListener("DOMContentLoaded", render);
})();
