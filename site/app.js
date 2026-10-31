// Docker Quest site. No dependencies, no network requests.
"use strict";

(function () {
  const Q = window.TRACK;
  const $ = (sel) => document.querySelector(sel);
  const still = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
  const scrollToEl = (el) => el.scrollIntoView({ block: "start", behavior: still() ? "auto" : "smooth" });

  // h("tag.class", {attr: value}, ...children): build DOM from elements and text nodes only.
  function h(spec, attrs, ...kids) {
    const [tag, ...classes] = spec.split(".");
    const el = document.createElement(tag);
    if (classes.length) el.className = classes.join(" ");
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
      else if (v === true) el.setAttribute(k, "");
      else if (v !== false && v != null) el.setAttribute(k, v);
    }
    for (const kid of kids.flat()) {
      if (kid == null || kid === false) continue;
      el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
    }
    return el;
  }

  // Text with `code` spans.
  const rich = (text) => text.split(/(`[^`]+`)/).map((part) => (part.startsWith("`") ? h("code", null, part.slice(1, -1)) : part));

  const store = {
    get(key, fallback) {
      try { return JSON.parse(localStorage.getItem("dq-docker:" + key)) ?? fallback; } catch { return fallback; }
    },
    set(key, value) {
      try { localStorage.setItem("dq-docker:" + key, JSON.stringify(value)); } catch { /* private mode */ }
    }
  };

  // Everything the site keeps lives under "dq-docker:" in this browser; one click removes it.
  function forgetEverything() {
    if (!confirm("Clear your progress, quiz scores and saved names from this browser?")) return;
    try { for (const k of Object.keys(localStorage)) if (k.startsWith("dq-docker:")) localStorage.removeItem(k); } catch { /* storage blocked */ }
    location.reload();
  }

  const scenarioTitles = () => Object.fromEntries((window.DQPlayground ? window.DQPlayground.scenarios : []).map((x) => [x.id, x.title]));
  // Open a scenario in the playground, from anywhere on the site.
  function practise(id) { location.hash = "play/" + id; }
  // Copy a link to something on this page, for sharing or bookmarking.
  function copyLink(hash, label) {
    return h("button.copy", {
      type: "button", title: "Copy a link to this " + label,
      onclick: async (e) => {
        const b = e.currentTarget;
        const url = location.href.replace(/#.*$/, "") + "#" + hash;
        try { await navigator.clipboard.writeText(url); b.textContent = "Link copied"; } catch { b.textContent = url; }
        setTimeout(() => { b.textContent = "Copy link"; }, 1600);
      }
    }, "Copy link");
  }
  const practiseRow = (ids, label) => {
    const titles = scenarioTitles();
    const known = (ids || []).filter((id) => titles[id]);
    return known.length ? h("div.doctor-practise", null, h("span.muted.small", null, label),
      known.map((id) => h("button.chip", { type: "button", onclick: () => practise(id) }, titles[id]))) : null;
  };

  const repoUrl = (p) => `${Q.repo}/${/\.[a-z]+$|^Docker Networks$/.test(p) ? "blob" : "tree"}/main/${p.split("/").map(encodeURIComponent).join("/")}`;
  document.querySelectorAll("[data-repo]").forEach((a) => { a.href = Q.repo + a.dataset.repo; });

  // --- tabs ----------------------------------------------------------------

  // Deep links: #fix/<id> opens a troubleshooting entry, #play/<id> a scenario.
  const tabs = ["path", "quiz", "xray", "doctor", "cheats", "arch"];
  const ALIAS = { fix: "doctor", play: "path" };
  let current = null;
  function show() {
    const [want, sub] = location.hash.slice(1).split("/");
    const tab = tabs.includes(want) ? want : ALIAS[want] || "path";
    if (want === "fix" && sub) {
      const i = Q.doctor.findIndex((d) => d.id === sub);
      if (i >= 0) renderDoctor(i, true);
    }
    if (tab !== current) {
      const page = $("#tab-" + tab);
      page.classList.remove("tab-in");
      void page.offsetWidth; // restart the fade
      page.classList.add("tab-in");
    }
    current = tab;
    for (const t of tabs) $("#tab-" + t).hidden = t !== tab;
    document.querySelectorAll("nav a").forEach((a) => {
      if (a.dataset.tab === tab) a.setAttribute("aria-current", "page");
      else a.removeAttribute("aria-current");
    });
  }
  window.addEventListener("hashchange", () => {
    const before = current;
    show();
    if (current !== before) window.scrollTo(0, 0);
  });

  // --- hero: the image-layers signature and the counts ----------------------

  // Each bar is a layer, as wide as what it adds; the toggle applies the fix.
  function renderStage() {
    const list = h("div.layers");
    const total = h("b");
    const mb = (n) => (n < 1 ? "<1 MB" : n >= 1000 ? `${(n / 1000).toFixed(2)} GB` : `${Math.round(n)} MB`);
    const draw = (rows) => {
      const max = Q.signature.before[0][1];
      list.replaceChildren(...rows.map(([by, size]) => {
        const bar = h("i.bar");
        bar.style.width = "0%";
        requestAnimationFrame(() => { bar.style.width = `${Math.max(0.4, size / max * 100)}%`; });
        return h("div.layer" + (size > 250 ? ".heavy" : ""), { title: `${by}: ${mb(size)}` }, h("span.layer-by", null, by), h("div", null, bar), h("span.size", null, mb(size)));
      }));
      const sum = rows.reduce((n, r) => n + r[1], 0);
      total.textContent = mb(sum);
      total.className = sum > 1000 ? "bad" : "good";
    };
    const toggle = h("button.toggle", { type: "button", "aria-pressed": "false" }, "Apply .dockerignore and a multi-stage build");
    toggle.addEventListener("click", () => {
      const on = toggle.getAttribute("aria-pressed") !== "true";
      toggle.setAttribute("aria-pressed", String(on));
      draw(on ? Q.signature.after : Q.signature.before);
    });
    $("#stage").replaceChildren(
      h("div.stage-bar", null, h("div", null, h("strong", { id: "stage-title" }, "nimbus/shop"), h("div", null, "Each bar is a layer, as wide as what it adds.")), toggle),
      list, h("div.total", null, h("span", null, "Image size"), total),
      h("a.stage-try", { href: "#play/bigimage" }, "Shrink it yourself in the playground"));
    draw(Q.signature.before);
  }
  function renderStats() {
    const n = window.DQPlayground ? window.DQPlayground.scenarios.length : 0;
    $("#stats").replaceChildren(...[[n, "incidents to fix"], [Q.levels.length, "levels, basics to production"], [Q.doctor.length, "errors explained"]]
      .map(([v, label]) => h("div", null, h("b", null, String(v)), h("span", null, label))));
  }

  // --- path ----------------------------------------------------------------

  const stageId = (name) => "stage-" + name.toLowerCase().replace(/\s+/g, "-");
  function renderPath() {
    const done = new Set(store.get("done", []));
    const scores = store.get("quiz", {});
    const box = $("#levels");
    box.replaceChildren();
    let stage = "";
    let list;
    for (const lv of Q.levels) {
      if (lv.stage !== stage) {
        stage = lv.stage;
        list = h("ol.levels");
        box.append(h("h3.stage", { id: stageId(stage) }, stage), list);
      }
      const isDone = done.has(lv.id);
      list.append(h("li.level" + (isDone ? ".done" : ""), { id: "lv-" + lv.id },
        h("input", {
          type: "checkbox", checked: isDone, "aria-label": `Mark level ${lv.id} complete`,
          onchange: (e) => {
            if (e.target.checked) done.add(lv.id); else done.delete(lv.id);
            store.set("done", [...done]);
            if (e.target.checked) window.DQEngage.active();
            renderPath();
          }
        }),
        h("span.num", null, lv.id),
        h("details.what", null,
          h("summary", null, h("span.title", null, lv.title), h("span.topic", null, lv.topic)),
          h("div.level-body", null,
            h("div", null, h("h4", null, "What you learn"), h("ul", null, lv.learn.map((t) => h("li", null, ...rich(t))))),
            h("div", null, h("h4", null, "Lab on your machine"), window.DQEngage.order(lv, h("pre", null, h("code", null, lv.lab.join("\n"))))),
            h("p.level-links", null, h("a", { href: repoUrl(lv.docs) }, `Guide: ${lv.docs}`)),
            practiseRow(lv.practise, "Practise in the playground:"))),
        h("span.actions", null,
          h("a.small", { href: "#quiz", onclick: () => { $("#quiz-level").value = lv.id; renderQuiz(); } }, lv.id in scores ? `Quiz ${scores[lv.id]}%` : "Quiz"))
      ));
    }
    renderStages(done);
    $("#bar-fill").style.width = (done.size / Q.levels.length * 100) + "%";
    $("#bar").setAttribute("aria-valuenow", String(done.size));
    $("#bar-text").textContent = `${done.size} of ${Q.levels.length} levels complete`;
  }

  function renderStages(done) {
    const stages = [];
    for (const lv of Q.levels) {
      let st = stages.find((x) => x.name === lv.stage);
      if (!st) stages.push(st = { name: lv.stage, levels: [] });
      st.levels.push(lv);
    }
    $("#stages").replaceChildren(...stages.map((st, i) => {
      const n = st.levels.filter((l) => done.has(l.id)).length;
      const ring = h("span.ring", { "aria-hidden": "true" });
      ring.style.setProperty("--p", Math.round(n / st.levels.length * 100));
      return h("a.stage-card" + (n === st.levels.length ? ".complete" : ""), {
        role: "listitem", href: "#" + stageId(st.name),
        onclick: (e) => { e.preventDefault(); scrollToEl(document.getElementById(stageId(st.name))); }
      }, ring, h("span.stage-num", null, `Stage ${i + 1}`), h("strong", null, st.name), h("span.muted", null, `${n} of ${st.levels.length} levels`));
    }));
  }

  // --- quiz ----------------------------------------------------------------

  const EXAM_SIZE = 20;
  const questionsFor = (id) => (window.TRACK_QUIZ[id] || []).map((item) => ({ ...item, level: id }));
  function shuffle(list) {
    const a = [...list];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  function renderQuiz() {
    const mode = $("#quiz-level").value;
    const exam = mode === "exam";
    const items = exam ? shuffle(Q.levels.flatMap((l) => questionsFor(l.id))).slice(0, EXAM_SIZE) : questionsFor(mode);
    const out = $("#quiz-list");
    out.replaceChildren();
    let answered = 0;
    let correct = 0;
    const score = h("div.score", { "aria-live": "polite" });
    const bar = h("span.fill");
    const updateScore = () => {
      score.replaceChildren(
        h("span", null, h("strong", null, `${correct}`), ` correct of ${answered} answered · ${items.length} questions`),
        h("span.meter", { role: "progressbar", "aria-label": "Answered", "aria-valuemin": "0", "aria-valuemax": String(items.length), "aria-valuenow": String(answered) }, bar));
      bar.style.width = (answered / items.length * 100) + "%";
      if (answered !== items.length) return;
      const pct = Math.round(correct / items.length * 100);
      if (!exam) {
        const all = store.get("quiz", {});
        all[mode] = Math.max(all[mode] || 0, pct);
        store.set("quiz", all);
        window.DQEngage.active();
        renderPath();
      }
      score.append(h("p.result", null, h("strong", null, `${pct}%. `),
        pct === 100 ? "Perfect score." : pct >= 75 ? "Strong. Review the explanations you missed." : "Read the explanations, then practise the level and try again.",
        " ", h("button.linkish", { type: "button", onclick: renderQuiz }, exam ? "New exam" : "Try again")));
    };
    items.forEach((item, qi) => {
      const fb = h("p.feedback", { "aria-live": "polite" });
      const opts = h("div.options", { role: "group", "aria-label": `Question ${qi + 1}` });
      // A new order each time, so position gives nothing away.
      shuffle(item.options.map((text, index) => ({ text, index }))).forEach((opt) => {
        opts.append(h("button.opt", {
          type: "button", "data-right": opt.index === item.answer ? "1" : null,
          onclick: (e) => {
            const right = opt.index === item.answer;
            opts.querySelectorAll("button").forEach((b) => { b.disabled = true; if (b.dataset.right) b.classList.add("right"); });
            if (!right) e.currentTarget.classList.add("wrong");
            fb.replaceChildren(h("strong", null, right ? "Correct. " : "Not quite. "), ...rich(item.why));
            fb.className = "feedback " + (right ? "ok" : "bad");
            answered++;
            if (right) correct++;
            updateScore();
          }
        }, ...rich(opt.text)));
      });
      const from = exam ? Q.levels.find((l) => l.id === item.level) : null;
      out.append(h("div.card.question", null, from ? h("p.tag", null, `Level ${from.id} · ${from.topic}`) : null,
        h("h3", null, `${qi + 1}. `, ...rich(item.q)), opts, fb));
    });
    out.prepend(score);
    updateScore();
  }

  // --- Dockerfile X-ray ----------------------------------------------------

  // On narrow screens the note sits under the picked line; elsewhere beside the code.
  const narrow = () => matchMedia("(max-width: 860px)").matches;
  function placeNote(li) {
    const note = $("#xray-note");
    if (li && narrow()) {
      const slot = $("#xray-lines .note-slot") || h("li.note-slot");
      li.after(slot);
      slot.append(note);
    } else if (note.parentElement !== $("#xray-view")) {
      $("#xray-view").append(note);
      const slot = $("#xray-lines .note-slot");
      if (slot) slot.remove();
    }
  }

  // The X-ray shows either the paste box or an explained Dockerfile.
  let xrayPick = -1;
  let pasted = null;
  function renderXray(index) {
    xrayPick = index;
    document.querySelectorAll("#xray-pick button").forEach((b) => b.setAttribute("aria-selected", String(Number(b.dataset.index) === index)));
    const paste = index < 0;
    const res = paste ? pasted : window.DQExplain.explain(Q.xray[index].lines.join("\n"));
    $("#xray-edit").hidden = !paste || Boolean(pasted);
    $("#xray-result").hidden = !res;
    $("#xray-view").hidden = !res;
    $("#xray-actions").hidden = !paste;
    if (!res) return;
    const rows = res.lines;
    const lines = $("#xray-lines");
    placeNote(null);
    lines.replaceChildren(...rows.map(({ line, note, level, warns }, i) => {
      if (!note) return h("li", null, h("span.line.blank", null, line || " "));
      const flag = warns.length ? ".warn" : level === "unknown" ? ".unknown" : "";
      return h("li", null, h("button.line" + flag, {
        type: "button",
        onclick: (e) => {
          lines.querySelectorAll(".line").forEach((b) => b.classList.remove("on"));
          e.currentTarget.classList.add("on");
          placeNote(e.currentTarget.parentElement);
          $("#xray-note").replaceChildren(h("pre", null, h("code", null, line.trim())), h("p", null, ...rich(note)),
            ...warns.map((w) => h("p.xray-warn", null, ...rich(w))), h("p.muted", null, `Line ${i + 1} of ${rows.length}`));
        }
      }, line));
    }));
    $("#xray-note").replaceChildren(h("p.muted", null, "Select any line to see what it does."));
    const warned = rows.filter((r) => r.warns.length).length;
    $("#xray-summary").textContent = [paste ? null : Q.xray[index].path, `${rows.filter((r) => r.note).length} lines explained`, warned ? `${warned} worth a second look` : null].filter(Boolean).join(" · ");
    $("#xray-review").replaceChildren(...(res.review.length ? [h("details.xray-missing", { open: !narrow() },
      h("summary", null, `${res.review.length} thing${res.review.length === 1 ? "" : "s"} missing or worth a look`),
      h("ul.xray-review", null, res.review.map((n) => h("li", null, ...rich(n)))))] : []));
    const first = $("#xray-lines .line.warn") || $("#xray-lines button.line");
    if (first && !narrow()) first.click();
  }
  function explainPasted() {
    const text = $("#xray-input").value;
    const error = $("#xray-error");
    const fail = (msg) => { error.textContent = msg; error.hidden = false; };
    if (!text.trim()) return fail("Paste a Dockerfile first, or choose Load an example.");
    const res = window.DQExplain.explain(text);
    if (res.error) return fail(res.error);
    error.hidden = true;
    pasted = res;
    renderXray(-1);
    scrollToEl($("#xray-result"));
  }

  // --- troubleshooting reference ---------------------------------------------

  function buildDoctorList() {
    const index = new Map(Q.doctor.map((d, i) => [d.id, i]));
    $("#doctor-list").replaceChildren(...Q.doctorGroups.map(([name, ids]) => h("div.doctor-group", null,
      h("div.doctor-group-name", null, name, h("span.doctor-group-count", null, String(ids.length))),
      h("div.doctor-group-items", null, ids.map((id) => h("button.chip", {
        type: "button", "data-index": index.get(id), "aria-pressed": "false", onclick: () => renderDoctor(index.get(id))
      }, Q.doctor[index.get(id)].status))))));
  }
  // Pasted error text is long and full of IDs, paths and numbers: score entries by
  // how many of its meaningful words they contain, instead of asking for all of them.
  const STOP = new Set(["the", "a", "an", "to", "of", "and", "or", "in", "on", "at", "for", "is", "it", "by", "with", "from", "error", "response", "daemon", "docker", "unknown", "see", "help", "run", "more", "information"]);
  const terms = (s) => s.toLowerCase().replace(/\b[0-9a-f]{12,}\b/g, " ").split(/[^a-z0-9_.$-]+/).map((t) => t.replace(/^[.-]+|[.-]+$/g, "")).filter((t) => t.length > 1 && !STOP.has(t));
  const docText = Q.doctor.map((d) => terms([d.id, d.status, d.error, d.meaning, ...d.causes, ...d.commands, ...d.fix].join(" ")));
  function doctorScores(q) {
    const want = [...new Set(terms(q))];
    return docText.map((words) => (want.length ? want.filter((w) => words.some((x) => x === w || (w.length > 3 && x.startsWith(w)))).length / want.length : 1));
  }
  function renderDoctorList() {
    const q = $("#doctor-q").value;
    const scores = doctorScores(q);
    const long = terms(q).length > 2;
    let shown = 0;
    for (const group of document.querySelectorAll(".doctor-group")) {
      let inGroup = 0;
      for (const b of group.querySelectorAll("button")) {
        b.hidden = scores[b.dataset.index] < (long ? 0.5 : 1);
        if (!b.hidden) inGroup++;
      }
      group.hidden = !inGroup;
      group.querySelector(".doctor-group-count").textContent = String(inGroup);
      shown += inGroup;
    }
    // For pasted errors, the closest entries first.
    const best = q.trim() ? scores.map((s, i) => [s, i]).filter(([s]) => s >= 0.5).sort((x, y) => y[0] - x[0]).slice(0, 3) : [];
    $("#doctor-best").replaceChildren(...(best.length ? [h("span.muted.small", null, "Best match"), ...best.map(([, i]) => h("button.chip", { type: "button", onclick: () => renderDoctor(i) }, Q.doctor[i].status))] : []));
    $("#doctor-none").hidden = shown > 0;
  }
  function renderDoctor(index, fromHash) {
    const d = Q.doctor[index];
    document.querySelectorAll("#doctor-list button").forEach((b) => b.setAttribute("aria-pressed", String(Number(b.dataset.index) === index)));
    const lv = Q.levels.find((l) => l.id === d.level);
    // Each problem has its own link, so it can be shared or bookmarked.
    if (!fromHash) history.replaceState(null, "", "#fix/" + d.id);
    $("#doctor-out").replaceChildren(h("article.card.fix", { id: "fix-" + d.id },
      h("div.fix-head", null, h("h3", null, d.status), copyLink("fix/" + d.id, "problem")),
      h("h4", null, "The error"), h("pre.fix-error", null, h("code", null, d.error)),
      h("h4", null, "Why it happens"), h("p", null, d.meaning),
      h("h4", null, "Likely causes"), h("ul", null, d.causes.map((c) => h("li", null, c))),
      h("h4", null, "Confirm"), h("pre", null, h("code", null, d.commands.join("\n"))),
      h("h4", null, "Fix"), h("ol", null, d.fix.map((f) => h("li", null, /^(docker|sudo|echo|chmod|newgrp|cat|ls|df) /.test(f) ? h("code", null, f) : f))),
      h("h4", null, "Prevent it"), h("p", null, d.prevent),
      // Fixing is the way in; the point is to learn it, so every answer ends in practice.
      h("div.learn-it", null,
        h("h4", null, "Now learn it"),
        h("p", null, "Break this yourself in a safe playground and fix it. Doing it once is what makes you recognise it next time."),
        practiseRow(d.scenarios, "Practise:"),
        h("p.note", null, "Then the level that teaches it: ", h("a", { href: "#path", onclick: (e) => { e.preventDefault(); goTab("path", () => scrollToEl($("#" + stageId(lv.stage)))); } }, `Level ${lv.id} · ${lv.title}`)))));
    if (!fromHash) scrollToEl($("#doctor-out"));
  }

  // --- cheat sheet ---------------------------------------------------------

  function copyButton(text) {
    return h("button.copy", {
      type: "button", "aria-label": "Copy command",
      onclick: async (e) => {
        const b = e.currentTarget;
        try { await navigator.clipboard.writeText(text); b.textContent = "Copied"; } catch { b.textContent = "Select it"; }
        setTimeout(() => { b.textContent = "Copy"; }, 1200);
      }
    }, "Copy");
  }

  // Placeholders the reader can fill in once for every command.
  const FILL = [
    { key: "name", label: "Container", example: "web" },
    { key: "image", label: "Image", example: "nginx:1.27" },
    { key: "tag", label: "New tag", example: "myapp:1.0" },
    { key: "network", label: "Network", example: "app-net" }
  ];
  const fills = store.get("fill", {});
  const fillParts = (cmd) => cmd.split(/(<[a-z]+>)/).filter(Boolean).map((part) => {
    const m = /^<([a-z]+)>$/.exec(part);
    if (!m) return { text: part };
    const value = fills[m[1]];
    return value ? { text: value, filled: true } : { text: part, hole: true };
  });
  function renderFill() {
    $("#cheat-fill").replaceChildren(...FILL.map((f) => h("label.fill", null, f.label,
      h("input", {
        type: "text", value: fills[f.key] || "", placeholder: f.example, spellcheck: "false", autocapitalize: "off",
        oninput: (e) => {
          const v = e.target.value.trim().replace(/[^\w.:/@-]/g, "");
          if (v) fills[f.key] = v; else delete fills[f.key];
          store.set("fill", fills);
          renderCheats();
        }
      }))));
  }
  function renderCheats() {
    const q = $("#cheat-q").value.trim().toLowerCase();
    const out = $("#cheat-out");
    out.replaceChildren();
    const groups = new Map();
    for (const [cmd, what, group, where] of Q.cheats) {
      if (q && !(cmd + " " + what + " " + group).toLowerCase().includes(q)) continue;
      if (!groups.has(group)) groups.set(group, []);
      groups.get(group).push([cmd, what, where]);
    }
    if (!groups.size) { out.append(h("p.muted", null, "No match. Try a word like logs, network or prune.")); return; }
    const titles = scenarioTitles();
    for (const [group, rows] of groups) {
      out.append(h("h3.group", null, group), h("ul.cheats", null, rows.map(([cmd, what, where]) => {
        const parts = fillParts(cmd);
        const full = parts.map((p) => p.text).join("");
        const code = h("code", null, parts.map((p) => (p.filled ? h("span.filled", null, p.text) : p.hole ? h("span.hole", null, p.text) : p.text)));
        // Where names the scenario a command needs ("any" for whichever is open);
        // without one it needs Docker on your machine.
        const actions = h("div.cheat-actions", null,
          where && window.DQPlayground ? h("button.copy", {
            type: "button", title: where === "any" ? "Run it in the playground" : `Run it in the playground scenario "${titles[where]}"`,
            onclick: () => { location.hash = where === "any" ? "path" : "play/" + where; show(); window.DQPlayground.prefill(full, where); }
          }, "Try") : h("a.copy.lab", { href: repoUrl("docker_installation.md"), title: "Needs Docker on your machine" }, "Lab"),
          copyButton(full));
        return h("li", null, h("div", null, code, h("span.muted", null, what)), actions);
      })));
    }
  }

  // --- page guides -------------------------------------------------------------

  // Open on the inner pages, closed on the busy landing page and the references;
  // whatever the reader chooses afterwards is remembered per page.
  const GUIDES_CLOSED_BY_DEFAULT = ["playground", "path", "doctor", "xray"];
  function renderGuides() {
    const state = store.get("guides", {});
    document.querySelectorAll(".guide-slot").forEach((slot) => {
      const key = slot.dataset.guide;
      const g = Q.guides[key];
      const box = h("details.guide", { open: state[key] ?? !GUIDES_CLOSED_BY_DEFAULT.includes(key) },
        h("summary", null, "How to use this"),
        h("div.guide-body", null,
          h("p", null, ...rich(g.what)),
          h("div.guide-cols", null,
            h("div", null, h("h3", null, "How to use it"), h("ol", null, g.steps.map((t) => h("li", null, ...rich(t))))),
            h("div", null,
              h("h3", null, "What it is for"), h("ul", null, g.uses.map((t) => h("li", null, ...rich(t)))),
              h("h3", null, "Tips"), h("ul", null, g.tips.map((t) => h("li", null, ...rich(t))))))));
      // Browsers also fire "toggle" for a guide that starts open; save real changes only.
      let shown = box.open;
      box.addEventListener("toggle", () => {
        if (box.open === shown) return;
        shown = box.open;
        store.set("guides", { ...store.get("guides", {}), [key]: shown });
      });
      slot.replaceChildren(box);
    });
  }

  // --- command palette (Ctrl+K, Cmd+K or /) --------------------------------

  const palette = $("#palette");
  const paletteInput = $("#palette-input");
  const paletteList = $("#palette-list");
  let paletteItems = [];
  let paletteActive = 0;
  function goTab(tab, then) {
    location.hash = tab;
    show();
    if (then) then();
  }
  const ACTIONS = [
    { label: "Playground: fix a broken container", kind: "Section", run: () => goTab("path", () => { $("#pg-input").focus(); $(".playground").scrollIntoView(); }) },
    { label: "Your path", kind: "Section", run: () => goTab("path", () => $("#path-title").scrollIntoView()) },
    { label: "Exam: random questions from every level", kind: "Quiz", run: () => goTab("quiz", () => { $("#quiz-level").value = "exam"; renderQuiz(); }) },
    { label: "Dockerfile X-ray", kind: "Section", run: () => goTab("xray") },
    { label: "Fix: troubleshoot an error", kind: "Section", run: () => goTab("doctor") },
    { label: "Cheat sheet", kind: "Section", run: () => goTab("cheats", () => $("#cheat-q").focus()) },
    { label: "Docker architecture: every component explained", kind: "Section", run: () => goTab("arch") },
    ...Q.levels.map((lv) => ({ label: `${lv.id} · ${lv.title}`, hint: lv.topic, kind: "Level", run: () => goTab("path", () => scrollToEl(document.getElementById(stageId(lv.stage)))) })),
    ...Q.levels.map((lv) => ({ label: `Quiz: ${lv.id} · ${lv.topic}`, kind: "Quiz", run: () => goTab("quiz", () => { $("#quiz-level").value = lv.id; renderQuiz(); }) })),
    ...Q.doctor.map((d) => ({ label: `Troubleshoot: ${d.status}`, hint: d.error, kind: "Reference", run: () => { location.hash = "fix/" + d.id; } }))
  ];
  function renderPalette() {
    const words = paletteInput.value.toLowerCase().split(/\s+/).filter(Boolean);
    const scenarios = (window.DQPlayground ? window.DQPlayground.scenarios : []).map((sc) => ({ label: `Playground: ${sc.title}`, kind: "Practice", run: () => practise(sc.id) }));
    paletteItems = [...ACTIONS, ...scenarios].filter((a) => words.every((w) => `${a.label} ${a.hint || ""} ${a.kind}`.toLowerCase().includes(w))).slice(0, 8);
    paletteActive = Math.min(paletteActive, Math.max(0, paletteItems.length - 1));
    paletteList.replaceChildren(...paletteItems.map((a, i) => h("li", {
      role: "option", id: "pal-" + i, "aria-selected": String(i === paletteActive),
      onclick: () => choose(i), onmousemove: () => { if (paletteActive !== i) { paletteActive = i; renderPalette(); } }
    }, h("span.pal-label", null, a.label), h("span.pal-kind", null, a.kind))));
    if (!paletteItems.length) paletteList.append(h("li.pal-empty", null, "Nothing matches. Try a topic such as volumes or OOM."));
    paletteInput.setAttribute("aria-activedescendant", paletteItems.length ? "pal-" + paletteActive : "");
  }
  function openPalette() {
    if (palette.open) return;
    paletteInput.value = "";
    paletteActive = 0;
    renderPalette();
    palette.showModal();
    paletteInput.focus();
  }
  function choose(i) {
    const action = paletteItems[i];
    if (!action) return;
    palette.close();
    action.run();
  }
  paletteInput.addEventListener("input", () => { paletteActive = 0; renderPalette(); });
  paletteInput.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const n = paletteItems.length;
      if (n) paletteActive = (paletteActive + (e.key === "ArrowDown" ? 1 : n - 1)) % n;
      renderPalette();
      $("#pal-" + paletteActive)?.scrollIntoView({ block: "nearest" });
    } else if (e.key === "Enter") {
      e.preventDefault();
      choose(paletteActive);
    }
  });
  palette.addEventListener("click", (e) => { if (e.target === palette) palette.close(); });
  $("#palette-open").addEventListener("click", openPalette);
  if (/Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)) $("#palette-key").textContent = "⌘K";
  document.addEventListener("keydown", (e) => {
    const typing = /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement.tagName);
    if ((e.key === "k" || e.key === "K") && (e.ctrlKey || e.metaKey)) { e.preventDefault(); openPalette(); }
    else if (e.key === "/" && !typing) { e.preventDefault(); openPalette(); }
  });

  // --- init ----------------------------------------------------------------

  $("#quiz-level").append(h("option", { value: "exam" }, `Exam: ${EXAM_SIZE} random questions from every level`));
  for (const lv of Q.levels) $("#quiz-level").append(h("option", { value: lv.id }, `${lv.id} · ${lv.topic} (${questionsFor(lv.id).length} questions)`));
  $("#quiz-level").value = "00";
  $("#quiz-level").addEventListener("change", renderQuiz);
  $("#quiz-again").addEventListener("click", () => { renderQuiz(); $("#quiz-list").scrollIntoView({ block: "start" }); });
  // Pasting your own comes first; the repository's Dockerfiles follow.
  $("#xray-pick").append(h("button", { type: "button", role: "tab", "data-index": -1, onclick: () => { renderXray(-1); if (!pasted) $("#xray-input").focus(); } }, "Paste your Dockerfile"));
  Q.xray.forEach((x, i) => $("#xray-pick").append(h("button", { type: "button", role: "tab", "data-index": i, onclick: () => renderXray(i) }, x.name)));
  $("#xray-go").addEventListener("click", explainPasted);
  $("#xray-edit-btn").addEventListener("click", () => { pasted = null; renderXray(-1); $("#xray-input").focus(); });
  $("#xray-clear").addEventListener("click", () => { pasted = null; $("#xray-input").value = ""; $("#xray-error").hidden = true; renderXray(-1); $("#xray-input").focus(); });
  $("#xray-input").addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) explainPasted(); });
  $("#xray-example").addEventListener("click", () => { $("#xray-input").value = Q.xrayExample.join("\n") + "\n"; explainPasted(); });
  matchMedia("(max-width: 860px)").addEventListener("change", () => renderXray(xrayPick));
  buildDoctorList();
  $("#forget").addEventListener("click", forgetEverything);
  $("#doctor-list").before(h("div.doctor-practise", { id: "doctor-best", "aria-live": "polite" }));
  $("#doctor-list").after(h("p.muted", { id: "doctor-none", hidden: true }, "No problem matches. Paste the error line itself, or try an exit code (137), a word (denied, refused) or a thing (port, volume)."));
  $("#doctor-q").addEventListener("input", renderDoctorList);
  // The home page's "Something broken?" box hands the pasted error to Troubleshoot.
  const doorGo = () => { $("#doctor-q").value = $("#door-q").value; goTab("doctor", () => { renderDoctorList(); $("#doctor-q").focus(); }); };
  $("#door-go").addEventListener("click", doorGo);
  $("#door-q").addEventListener("keydown", (e) => { if (e.key === "Enter") doorGo(); });
  $("#cheat-q").addEventListener("input", renderCheats);
  renderFill();
  $("#cheat-fill-box").open = matchMedia("(min-width: 721px)").matches || Object.keys(fills).length > 0;

  // Shared with architecture.js, which loads after this script.
  window.DQUI = { h, rich, practiseRow, copyLink };

  renderGuides();
  renderStage();
  renderQuiz();
  renderXray(-1);
  show();
  // Practice links and Try buttons need the playground, which loads after this script.
  window.addEventListener("DOMContentLoaded", () => {
    renderPath();
    renderCheats();
    renderStats();
    if (current === "doctor") show();
    if (location.hash.startsWith("#play/")) window.DQPlayground.open(location.hash.slice(6));
  });
  window.addEventListener("hashchange", () => { if (location.hash.startsWith("#play/") && window.DQPlayground) window.DQPlayground.open(location.hash.slice(6)); });
})();
