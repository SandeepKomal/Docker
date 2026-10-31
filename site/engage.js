// Learning loop: continue where you left off, an on-call shift against the clock,
// a daily streak, and a "put the lab in order" check in every level.
// Everything stays in this browser under the site's own storage prefix.
"use strict";
(function () {
  const Q = window.QUEST;
  const { h } = window.DQUI;
  const PREFIX = "dq-docker:";
  const get = (k, d) => { try { return JSON.parse(localStorage.getItem(PREFIX + k)) ?? d; } catch { return d; } };
  const set = (k, v) => { try { localStorage.setItem(PREFIX + k, JSON.stringify(v)); } catch { /* private mode */ } };
  const day = (d) => d.toLocaleDateString("en-CA"); // YYYY-MM-DD in local time
  const today = () => day(new Date());
  const clock = (ms) => { const s = Math.round(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };

  // Days with any learning activity, newest last; the streak counts back from today or yesterday.
  function active() {
    const days = get("days", []);
    if (days[days.length - 1] !== today()) set("days", [...days, today()].slice(-60));
    render();
  }
  function streak() {
    const days = new Set(get("days", []));
    const d = new Date();
    if (!days.has(today())) d.setDate(d.getDate() - 1);
    let n = 0;
    while (days.has(day(d))) { n++; d.setDate(d.getDate() - 1); }
    return n;
  }

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
  function streakCard() {
    const n = streak();
    const solved = get("pg-solved", []).length;
    const week = new Set(get("days", []));
    const d = new Date();
    d.setDate(d.getDate() - 6);
    const dots = [];
    for (let i = 0; i < 7; i++, d.setDate(d.getDate() + 1)) {
      const on = week.has(day(d));
      dots.push(h("span.eng-day" + (on ? ".on" : ""), { title: d.toLocaleDateString(undefined, { weekday: "long" }) + (on ? ": practised" : "") }));
    }
    return h("div.eng-card", null,
      h("p.eng-k", null, "Your streak"),
      h("h3", null, n ? `${n} day${n > 1 ? "s" : ""} in a row` : "Start a streak today"),
      h("div.eng-week", { role: "img", "aria-label": `Practised on ${dots.filter((x) => x.classList.contains("on")).length} of the last 7 days` }, dots),
      h("p", null, `${solved} incident${solved === 1 ? "" : "s"} fixed so far`));
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
    if (box && window.DQPlayground) box.replaceChildren(continueCard(), shiftCard(), streakCard());
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
      if (right === want.length) { reveal("Right order. Now run it on your machine."); active(); }
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
