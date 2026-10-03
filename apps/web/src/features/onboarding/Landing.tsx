import { Clock, LocateFixed, ShieldCheck, Users } from "lucide";
import { useState } from "react";
import { useNavigate } from "react-router";
import { Logo } from "../../app/TopBar";
import { Button } from "../../components/ui/Button";
import { Icon } from "../../components/ui/Icon";
import { StatusBadge } from "../../components/ui/StatusBadge";
import { useToast } from "../../components/ui/Toast";
import { locateOnce } from "../../lib/hooks";
import { STORAGE_KEYS, writeStored } from "../../lib/storage";

const POINTS = [
  {
    icon: ShieldCheck,
    title: "Evidence, not guesses",
    body: "Every event shows its sources, and Verity never claims more certainty than they support.",
  },
  {
    icon: Clock,
    title: "Always says when it was checked",
    body: "Events show when Verity last checked them, not just when they were posted.",
  },
  {
    icon: Users,
    title: "Neighbors keep it current",
    body: "People nearby confirm what's still happening and flag what's over.",
  },
];

export function Landing() {
  const navigate = useNavigate();
  const toast = useToast();
  const [locating, setLocating] = useState(false);

  const finish = () => writeStored(STORAGE_KEYS.onboarded, true);

  const exploreNearby = async () => {
    setLocating(true);
    const result = await locateOnce();
    setLocating(false);
    finish();
    if (!result.ok) toast.show(result.message, "info");
    navigate("/map", { state: result.ok ? { center: result.coordinates } : null });
  };

  return (
    <main className="min-h-full overflow-y-auto bg-bg">
      <div className="mx-auto flex min-h-full max-w-xl flex-col px-5 pt-6 pb-10" style={{ paddingTop: "calc(env(safe-area-inset-top, 0px) + 1.5rem)" }}>
        <Logo />
        <div className="mt-10 sm:mt-16">
          <h1 className="text-3xl leading-tight font-semibold tracking-tight sm:text-4xl">Know what's actually happening around you.</h1>
          <p className="mt-3 text-base text-muted">
            Road closures, emergencies, transit problems and local events, each with the evidence behind it.
          </p>
          <div className="mt-5 flex flex-wrap gap-2" aria-label="Example statuses">
            <StatusBadge status="VERIFIED" size="md" />
            <StatusBadge status="DEVELOPING" size="md" />
            <StatusBadge status="CONFLICTING" size="md" />
            <StatusBadge status="RESOLVED" size="md" />
          </div>
        </div>

        <ul className="mt-8 space-y-4">
          {POINTS.map((p) => (
            <li key={p.title} className="flex gap-3">
              <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-surface text-accent ring-1 ring-line">
                <Icon icon={p.icon} size={18} />
              </span>
              <div>
                <p className="font-semibold">{p.title}</p>
                <p className="text-sm text-muted">{p.body}</p>
              </div>
            </li>
          ))}
        </ul>

        <div className="mt-auto pt-10">
          <Button size="lg" className="w-full" onClick={exploreNearby} disabled={locating}>
            <Icon icon={LocateFixed} size={18} />
            {locating ? "Finding your area…" : "Explore nearby"}
          </Button>
          <Button
            variant="ghost"
            size="lg"
            className="mt-2 w-full"
            onClick={() => {
              finish();
              navigate("/map");
            }}
          >
            Browse the map without location
          </Button>
          <p className="mt-3 text-center text-xs text-muted">
            Location is optional. It's only used on your device to center the map, and it's never stored.
          </p>
        </div>
      </div>
    </main>
  );
}
