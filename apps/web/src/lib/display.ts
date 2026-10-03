import {
  CATEGORY_KIND,
  type EventCategory,
  type EventStatus,
  type SourceClass,
} from "@verity/contracts";
import {
  Activity,
  Ban,
  Car,
  CircleAlert,
  CircleCheck,
  CircleCheckBig,
  CircleDot,
  CircleHelp,
  CircleParking,
  Construction,
  Flag,
  Flame,
  GraduationCap,
  Hourglass,
  Megaphone,
  Music,
  PartyPopper,
  Siren,
  Split,
  TrafficCone,
  TrainFront,
  Trophy,
  Waves,
  ZapOff,
  type IconNode,
} from "lucide";

// ---------------------------------------------------------------------------
// Statuses: language describes evidence, never certainty or probability.
// ---------------------------------------------------------------------------

export interface StatusDisplay {
  label: string;
  description: string;
  icon: IconNode;
  /** Tailwind classes for the badge (light + dark). */
  badgeClass: string;
}

export const STATUS_DISPLAY: Record<EventStatus, StatusDisplay> = {
  UNVERIFIED: {
    label: "Unverified",
    description: "Needs confirmation. Not yet supported by independent evidence.",
    icon: CircleHelp,
    badgeClass: "bg-slate-100 text-slate-700 ring-slate-500/25 dark:bg-slate-400/10 dark:text-slate-300 dark:ring-slate-400/30",
  },
  DEVELOPING: {
    label: "Developing",
    description: "Some supporting evidence. The picture is still developing.",
    icon: Activity,
    badgeClass: "bg-orange-50 text-orange-800 ring-orange-600/25 dark:bg-orange-400/10 dark:text-orange-300 dark:ring-orange-400/30",
  },
  LIKELY: {
    label: "Likely",
    description: "Supported by independent sources, awaiting stronger confirmation.",
    icon: CircleDot,
    badgeClass: "bg-amber-50 text-amber-800 ring-amber-600/25 dark:bg-amber-400/10 dark:text-amber-300 dark:ring-amber-400/30",
  },
  VERIFIED: {
    label: "Verified",
    description: "Verified by current evidence.",
    icon: CircleCheck,
    badgeClass: "bg-emerald-50 text-emerald-800 ring-emerald-600/25 dark:bg-emerald-400/10 dark:text-emerald-300 dark:ring-emerald-400/30",
  },
  CONFLICTING: {
    label: "Conflicting",
    description: "Conflicting reports. Sources currently disagree.",
    icon: Split,
    badgeClass: "bg-violet-50 text-violet-800 ring-violet-600/25 dark:bg-violet-400/10 dark:text-violet-300 dark:ring-violet-400/30",
  },
  STALE: {
    label: "Stale",
    description: "Evidence is out of date and needs re-checking.",
    icon: Hourglass,
    badgeClass: "bg-zinc-100 text-zinc-700 ring-zinc-500/25 dark:bg-zinc-400/10 dark:text-zinc-300 dark:ring-zinc-400/30",
  },
  RESOLVED: {
    label: "Resolved",
    description: "Sources indicate this has ended.",
    icon: CircleCheckBig,
    badgeClass: "bg-zinc-100 text-zinc-700 ring-zinc-500/25 dark:bg-zinc-400/10 dark:text-zinc-300 dark:ring-zinc-400/30",
  },
  REJECTED: {
    label: "Not supported",
    description: "Sources did not support this report.",
    icon: Ban,
    badgeClass: "bg-zinc-100 text-zinc-600 ring-zinc-500/25 dark:bg-zinc-400/10 dark:text-zinc-400 dark:ring-zinc-400/30",
  },
};

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

export interface CategoryDisplay {
  label: string;
  icon: IconNode;
}

export const CATEGORY_DISPLAY: Record<EventCategory, CategoryDisplay> = {
  road_closure: { label: "Road closure", icon: TrafficCone },
  crash: { label: "Crash", icon: Car },
  flooding: { label: "Flooding", icon: Waves },
  fire: { label: "Fire", icon: Flame },
  police_activity: { label: "Police activity", icon: Siren },
  transit_disruption: { label: "Transit disruption", icon: TrainFront },
  construction: { label: "Construction", icon: Construction },
  power_outage: { label: "Power outage", icon: ZapOff },
  protest: { label: "Protest", icon: Megaphone },
  parade: { label: "Parade", icon: Flag },
  concert: { label: "Concert", icon: Music },
  sporting_event: { label: "Sporting event", icon: Trophy },
  festival: { label: "Festival", icon: PartyPopper },
  campus_event: { label: "Campus event", icon: GraduationCap },
  parking_traffic: { label: "Parking & traffic", icon: CircleParking },
  other: { label: "Other", icon: CircleAlert },
};

// ---------------------------------------------------------------------------
// Map marker groups: a few meaningful colors, always paired with an icon and
// text status elsewhere, never color alone.
// ---------------------------------------------------------------------------

export type MarkerGroup = "urgent" | "developing" | "unverified" | "planned" | "inactive";

export function markerGroup(event: { status: EventStatus; category: EventCategory }): MarkerGroup {
  const { status, category } = event;
  if (status === "STALE" || status === "RESOLVED" || status === "REJECTED") return "inactive";
  if (status === "UNVERIFIED") return "unverified";
  if (CATEGORY_KIND[category] === "planned") return "planned";
  if (status === "VERIFIED" || status === "LIKELY") return "urgent";
  return "developing";
}

export const MARKER_GROUPS: Record<MarkerGroup, { label: string; color: string; hollow: boolean }> = {
  urgent: { label: "Confirmed disruption", color: "#dc2626", hollow: false },
  developing: { label: "Developing disruption", color: "#ea6a0c", hollow: false },
  unverified: { label: "Unverified report", color: "#ea6a0c", hollow: true },
  planned: { label: "Planned event", color: "#6d4ed8", hollow: false },
  inactive: { label: "Stale or ended", color: "#858c96", hollow: false },
};

// ---------------------------------------------------------------------------
// Source classes
// ---------------------------------------------------------------------------

export const SOURCE_CLASS_LABEL: Record<SourceClass, string> = {
  OFFICIAL: "Official",
  FIRST_PARTY: "First-party",
  REPUTABLE_NEWS: "News",
  LOCAL_NEWS: "Local news",
  COMMUNITY: "Community",
  SOCIAL: "Social",
  UNKNOWN: "Unknown source",
};
