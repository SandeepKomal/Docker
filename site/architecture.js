// The Docker architecture tab: a diagram in which every component can be
// pointed at, tapped or reached with Tab to read what it does and how it fails.
"use strict";

(function () {
  const { h, rich, practiseRow } = window.DQUI;
  const parts = Object.fromEntries(window.TRACK.architecture.components.map((c) => [c.id, c]));
  const root = document.getElementById("arch");

  const NS = "http://www.w3.org/2000/svg";
  function s(tag, attrs, ...kids) {
    const el = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs || {})) el.setAttribute(k, v);
    el.append(...kids);
    return el;
  }

  // Two hand-placed layouts: wide shows two containers, narrow stacks one.
  // Boxes are [x, y, width, height]; an id after @ repeats a component.
  const LAYOUTS = {
    wide: {
      size: [1040, 540], font: [13, 11],
      panels: [["Client", 20, 20, 180, 150, "outside"], ["Docker host", 220, 20, 600, 500, "host"], ["Registry", 840, 20, 180, 150, "outside"]],
      boxes: {
        client: [35, 60, 150, 60], registry: [855, 60, 150, 60],
        dockerd: [250, 60, 250, 64], buildkit: [540, 60, 250, 64],
        containerd: [250, 160, 250, 56], images: [540, 160, 250, 56],
        runc: [250, 250, 250, 56], networks: [540, 250, 250, 56],
        "container@a": [250, 340, 115, 56], "container@b": [385, 340, 115, 56], volumes: [540, 340, 250, 56],
        kernel: [250, 440, 540, 56]
      },
      edges: [
        ["client", "dockerd", [[185, 92], [250, 92]]],
        ["dockerd", "buildkit", [[500, 92], [540, 92]]],
        ["dockerd", "containerd", [[375, 124], [375, 160]]],
        ["buildkit", "images", [[665, 124], [665, 160]]],
        ["containerd", "images", [[500, 188], [540, 188]]],
        ["images", "registry", [[790, 188], [930, 188], [930, 120]]],
        ["containerd", "runc", [[375, 216], [375, 250]]],
        ["runc", "container@a", [[307, 306], [307, 340]]],
        ["runc", "container@b", [[442, 306], [442, 340]]],
        ["container@b", "networks", [[500, 362], [520, 362], [520, 278], [540, 278]]],
        ["container@b", "volumes", [[500, 374], [540, 374]]],
        ["container@a", "kernel", [[307, 396], [307, 440]]],
        ["container@b", "kernel", [[442, 396], [442, 440]]]
      ]
    },
    narrow: {
      size: [360, 520], font: [12, 10.5],
      panels: [["Docker host", 5, 80, 350, 430, "host"]],
      boxes: {
        client: [20, 10, 150, 48], registry: [190, 10, 150, 48],
        dockerd: [20, 120, 150, 50], buildkit: [190, 120, 150, 50],
        containerd: [20, 200, 150, 50], images: [190, 200, 150, 50],
        runc: [20, 280, 150, 50], networks: [190, 280, 150, 50],
        "container@a": [20, 360, 150, 50], volumes: [190, 360, 150, 50],
        kernel: [20, 440, 320, 50]
      },
      edges: [
        ["client", "dockerd", [[95, 58], [95, 120]]],
        ["dockerd", "buildkit", [[170, 145], [190, 145]]],
        ["dockerd", "containerd", [[95, 170], [95, 200]]],
        ["buildkit", "images", [[265, 170], [265, 200]]],
        ["containerd", "images", [[170, 225], [190, 225]]],
        ["images", "registry", [[340, 225], [350, 225], [350, 34], [340, 34]]],
        ["containerd", "runc", [[95, 250], [95, 280]]],
        ["runc", "container@a", [[95, 330], [95, 360]]],
        ["container@a", "networks", [[170, 380], [180, 380], [180, 305], [190, 305]]],
        ["container@a", "volumes", [[170, 392], [190, 392]]],
        ["container@a", "kernel", [[95, 410], [95, 440]]]
      ]
    }
  };
  const idOf = (key) => key.split("@")[0];

  // The journey of one docker run, played on the diagram.
  const TOUR = [
    [[["client", "dockerd"]], "You run docker run -d -p 8080:80 nginx:1.27. The CLI sends the request to dockerd over /var/run/docker.sock."],
    [[["dockerd", "containerd"], ["containerd", "images"]], "dockerd looks for nginx:1.27 in the local image store. It is not there yet."],
    [[["images", "registry"]], "So it is pulled from the registry: each layer is downloaded once, checked against its digest and unpacked."],
    [[["containerd", "runc"]], "dockerd hands the container to containerd, which starts a shim, and the shim runs runc."],
    [[["runc", "container@a"]], "runc asks the kernel for namespaces and cgroups, starts nginx as PID 1, and exits. The shim stays to report the exit code."],
    [[["container@a", "networks"]], "The container gets an IP on the bridge network, and a NAT rule forwards host port 8080 to its port 80."],
    [[["container@a", "kernel"]], "From here it is an ordinary Linux process. The kernel enforces its limits, and kills it if it passes its memory limit."]
  ];

  const figure = h("div.arch-figure");
  const tip = h("div.arch-tip", { "aria-hidden": "true" });
  const detail = h("div.arch-detail", { hidden: true, "aria-live": "polite" });
  const play = h("button.pill.small-pill", { type: "button", onclick: () => (touring ? stopTour() : tour()) }, "Follow a docker run");
  const caption = h("p.arch-caption", { "aria-live": "polite" }, "Point at any component to see what it does and what it talks to.");
  const still = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
  let svg = null, dot = null, pinned = null, touring = 0, entered = false;

  function draw() {
    const L = LAYOUTS[matchMedia("(max-width: 720px)").matches ? "narrow" : "wide"];
    const [w, ht] = L.size;
    const arrow = (id) => s("marker", { id, viewBox: "0 0 8 8", refX: 7, refY: 4, markerWidth: 7, markerHeight: 7, orient: "auto-start-reverse" }, s("path", { d: "M0 0 8 4 0 8z" }));
    svg = s("svg", { viewBox: `0 0 ${w} ${ht}`, class: "arch-svg", role: "group", "aria-label": "Docker architecture" },
      s("defs", null, arrow("arch-arrow"), arrow("arch-arrow-on")));
    for (const [label, x, y, pw, ph, kind] of L.panels) {
      svg.append(s("rect", { x, y, width: pw, height: ph, rx: 16, class: `arch-panel arch-${kind}` }), s("text", { x: x + 14, y: y + 22, class: "arch-panel-label" }, label));
    }
    for (const [from, to, pts] of L.edges) svg.append(s("polyline", { points: pts.join(" "), class: "arch-edge", "data-from": from, "data-to": to, "marker-end": "url(#arch-arrow)" }));
    Object.entries(L.boxes).forEach(([key, [x, y, bw, bh]], i) => {
      const c = parts[idOf(key)];
      const g = s("g", { class: `arch-box arch-${c.where === "Docker host" ? "host" : "outside"}`, "data-id": c.id, "data-key": key },
        s("rect", { x, y, width: bw, height: bh, rx: 10 }),
        s("text", { x: x + bw / 2, y: y + bh / 2 - 3, class: "arch-name", "font-size": L.font[0] }, c.name),
        s("text", { x: x + bw / 2, y: y + bh / 2 + L.font[1] + 2, class: "arch-short", "font-size": L.font[1] }, c.short));
      g.style.animationDelay = `${120 + i * 28}ms`;
      // One stop per component for the keyboard, on its first box.
      if (!svg.querySelector(`[data-id="${c.id}"]`)) {
        g.setAttribute("tabindex", "0");
        g.setAttribute("role", "button");
        g.setAttribute("aria-label", `${c.name}: ${c.short}`);
      }
      g.addEventListener("mouseenter", () => touring || select(c.id));
      g.addEventListener("focus", () => touring || select(c.id));
      g.addEventListener("click", () => { stopTour(); pinned = c.id; select(c.id); open(c.id); });
      g.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); g.dispatchEvent(new Event("click")); } });
      svg.append(g);
    });
    dot = s("circle", { r: 6, class: "arch-dot" });
    svg.append(dot);
    svg.addEventListener("mouseleave", () => touring || select(pinned));
    figure.replaceChildren(svg, tip, h("div.arch-tour", null, play, caption));
    stopTour();
    select(pinned);
  }

  // Light up some components and edges; with one id, its neighbours too.
  function light(ids, edges) {
    svg.classList.toggle("has-focus", ids.length > 0);
    const near = new Set(ids);
    svg.querySelectorAll(".arch-edge").forEach((e) => {
      const ends = [idOf(e.dataset.from), idOf(e.dataset.to)];
      const on = edges ? edges.includes(e) : ends.some((x) => ids.includes(x));
      if (on) ends.forEach((x) => near.add(x));
      e.classList.toggle("is-on", on);
      e.setAttribute("marker-end", `url(#arch-arrow${on ? "-on" : ""})`);
    });
    svg.querySelectorAll(".arch-box").forEach((g) => {
      g.classList.toggle("is-on", ids.includes(g.dataset.id));
      g.classList.toggle("is-near", !ids.includes(g.dataset.id) && near.has(g.dataset.id));
    });
  }
  function select(id) {
    light(id ? [id] : []);
    place(id);
  }

  // A click opens everything about a component below the diagram.
  function open(id) {
    const c = parts[id];
    detail.replaceChildren(h("div.card", null,
      h("p.arch-where", null, c.where), h("h3", null, c.name), h("p", null, c.role),
      h("h4", null, "What it does"), h("ul", null, c.does.map((d) => h("li", null, rich(d)))),
      h("h4", null, "When it breaks"), h("p", null, rich(c.breaks)),
      h("h4", null, "Look at it"), h("pre", null, h("code", null, c.look.join("\n"))),
      practiseRow(c.practise, "Practise in the playground:")));
    detail.hidden = false;
    detail.scrollIntoView({ block: "nearest", behavior: still() ? "auto" : "smooth" });
  }

  // On hover, a short tip beside the component; touch screens go straight to the click.
  function place(id) {
    const show = id && figure.offsetParent && !matchMedia("(max-width: 720px), (hover: none)").matches;
    tip.classList.toggle("is-shown", Boolean(show));
    if (!show) return;
    const c = parts[id];
    tip.replaceChildren(h("p.arch-where", null, c.where), h("h3", null, c.name), h("p", null, c.role),
      h("p", null, h("strong", null, "When it breaks: "), rich(c.breaks)), h("p.muted.small", null, "Click for commands and practice"));
    const box = svg.querySelector(`[data-id="${id}"] rect`).getBoundingClientRect();
    const frame = figure.getBoundingClientRect();
    const right = box.right - frame.left + 12;
    const left = right + tip.offsetWidth <= frame.width ? right : Math.max(0, box.left - frame.left - tip.offsetWidth - 12);
    const top = Math.min(Math.max(0, box.top - frame.top - 8), Math.max(0, frame.height - tip.offsetHeight - 60));
    tip.style.left = `${left}px`;
    tip.style.top = `${top}px`;
  }

  // Move the dot along an edge, in either direction.
  function travel(from, to, run) {
    const e = [...svg.querySelectorAll(".arch-edge")].find((x) => (x.dataset.from === from && x.dataset.to === to) || (x.dataset.from === to && x.dataset.to === from));
    let pts = e.getAttribute("points").split(" ").map((p) => p.split(",").map(Number));
    if (e.dataset.from !== from) pts = pts.reverse();
    const segs = pts.slice(1).map((p, i) => [pts[i], p, Math.hypot(p[0] - pts[i][0], p[1] - pts[i][1])]);
    const total = segs.reduce((n, sg) => n + sg[2], 0);
    const at = (d) => {
      for (const [a, b, len] of segs) { if (d <= len) return [a[0] + (b[0] - a[0]) * d / len, a[1] + (b[1] - a[1]) * d / len]; d -= len; }
      return pts[pts.length - 1];
    };
    dot.classList.add("is-on");
    return { edge: e, done: new Promise((resolve) => {
      if (still()) { [dot.cx.baseVal.value, dot.cy.baseVal.value] = pts[pts.length - 1]; return resolve(); }
      const ms = Math.max(450, total * 2.2), start = performance.now();
      const frame = (now) => {
        if (run !== touring) return resolve();
        const t = Math.min(1, (now - start) / ms), ease = t < .5 ? 2 * t * t : 1 - (2 - 2 * t) ** 2 / 2;
        [dot.cx.baseVal.value, dot.cy.baseVal.value] = at(total * ease);
        if (t < 1) requestAnimationFrame(frame); else resolve();
      };
      requestAnimationFrame(frame);
    }) };
  }
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  async function tour() {
    const run = ++touring;
    pinned = null;
    place(null);
    play.textContent = "Stop";
    for (const [n, [hops, text]] of TOUR.entries()) {
      caption.replaceChildren(h("span.arch-step", null, `${n + 1} of ${TOUR.length}`), text);
      const edges = [];
      for (const [from, to] of hops) {
        const leg = travel(from, to, run);
        edges.push(leg.edge);
        light([...new Set(hops.flat().map(idOf))], edges);
        await leg.done;
        if (run !== touring) return;
      }
      await wait(still() ? 3200 : 1500);
      if (run !== touring) return;
    }
    stopTour("Played. Point at any component to read more, or play it again.");
  }
  function stopTour(text) {
    touring = 0;
    if (dot) dot.classList.remove("is-on");
    play.textContent = "Follow a docker run";
    if (text) caption.textContent = text;
    if (svg) light([]);
  }

  // The diagram assembles itself the first time the tab opens.
  function enter() {
    if (entered || location.hash !== "#arch" || still()) return;
    entered = true;
    svg.classList.add("is-entering");
    setTimeout(() => svg.classList.remove("is-entering"), 1400);
  }

  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && (pinned || touring)) { pinned = null; stopTour(); select(null); } });
  matchMedia("(max-width: 720px)").addEventListener("change", draw);
  window.addEventListener("hashchange", () => { if (location.hash !== "#arch") stopTour(); enter(); });
  window.addEventListener("DOMContentLoaded", () => {
    draw();
    root.replaceChildren(figure, detail);
    enter();
  });
})();
