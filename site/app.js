// Docker Quest site. No dependencies, no network requests.
"use strict";

(function () {
  const Q = window.QUEST;
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
  function practise(id) { location.hash = "path"; show(); window.DQPlayground.load(id); }
  const practiseRow = (ids, label) => {
    const titles = scenarioTitles();
    const known = (ids || []).filter((id) => titles[id]);
    return known.length ? h("div.doctor-practise", null, h("span.muted.small", null, label),
      known.map((id) => h("button.chip", { type: "button", onclick: () => practise(id) }, titles[id]))) : null;
  };

  const repoUrl = (p) => `${Q.repo}/${/\.[a-z]+$|^Docker Networks$/.test(p) ? "blob" : "tree"}/main/${p.split("/").map(encodeURIComponent).join("/")}`;
  $("#gh-link").href = Q.repo;
  document.querySelectorAll("[data-repo]").forEach((a) => { a.href = Q.repo + a.dataset.repo; });

  // --- tabs ----------------------------------------------------------------

  const tabs = ["path", "quiz", "xray", "doctor", "cheats", "arch"];
  let current = null;
  function show() {
    const [want, sub] = location.hash.slice(1).split("/");
    const tab = tabs.includes(want) ? want : "path";
    if (tab === "doctor" && sub) {
      const i = Q.doctor.findIndex((d) => slug(d.status) === sub);
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

  // --- hero: one image, before and after -------------------------------------

  function renderMotif() {
    const max = Math.max(...Q.motif.flatMap((img) => img.layers.map((l) => l[2])));
    $("#motif").replaceChildren(...Q.motif.map((img) => h("div.motif-img", null,
      h("p.motif-head", null, h("span", null, img.tag), h("strong", null, img.size)),
      img.layers.map(([by, size, mb, why]) => {
        const bar = h("span.motif-bar");
        bar.style.width = `${Math.max(1, mb / max * 100)}%`;
        return h("div.motif-row" + (why ? ".bad" : ""), null, h("span.motif-by", null, by), h("span.motif-size", null, size), bar, why ? h("span.motif-why", null, why) : null);
      }))));
    $("#motif-try").addEventListener("click", () => practise("bigimage"));
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
      list.append(h("li.level" + (isDone ? ".done" : ""), null,
        h("input", {
          type: "checkbox", checked: isDone, "aria-label": `Mark level ${lv.id} complete`,
          onchange: (e) => {
            if (e.target.checked) done.add(lv.id); else done.delete(lv.id);
            store.set("done", [...done]);
            renderPath();
          }
        }),
        h("span.num", null, lv.id),
        h("details.what", null,
          h("summary", null, h("span.title", null, lv.title), h("span.topic", null, lv.topic)),
          h("div.level-body", null,
            h("div", null, h("h4", null, "What you learn"), h("ul", null, lv.learn.map((t) => h("li", null, ...rich(t))))),
            h("div", null, h("h4", null, "Lab on your machine"), h("pre", null, h("code", null, lv.lab.join("\n")))),
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
  const questionsFor = (id) => (window.QUEST_QUIZ[id] || []).map((item) => ({ ...item, level: id }));
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

  const slug = (text) => text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  function buildDoctorList() {
    const index = new Map(Q.doctor.map((d, i) => [d.status, i]));
    $("#doctor-list").replaceChildren(...Q.doctorGroups.map(([name, statuses]) => h("div.doctor-group", null,
      h("div.doctor-group-name", null, name, h("span.doctor-group-count", null, String(statuses.length))),
      h("div.doctor-group-items", null, statuses.map((s) => h("button.chip", {
        type: "button", "data-index": index.get(s), "aria-pressed": "false", onclick: () => renderDoctor(index.get(s))
      }, s))))));
  }
  function renderDoctorList() {
    const words = $("#doctor-q").value.toLowerCase().split(/\s+/).filter(Boolean);
    let shown = 0;
    for (const group of document.querySelectorAll(".doctor-group")) {
      let inGroup = 0;
      for (const b of group.querySelectorAll("button")) {
        const d = Q.doctor[b.dataset.index];
        b.hidden = !words.every((w) => [d.status, d.meaning, ...d.causes, ...d.commands].join(" ").toLowerCase().includes(w));
        if (!b.hidden) inGroup++;
      }
      group.hidden = !inGroup;
      group.querySelector(".doctor-group-count").textContent = String(inGroup);
      shown += inGroup;
    }
    $("#doctor-none").hidden = shown > 0;
  }
  function renderDoctor(index, fromHash) {
    const d = Q.doctor[index];
    document.querySelectorAll("#doctor-list button").forEach((b) => b.setAttribute("aria-pressed", String(Number(b.dataset.index) === index)));
    const lv = Q.levels.find((l) => l.id === d.level);
    // Each symptom has its own link, so it can be shared or bookmarked.
    if (!fromHash) history.replaceState(null, "", "#doctor/" + slug(d.status));
    $("#doctor-out").replaceChildren(h("div.card", null,
      h("h3", null, d.status),
      h("p", null, d.meaning),
      h("h4", null, "Likely causes"),
      h("ul", null, d.causes.map((c) => h("li", null, c))),
      h("h4", null, "Confirm with"),
      h("pre", null, h("code", null, d.commands.join("\n"))),
      practiseRow(d.scenarios, "Try the fix in the playground:"),
      h("p.note", null, "Learn it: ", h("a", { href: "#path", onclick: () => setTimeout(() => scrollToEl($("#" + stageId(lv.stage)))) }, `Level ${lv.id} · ${lv.title}`))));
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
            onclick: () => { location.hash = "path"; show(); window.DQPlayground.prefill(full, where); }
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
    { label: "Troubleshooting reference", kind: "Section", run: () => goTab("doctor") },
    { label: "Cheat sheet", kind: "Section", run: () => goTab("cheats", () => $("#cheat-q").focus()) },
    { label: "Docker architecture: every component explained", kind: "Section", run: () => goTab("arch") },
    ...Q.levels.map((lv) => ({ label: `${lv.id} · ${lv.title}`, hint: lv.topic, kind: "Level", run: () => goTab("path", () => scrollToEl(document.getElementById(stageId(lv.stage)))) })),
    ...Q.levels.map((lv) => ({ label: `Quiz: ${lv.id} · ${lv.topic}`, kind: "Quiz", run: () => goTab("quiz", () => { $("#quiz-level").value = lv.id; renderQuiz(); }) })),
    ...Q.doctor.map((d, i) => ({ label: `Troubleshoot: ${d.status}`, kind: "Reference", run: () => goTab("doctor", () => renderDoctor(i)) }))
  ];
  function renderPalette() {
    const words = paletteInput.value.toLowerCase().split(/\s+/).filter(Boolean);
    const scenarios = (window.DQPlayground ? window.DQPlayground.scenarios : []).map((sc) => ({ label: `Playground: ${sc.title}`, kind: "Practice", run: () => goTab("path", () => window.DQPlayground.load(sc.id)) }));
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
  $("#doctor-list").after(h("p.muted", { id: "doctor-none", hidden: true }, "No symptom matches. Try an exit code (137), an error word (denied, refused) or a thing (port, volume)."));
  $("#doctor-q").addEventListener("input", renderDoctorList);
  $("#cheat-q").addEventListener("input", renderCheats);
  renderFill();
  $("#cheat-fill-box").open = matchMedia("(min-width: 721px)").matches || Object.keys(fills).length > 0;

  // Shared with architecture.js, which loads after this script.
  window.DQUI = { h, rich, practiseRow };

  renderGuides();
  renderMotif();
  renderQuiz();
  renderXray(-1);
  show();
  // Practice links and Try buttons need the playground, which loads after this script.
  window.addEventListener("DOMContentLoaded", () => {
    renderPath();
    renderCheats();
    if (current === "doctor") show();
  });
})();
