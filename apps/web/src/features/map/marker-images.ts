import type { EventCategory } from "@verity/contracts";
import type { IconNode } from "lucide";
import { CATEGORY_DISPLAY, MARKER_GROUPS, type MarkerGroup } from "../../lib/display";
import type { MapTheme } from "./map-layers";

export interface RasterImage {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

/** Draw a lucide icon node with Canvas 2D: synchronous, no network, no innerHTML. */
function drawIcon(ctx: CanvasRenderingContext2D, icon: IconNode, cx: number, cy: number, size: number, color: string) {
  ctx.save();
  ctx.translate(cx - size / 2, cy - size / 2);
  ctx.scale(size / 24, size / 24);
  ctx.strokeStyle = color;
  ctx.lineWidth = 2.25;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (const [tag, raw] of icon) {
    const a = raw as Record<string, string | number | undefined>;
    const n = (k: string) => Number(a[k] ?? 0);
    ctx.beginPath();
    switch (tag) {
      case "path":
        ctx.stroke(new Path2D(String(a.d)));
        continue;
      case "circle":
        ctx.arc(n("cx"), n("cy"), n("r"), 0, Math.PI * 2);
        break;
      case "ellipse":
        ctx.ellipse(n("cx"), n("cy"), n("rx"), n("ry"), 0, 0, Math.PI * 2);
        break;
      case "line":
        ctx.moveTo(n("x1"), n("y1"));
        ctx.lineTo(n("x2"), n("y2"));
        break;
      case "rect":
        if (typeof ctx.roundRect === "function") ctx.roundRect(n("x"), n("y"), n("width"), n("height"), n("rx"));
        else ctx.rect(n("x"), n("y"), n("width"), n("height"));
        break;
      case "polyline":
      case "polygon": {
        const pts = String(a.points ?? "")
          .trim()
          .split(/[\s,]+/)
          .map(Number);
        for (let i = 0; i + 1 < pts.length; i += 2) {
          if (i === 0) ctx.moveTo(pts[i]!, pts[i + 1]!);
          else ctx.lineTo(pts[i]!, pts[i + 1]!);
        }
        if (tag === "polygon") ctx.closePath();
        break;
      }
      default:
        continue;
    }
    ctx.stroke();
  }
  ctx.restore();
}

function canvas(size: number, pixelRatio: number): CanvasRenderingContext2D | null {
  const el = document.createElement("canvas");
  el.width = Math.ceil(size * pixelRatio);
  el.height = Math.ceil(size * pixelRatio);
  const ctx = el.getContext("2d");
  if (!ctx) return null;
  ctx.scale(pixelRatio, pixelRatio);
  return ctx;
}

function toRaster(ctx: CanvasRenderingContext2D): RasterImage {
  const { width, height } = ctx.canvas;
  return { width, height, data: ctx.getImageData(0, 0, width, height).data };
}

const SURFACE: Record<MapTheme, string> = { light: "#ffffff", dark: "#1d2025" };

/**
 * Event marker: colored disc with a white category icon. Unverified reports
 * use a hollow, dashed ring so uncertainty is visible without relying on hue.
 */
export function createMarkerImage(
  group: MarkerGroup,
  category: EventCategory,
  theme: MapTheme,
  pixelRatio: number,
): RasterImage | null {
  const size = 34;
  const ctx = canvas(size, pixelRatio);
  if (!ctx) return null;
  const { color, hollow } = MARKER_GROUPS[group];
  const c = size / 2;

  ctx.shadowColor = "rgba(0,0,0,0.25)";
  ctx.shadowBlur = 3;
  ctx.shadowOffsetY = 1;
  ctx.beginPath();
  ctx.arc(c, c, 13.5, 0, Math.PI * 2);
  ctx.fillStyle = hollow ? SURFACE[theme] : color;
  ctx.fill();
  ctx.shadowColor = "transparent";

  ctx.lineWidth = hollow ? 2.5 : 2;
  ctx.strokeStyle = hollow ? color : SURFACE[theme];
  if (hollow) ctx.setLineDash([4, 3]);
  ctx.stroke();
  ctx.setLineDash([]);

  drawIcon(ctx, CATEGORY_DISPLAY[category].icon, c, c, 16, hollow ? color : "#ffffff");
  return toRaster(ctx);
}

/** Cluster bubble with a count; a red ring means it contains a confirmed urgent disruption. */
export function createClusterImage(urgent: boolean, label: string, theme: MapTheme, pixelRatio: number): RasterImage | null {
  const radius = label.length >= 3 ? 21 : label.length === 2 ? 18 : 16;
  const size = radius * 2 + 8;
  const ctx = canvas(size, pixelRatio);
  if (!ctx) return null;
  const c = size / 2;

  ctx.beginPath();
  ctx.arc(c, c, radius, 0, Math.PI * 2);
  ctx.fillStyle = theme === "dark" ? "#e8eaee" : "#1f2937";
  ctx.fill();
  ctx.lineWidth = urgent ? 3.5 : 2;
  ctx.strokeStyle = urgent ? MARKER_GROUPS.urgent.color : SURFACE[theme];
  ctx.stroke();

  ctx.fillStyle = theme === "dark" ? "#111318" : "#ffffff";
  ctx.font = `600 ${label.length >= 3 ? 12 : 13}px system-ui, -apple-system, "Segoe UI", sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(label, c, c + 0.5);
  return toRaster(ctx);
}

/** Parse ids produced by markerImageId / clusterImageId; returns null for anything else. */
export function parseImageId(
  id: string,
):
  | { kind: "marker"; group: MarkerGroup; category: EventCategory; theme: MapTheme }
  | { kind: "cluster"; urgent: boolean; label: string; theme: MapTheme }
  | null {
  const parts = id.split(":");
  const theme = parts[3];
  if (theme !== "light" && theme !== "dark") return null;
  if (parts[0] === "vm" && parts[1] && parts[2] && parts[1] in MARKER_GROUPS && parts[2] in CATEGORY_DISPLAY) {
    return { kind: "marker", group: parts[1] as MarkerGroup, category: parts[2] as EventCategory, theme };
  }
  if (parts[0] === "vc" && (parts[1] === "0" || parts[1] === "1") && parts[2] && /^(\d{1,2}|99\+)$/.test(parts[2])) {
    return { kind: "cluster", urgent: parts[1] === "1", label: parts[2], theme };
  }
  return null;
}
