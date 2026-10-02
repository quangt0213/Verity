import { Bookmark, LogIn, Monitor, Moon, Plus, Search, Settings, Sun, X } from "lucide";
import { forwardRef, useEffect, useRef, useState } from "react";
import { Link, NavLink } from "react-router";
import { useApi } from "../api/ApiProvider";
import { Button } from "../components/ui/Button";
import { Icon } from "../components/ui/Icon";
import { LIMITS } from "@verity/contracts";
import { cn } from "../lib/cn";
import { useMaypop } from "../maypop/MaypopProvider";
import { useTheme, type ThemePreference } from "../theme/ThemeProvider";

export function Logo() {
  return (
    <Link to="/map" className="inline-flex h-11 items-center gap-2 rounded-xl pr-2 font-semibold tracking-tight" aria-label="Verity home">
      <span className="grid h-8 w-8 place-items-center rounded-xl bg-accent text-accent-fg">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M5 12.5l4.2 4.2L19 7" />
        </svg>
      </span>
      <span className="text-[17px]">Verity</span>
    </Link>
  );
}

const THEME_ORDER: ThemePreference[] = ["system", "light", "dark"];
const THEME_META: Record<ThemePreference, { label: string; icon: typeof Sun }> = {
  system: { label: "System", icon: Monitor },
  light: { label: "Light", icon: Sun },
  dark: { label: "Dark", icon: Moon },
};

export function ThemeToggle() {
  const { preference, setPreference } = useTheme();
  const next = THEME_ORDER[(THEME_ORDER.indexOf(preference) + 1) % THEME_ORDER.length]!;
  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={() => setPreference(next)}
      aria-label={`Theme: ${THEME_META[preference].label}. Switch to ${THEME_META[next].label}.`}
      title={`Theme: ${THEME_META[preference].label}`}
    >
      <Icon icon={THEME_META[preference].icon} size={19} />
    </Button>
  );
}

function IdentityChip() {
  const maypop = useMaypop();
  if (maypop.status !== "connected") return null;
  if (maypop.signInRequired) {
    return (
      <Button variant="secondary" size="sm" onClick={maypop.signIn}>
        <Icon icon={LogIn} size={16} />
        Sign in
      </Button>
    );
  }
  const viewer = maypop.viewer;
  if (!viewer || viewer.isAnonymous) return null;
  return (
    <Link
      to="/settings#account"
      className="inline-flex h-11 items-center gap-2 rounded-xl px-1.5 hover:bg-surface-2"
      title={`Signed in to Maypop as ${viewer.username}`}
    >
      {viewer.avatarUrl ? (
        <img src={viewer.avatarUrl} alt="" className="h-8 w-8 rounded-full object-cover" referrerPolicy="no-referrer" />
      ) : (
        <span className="grid h-8 w-8 place-items-center rounded-full bg-surface-2 text-sm font-semibold" aria-hidden>
          {viewer.username.slice(0, 1).toUpperCase()}
        </span>
      )}
      <span className="sr-only lg:not-sr-only lg:max-w-[10rem] lg:truncate lg:text-sm lg:font-medium">{viewer.username}</span>
    </Link>
  );
}

function NavIconLink({ to, label, icon }: { to: string; label: string; icon: typeof Sun }) {
  return (
    <NavLink
      to={to}
      className={({ isActive }) =>
        cn(
          "inline-flex h-11 min-w-11 items-center justify-center gap-2 rounded-xl px-2.5 text-sm font-medium hover:bg-surface-2",
          isActive ? "text-fg" : "text-muted",
        )
      }
      aria-label={label}
    >
      <Icon icon={icon} size={19} />
      <span className="hidden lg:inline">{label}</span>
    </NavLink>
  );
}

export const SearchField = forwardRef<HTMLInputElement, { value: string; onChange: (v: string) => void }>(function SearchField(
  { value, onChange },
  ref,
) {
  return (
    <div className="relative w-full">
      <Icon icon={Search} size={17} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-muted" />
      <input
        ref={ref}
        type="search"
        value={value}
        maxLength={LIMITS.searchQueryMax}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Search this area"
        aria-label="Search events in this area"
        className="h-11 w-full rounded-xl bg-surface-2 pr-3 pl-10 text-sm placeholder:text-muted focus:bg-surface focus:ring-2 focus:ring-accent focus:outline-none"
      />
    </div>
  );
});

export function TopBar({ search }: { search?: { value: string; onChange: (v: string) => void } }) {
  const [mobileSearch, setMobileSearch] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  // Move focus into the field the user just opened.
  useEffect(() => {
    if (mobileSearch) searchRef.current?.focus();
  }, [mobileSearch]);
  return (
    <header className="relative z-30 shrink-0 border-b border-line bg-surface" style={{ paddingTop: "env(safe-area-inset-top, 0px)" }}>
      <div className="flex h-14 items-center gap-2 px-3 lg:h-16 lg:px-4">
        {mobileSearch && search ? (
          <>
            <SearchField ref={searchRef} value={search.value} onChange={search.onChange} />
            <Button variant="ghost" size="icon" onClick={() => setMobileSearch(false)} aria-label="Close search">
              <Icon icon={X} size={19} />
            </Button>
          </>
        ) : (
          <>
            <Logo />
            {search && (
              <div className="mx-4 hidden max-w-md flex-1 lg:block">
                <SearchField value={search.value} onChange={search.onChange} />
              </div>
            )}
            <div className="ml-auto flex items-center gap-0.5">
              {search && (
                <Button variant="ghost" size="icon" className="lg:hidden" onClick={() => setMobileSearch(true)} aria-label="Search events">
                  <Icon icon={Search} size={19} />
                </Button>
              )}
              <NavIconLink to="/following" label="Following" icon={Bookmark} />
              <NavIconLink to="/settings" label="Settings" icon={Settings} />
              <div className="hidden lg:block">
                <ThemeToggle />
              </div>
              <Link
                to="/report"
                className="ml-1 hidden h-11 items-center gap-1.5 rounded-xl bg-accent px-4 text-sm font-medium text-accent-fg shadow-sm hover:brightness-110 lg:inline-flex"
              >
                <Icon icon={Plus} size={17} />
                Report
              </Link>
              <IdentityChip />
            </div>
          </>
        )}
      </div>
    </header>
  );
}

export function DataSourceBanner() {
  const api = useApi();
  if (api.mode === "mock") {
    return (
      <div className="shrink-0 bg-amber-50 px-4 py-1.5 text-center text-xs font-medium text-amber-900 dark:bg-amber-400/10 dark:text-amber-200" role="note">
        Demo data: sample events for previewing Verity. These are not real current events.
      </div>
    );
  }
  if (api.mode === "unconfigured") {
    return (
      <div className="shrink-0 bg-zinc-100 px-4 py-1.5 text-center text-xs font-medium text-zinc-800 dark:bg-zinc-400/10 dark:text-zinc-200" role="note">
        Not connected to a Verity service, so no events can be shown.
      </div>
    );
  }
  return null;
}
