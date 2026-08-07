/**
 * View preferences — density, panel visibility, column widths, collapsed
 * sections. All persisted to localStorage so the layout the user builds is
 * the layout they get back. Nothing here talks to the server.
 */

const KEY = "foreman.view";
const DEFAULTS = {
  density: "cosy",
  wrap: true,
  hidden: [],       // panel element ids the user switched off
  collapsed: [],    // right-rail sections collapsed to just their title
  leftWidth: 250,
  rightWidth: 340,
};

let prefs = { ...DEFAULTS };

function load() {
  try {
    prefs = { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) || "{}") };
  } catch {
    prefs = { ...DEFAULTS };
  }
}
function save() {
  localStorage.setItem(KEY, JSON.stringify(prefs));
}

function apply() {
  const root = document.documentElement;
  root.dataset.density = prefs.density;
  root.dataset.wrap = prefs.wrap ? "on" : "off";
  root.style.setProperty("--left-w", `${prefs.leftWidth}px`);
  root.style.setProperty("--right-w", `${prefs.rightWidth}px`);

  for (const id of ["sessions-panel", "tasks-panel", "roster-panel", "changes-panel", "promptings-panel"]) {
    document.getElementById(id)?.classList.toggle("panel-off", prefs.hidden.includes(id));
  }
  // the whole right rail (and its resizer) disappears when every section is off
  const rbIds = ["tasks-panel", "roster-panel", "changes-panel", "promptings-panel"];
  const rbEmpty = rbIds.every((id) => prefs.hidden.includes(id));
  document.getElementById("rightbar")?.classList.toggle("panel-off", rbEmpty);
  document.getElementById("resize-right")?.classList.toggle("panel-off", rbEmpty);
  document.getElementById("resize-left")?.classList.toggle("panel-off", prefs.hidden.includes("sessions-panel"));

  for (const id of rbIds) {
    document.getElementById(id)?.classList.toggle("collapsed", prefs.collapsed.includes(id));
  }

  for (const el of document.querySelectorAll("#density-seg button")) {
    el.classList.toggle("on", el.dataset.v === prefs.density);
  }
  for (const el of document.querySelectorAll("#view-menu [data-panel]")) {
    el.checked = !prefs.hidden.includes(el.dataset.panel);
  }
  const wrapEl = document.getElementById("wrap-toggle");
  if (wrapEl) wrapEl.checked = prefs.wrap;
}

function toggleIn(list, value) {
  const i = list.indexOf(value);
  if (i === -1) list.push(value); else list.splice(i, 1);
}

/** Pointer-drag column resizing, clamped so a column can't vanish by accident. */
function bindResizer(id, side) {
  const el = document.getElementById(id);
  if (!el) return;
  el.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    el.setPointerCapture(e.pointerId);
    el.classList.add("dragging");
    const startX = e.clientX;
    const startW = side === "left" ? prefs.leftWidth : prefs.rightWidth;

    const move = (ev) => {
      const delta = side === "left" ? ev.clientX - startX : startX - ev.clientX;
      const next = Math.min(560, Math.max(180, startW + delta));
      if (side === "left") prefs.leftWidth = next; else prefs.rightWidth = next;
      document.documentElement.style.setProperty(
        side === "left" ? "--left-w" : "--right-w", `${next}px`,
      );
    };
    const up = () => {
      el.classList.remove("dragging");
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      save();
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
  });
  el.addEventListener("dblclick", () => {
    if (side === "left") prefs.leftWidth = DEFAULTS.leftWidth;
    else prefs.rightWidth = DEFAULTS.rightWidth;
    save(); apply();
  });
}

export function bindViewPrefs() {
  load();
  apply();

  const menu = document.getElementById("view-menu");
  document.getElementById("view-btn").addEventListener("click", (e) => {
    e.stopPropagation();
    menu.classList.toggle("hidden");
  });
  document.addEventListener("click", (e) => {
    if (!menu.contains(e.target) && e.target.id !== "view-btn") menu.classList.add("hidden");
  });

  document.getElementById("density-seg").addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-v]");
    if (!btn) return;
    prefs.density = btn.dataset.v;
    save(); apply();
  });

  for (const box of menu.querySelectorAll("[data-panel]")) {
    box.addEventListener("change", () => {
      toggleIn(prefs.hidden, box.dataset.panel);
      save(); apply();
    });
  }

  document.getElementById("wrap-toggle").addEventListener("change", (e) => {
    prefs.wrap = e.target.checked;
    save(); apply();
  });

  document.getElementById("view-reset").addEventListener("click", () => {
    prefs = { ...DEFAULTS, hidden: [], collapsed: [] };
    save(); apply();
  });

  // click a right-rail panel title to collapse it down to just the header
  for (const title of document.querySelectorAll("[data-collapse]")) {
    title.addEventListener("click", () => {
      toggleIn(prefs.collapsed, title.dataset.collapse);
      save(); apply();
    });
  }

  bindResizer("resize-left", "left");
  bindResizer("resize-right", "right");
}
