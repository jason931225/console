// Island hydrate bootstrap. Paths are the axum routes under GET /_ui/pkg/.
// Adapted from leptos 0.9.0-beta island_script.js (MIT).
import init, * as mod from "/_ui/pkg/console_payroll_ui.js";

const MOST_RECENT_CHILDREN_CB = [];

function idle(c) {
  if ("requestIdleCallback" in window) {
    window.requestIdleCallback(c);
  } else {
    c();
  }
}

async function hydrateIslands(rootNode) {
  async function traverse(node) {
    if (node.nodeType !== Node.ELEMENT_NODE) {
      return;
    }
    const tag = node.tagName.toLowerCase();
    if (tag === "leptos-island") {
      const id = node.dataset.component || null;
      await hydrateIsland(node, id);
      for (const child of node.children) {
        await traverse(child);
      }
    } else if (tag === "leptos-children") {
      MOST_RECENT_CHILDREN_CB.push(node.$$on_hydrate);
      for (const child of node.children) {
        await traverse(child);
      }
      MOST_RECENT_CHILDREN_CB.pop();
    } else {
      for (const child of node.children) {
        await traverse(child);
      }
    }
  }
  await traverse(rootNode);
}

async function hydrateIsland(el, id) {
  const islandFn = mod[id];
  if (islandFn) {
    const children_cb = MOST_RECENT_CHILDREN_CB[MOST_RECENT_CHILDREN_CB.length - 1];
    if (children_cb) {
      children_cb();
    }
    const res = islandFn(el);
    if (res && res.then) {
      await res;
    }
  } else {
    console.warn(`Could not find WASM function for the island ${id}.`);
  }
}

idle(() => {
  init({ module_or_path: "/_ui/pkg/console_payroll_ui_bg.wasm" }).then(() => {
    mod.hydrate();
    hydrateIslands(document.body);
  });
});
