import { App, PostMessageTransport } from "@modelcontextprotocol/ext-apps";
import {
  PLUGIN_VERSION,
  SERVER_NAME,
  type NicheRecord,
} from "#niche/contract.ts";
import {
  PANEL_TEXT,
  formatQuota,
  nicheItems,
  videoRows,
  type QuotaInfo,
} from "#niche/panel-format.ts";

interface NicheListResult {
  isError?: boolean;
  structuredContent?: {
    niches?: NicheRecord[];
    quota?: QuotaInfo;
  };
}

interface NicheVideosResult {
  isError?: boolean;
  structuredContent?: {
    videos?: Array<{
      video_id: string;
      title: string;
      view_count: number | null;
      like_count: number | null;
      duration_seconds: number | null;
    }>;
  };
}

interface NicheExportResult {
  isError?: boolean;
  structuredContent?: {
    exported?: boolean;
    path?: string;
  };
}

/** Any tool result: only read structurally, never trust shape. */
const authUrlOf = (result: unknown): string | null => {
  const structured = (result as { structuredContent?: Record<string, unknown> })
    .structuredContent;
  const url = structured?.authUrl;
  return typeof url === "string" ? url : null;
};
const connectSettled = (result: unknown): boolean =>
  "connected" in ((result as { structuredContent?: Record<string, unknown> }).structuredContent ?? {});

// One App connection per page (office-runtime ui/host.ts pattern); handlers are
// installed before connect so nothing sent during the handshake is lost.
const app = new App(
  { name: SERVER_NAME, version: PLUGIN_VERSION },
  { tools: { listChanged: true }, availableDisplayModes: ["inline", "fullscreen"] },
  { autoResize: false },
);

const root = document.getElementById("root");

// Panel state that survives the full re-render on every tool result.
let expandedNiche: string | null = null;
let pendingAuthUrl: string | null = null;

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

function renderAuthBanner(card: HTMLElement): void {
  if (!pendingAuthUrl) return;
  const banner = document.createElement("div");
  banner.className = "auth";
  text(banner, "auth-title", PANEL_TEXT.connectPrompt);
  const link = document.createElement("a");
  link.href = pendingAuthUrl;
  link.target = "_blank";
  link.rel = "noopener";
  link.textContent = pendingAuthUrl;
  banner.append(link);
  card.append(banner);
}

function renderQuota(card: HTMLElement, quota: QuotaInfo | undefined): void {
  if (!quota) return;
  const bar = document.createElement("div");
  bar.className = "quota";
  const fill = document.createElement("div");
  fill.className = "quota-fill";
  fill.style.width = `${Math.min(100, Math.round((quota.used / quota.limit) * 100))}%`;
  bar.append(fill);
  card.append(bar);
  text(card, "quota-text", formatQuota(quota));
}

async function appendVideos(row: HTMLElement, name: string): Promise<void> {
  const holder = document.createElement("div");
  holder.className = "videos";
  row.append(holder);
  text(holder, "meta", "…");
  try {
    const result = (await app.callServerTool({
      name: "niche_videos",
      arguments: { name },
    })) as NicheVideosResult;
    const videos = result.isError ? undefined : result.structuredContent?.videos;
    holder.replaceChildren();
    if (!videos || !videos.length) {
      text(holder, "meta", PANEL_TEXT.videosEmpty);
      return;
    }
    const table = document.createElement("table");
    const head = document.createElement("tr");
    for (const label of ["标题", "views", "likes", "时长"]) {
      const th = document.createElement("th");
      th.textContent = label;
      head.append(th);
    }
    table.append(head);
    for (const video of videoRows(videos)) {
      const tr = document.createElement("tr");
      for (const cell of [video.title, video.views, video.likes, video.duration]) {
        const td = document.createElement("td");
        td.textContent = cell;
        tr.append(td);
      }
      table.append(tr);
    }
    holder.append(table);
    // CSV export of exactly what is collected; the click must not bubble
    // into the row toggle that would collapse the detail view.
    const exportBtn = document.createElement("button");
    exportBtn.className = "export";
    exportBtn.type = "button";
    exportBtn.textContent = PANEL_TEXT.exportLabel;
    exportBtn.onclick = (event) => {
      event.stopPropagation();
      void (async () => {
        exportBtn.disabled = true;
        try {
          const result = (await app.callServerTool({
            name: "niche_export",
            arguments: { name, format: "csv" },
          })) as NicheExportResult;
          const structured = result.isError ? undefined : result.structuredContent;
          exportBtn.textContent = structured?.exported
            ? `${PANEL_TEXT.exportDone}: ${structured.path ?? ""}`
            : PANEL_TEXT.exportFailed;
        } catch {
          exportBtn.textContent = PANEL_TEXT.exportFailed;
        }
      })();
    };
    holder.append(exportBtn);
  } catch {
    holder.replaceChildren();
    text(holder, "error", PANEL_TEXT.videosFailed);
  }
}

function renderNiches(niches: readonly NicheRecord[], quota: QuotaInfo | undefined): void {
  if (!root) return;
  root.replaceChildren();
  const card = document.createElement("div");
  card.className = "panel";
  const heading = document.createElement("h1");
  heading.textContent = PANEL_TEXT.title;
  card.append(heading);
  renderAuthBanner(card);
  renderQuota(card, quota);
  const items = nicheItems(niches);
  if (!items.length) {
    text(card, "empty", PANEL_TEXT.empty);
    text(card, "empty", PANEL_TEXT.emptyHint);
  } else {
    for (const item of items) {
      const row = document.createElement("div");
      row.className = "item";
      row.tabIndex = 0;
      text(row, "name", item.name);
      text(row, "meta", item.meta);
      if (item.notes) text(row, "notes", item.notes);
      const toggle = () => {
        expandedNiche = expandedNiche === item.name ? null : item.name;
        void refresh();
      };
      row.onclick = toggle;
      row.onkeydown = (event) => {
        if (event.key === "Enter" || event.key === " ") toggle();
      };
      if (expandedNiche === item.name) {
        row.classList.add("expanded");
        void appendVideos(row, item.name);
      }
      card.append(row);
    }
  }
  root.append(card);
}

// The niche_* and youtube_* tools declare _meta.ui visibility ["model","app"],
// so every tool result reaches this page; the list is re-fetched from the
// server as the single source of truth, while connect results carry the
// authorization URL (or settle it) in their structured content.
async function refresh(): Promise<void> {
  const result = (await app.callServerTool({
    name: "niche_list",
    arguments: {},
  })) as NicheListResult;
  if (result.isError || !Array.isArray(result.structuredContent?.niches)) {
    throw new Error("niche_list failed");
  }
  renderNiches(result.structuredContent.niches, result.structuredContent.quota);
}

app.ontoolresult = (result: unknown) => {
  const url = authUrlOf(result);
  if (url) pendingAuthUrl = url;
  if (connectSettled(result)) pendingAuthUrl = null;
  void refresh();
};

void (async () => {
  try {
    await app.connect(new PostMessageTransport(window.parent, window.parent));
    await refresh();
  } catch (error) {
    renderError(error instanceof Error ? error.message : String(error));
  }
})();
