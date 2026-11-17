import { App, PostMessageTransport } from "@modelcontextprotocol/ext-apps";
import { PLUGIN_VERSION, SERVER_NAME, type NicheRecord } from "#niche/contract.ts";
import { PANEL_TEXT, nicheItems } from "#niche/panel-format.ts";

interface NicheListResult {
  isError?: boolean;
  structuredContent?: { niches?: NicheRecord[] };
}

// One App connection per page (office-runtime ui/host.ts pattern); handlers are
// installed before connect so nothing sent during the handshake is lost.
const app = new App(
  { name: SERVER_NAME, version: PLUGIN_VERSION },
  { tools: { listChanged: true }, availableDisplayModes: ["inline", "fullscreen"] },
  { autoResize: false },
);

const root = document.getElementById("root");

function text(parent: HTMLElement, className: string, value: string): HTMLElement {
  const node = document.createElement("div");
  node.className = className;
  node.textContent = value;
  parent.append(node);
  return node;
}

function renderError(message: string): void {
  if (!root) return;
  root.replaceChildren();
  const card = document.createElement("div");
  card.className = "panel";
  text(card, "error", `${PANEL_TEXT.loadFailed}: ${message}`);
  root.append(card);
}

function renderNiches(niches: readonly NicheRecord[]): void {
  if (!root) return;
  root.replaceChildren();
  const card = document.createElement("div");
  card.className = "panel";
  const heading = document.createElement("h1");
  heading.textContent = PANEL_TEXT.title;
  card.append(heading);
  const items = nicheItems(niches);
  if (!items.length) {
    text(card, "empty", PANEL_TEXT.empty);
    text(card, "empty", PANEL_TEXT.emptyHint);
  } else {
    for (const item of items) {
      const row = document.createElement("div");
      row.className = "item";
      text(row, "name", item.name);
      text(row, "meta", item.meta);
      if (item.notes) text(row, "notes", item.notes);
      card.append(row);
    }
  }
  root.append(card);
}

// The niche_* tools declare _meta.ui visibility ["model","app"], so every tool
// result reaches this page; the list is re-fetched from the server as the
// single source of truth (tool results carry no tool name to filter on).
async function refresh(): Promise<void> {
  const result = (await app.callServerTool({
    name: "niche_list",
    arguments: {},
  })) as NicheListResult;
  if (result.isError || !Array.isArray(result.structuredContent?.niches)) {
    throw new Error("niche_list failed");
  }
  renderNiches(result.structuredContent.niches);
}

app.ontoolresult = () => void refresh();

void (async () => {
  try {
    await app.connect(new PostMessageTransport(window.parent, window.parent));
    await refresh();
  } catch (error) {
    renderError(error instanceof Error ? error.message : String(error));
  }
})();
