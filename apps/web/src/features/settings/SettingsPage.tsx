import { EVENT_STATUSES } from "@verity/contracts";
import { LogIn, LogOut, Monitor, Moon, Sun } from "lucide";
import { useState } from "react";
import { useNavigate } from "react-router";
import { useApi } from "../../api/ApiProvider";
import { Card, PageLayout } from "../../app/PageLayout";
import { Button } from "../../components/ui/Button";
import { Icon } from "../../components/ui/Icon";
import { SegmentedControl } from "../../components/ui/SegmentedControl";
import { StatusBadge } from "../../components/ui/StatusBadge";
import { STATUS_DISPLAY } from "../../lib/display";
import { readStored, STORAGE_KEYS, writeStored } from "../../lib/storage";
import { useMaypop } from "../../maypop/MaypopProvider";
import { useAuth } from "../auth/AuthProvider";
import { useTheme, type ThemePreference } from "../../theme/ThemeProvider";

interface NotificationPrefs {
  verified: boolean;
  conflicting: boolean;
  resolved: boolean;
  majorUpdates: boolean;
}

const DEFAULT_PREFS: NotificationPrefs = { verified: true, conflicting: true, resolved: true, majorUpdates: true };

const parsePrefs = (raw: unknown): NotificationPrefs | null => {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  return {
    verified: r.verified !== false,
    conflicting: r.conflicting !== false,
    resolved: r.resolved !== false,
    majorUpdates: r.majorUpdates !== false,
  };
};

const PREF_LABELS: { key: keyof NotificationPrefs; label: string; hint: string }[] = [
  { key: "verified", label: "Becomes verified", hint: "Developing → Verified" },
  { key: "conflicting", label: "Sources start to conflict", hint: "Verified → Conflicting" },
  { key: "resolved", label: "It's over", hint: "Verified → Resolved" },
  { key: "majorUpdates", label: "Major impact changes", hint: "e.g. more lanes closed" },
];

function SectionTitle({ id, children }: { id: string; children: string }) {
  return (
    <h2 id={id} className="text-base font-semibold">
      {children}
    </h2>
  );
}

export function SettingsPage() {
  const { preference, setPreference } = useTheme();
  const maypop = useMaypop();
  const auth = useAuth();
  const api = useApi();
  const navigate = useNavigate();
  const [prefs, setPrefs] = useState<NotificationPrefs>(() => readStored(STORAGE_KEYS.notificationPrefs, parsePrefs, DEFAULT_PREFS));

  const updatePref = (key: keyof NotificationPrefs, value: boolean) => {
    const next = { ...prefs, [key]: value };
    setPrefs(next);
    writeStored(STORAGE_KEYS.notificationPrefs, next);
  };

  return (
    <PageLayout title="Settings">
      <div className="space-y-4">
        <Card>
          <section aria-labelledby="appearance-heading">
            <SectionTitle id="appearance-heading">Appearance</SectionTitle>
            <p className="mt-1 text-sm text-muted">
              System follows {maypop.status === "connected" ? "Maypop's theme" : "your device"}. Your choice is saved on this device.
            </p>
            <SegmentedControl<ThemePreference>
              label="Theme"
              className="mt-3"
              value={preference}
              onChange={setPreference}
              options={[
                { value: "system", label: "System", icon: Monitor },
                { value: "light", label: "Light", icon: Sun },
                { value: "dark", label: "Dark", icon: Moon },
              ]}
            />
          </section>
        </Card>

        <Card>
          <section aria-labelledby="account-heading" id="account">
            <SectionTitle id="account-heading">Account</SectionTitle>

            <h3 className="mt-3 text-sm font-semibold">Verity account</h3>
            {!auth.available ? (
              <p className="mt-1 text-sm text-muted">This demo doesn't use accounts.</p>
            ) : auth.session ? (
              <div className="mt-1 flex flex-wrap items-center justify-between gap-2 text-sm">
                <p>
                  Signed in as <span className="font-medium">{auth.session.user.email_masked}</span>
                </p>
                <Button variant="secondary" size="sm" onClick={() => void auth.signOut()}>
                  <Icon icon={LogOut} size={16} />
                  Sign out
                </Button>
              </div>
            ) : (
              <div className="mt-1 flex flex-wrap items-center justify-between gap-2 text-sm">
                <p className="text-muted">Not signed in. Browsing never needs an account.</p>
                <Button variant="secondary" size="sm" onClick={() => void auth.requestSignIn()}>
                  <Icon icon={LogIn} size={16} />
                  Sign in
                </Button>
              </div>
            )}
            <p className="mt-1 text-xs text-muted">
              Needed only to report, answer or follow. Verity signs you in with a one-time code sent to your email.
            </p>

            <h3 className="mt-4 text-sm font-semibold">Maypop profile</h3>
            {maypop.status === "connected" && maypop.viewer && !maypop.viewer.isAnonymous ? (
              <p className="mt-1 text-sm">
                Shown as <span className="font-medium">{maypop.viewer.username}</span>.
              </p>
            ) : maypop.status === "connected" ? (
              <div className="mt-1 text-sm">
                <p>You're viewing as a guest.</p>
                {maypop.signInRequired && (
                  <Button variant="secondary" size="sm" className="mt-2" onClick={maypop.signIn}>
                    <Icon icon={LogIn} size={16} />
                    Sign in to Maypop
                  </Button>
                )}
              </div>
            ) : (
              <p className="mt-1 text-sm text-muted">Not running inside Maypop.</p>
            )}
            <p className="mt-1 text-xs text-muted">
              Your Maypop name is shown for display only. Maypop gives apps a private, app-specific identity that Verity's
              service can't verify, so it's never used to sign you in or to record anything, and it isn't linked to your
              Verity account.
            </p>
          </section>
        </Card>

        <Card>
          <section aria-labelledby="notifications-heading">
            <SectionTitle id="notifications-heading">Notifications</SectionTitle>
            <p className="mt-1 text-sm text-muted">
              Verity only alerts you to meaningful changes on events you follow, never every new source.
            </p>
            <ul className="mt-3 divide-y divide-line">
              {PREF_LABELS.map(({ key, label, hint }) => (
                <li key={key} className="flex items-center justify-between gap-3 py-2.5">
                  <label htmlFor={`pref-${key}`} className="text-sm">
                    {label}
                    <span className="block text-xs text-muted">{hint}</span>
                  </label>
                  <input
                    id={`pref-${key}`}
                    type="checkbox"
                    role="switch"
                    checked={prefs[key]}
                    onChange={(e) => updatePref(key, e.target.checked)}
                    className="h-5 w-5 accent-[var(--app-accent)]"
                  />
                </li>
              ))}
            </ul>
            <p className="mt-2 rounded-xl bg-surface-2 px-3 py-2 text-xs text-muted">
              Delivery isn't connected yet. These preferences are saved on this device and will apply once the Verity service sends
              alerts.
            </p>
          </section>
        </Card>

        <Card>
          <section aria-labelledby="privacy-heading">
            <SectionTitle id="privacy-heading">Privacy</SectionTitle>
            <ul className="mt-2 list-disc space-y-1.5 pl-5 text-sm">
              <li>Location is optional. Verity asks only when you tap "Near me" or "Use my location".</li>
              <li>Your location is used on this device to center the map. It is rounded, never stored and never sent to Verity.</li>
              <li>Verity loads events for the map area you're viewing, not for your exact position.</li>
              <li>Reports use the approximate pin you choose, rounded to about 10 meters.</li>
              <li>Community answers are shown only as counts. Verity never shows who answered or where they were.</li>
              <li>This device stores only your theme, followed events and these preferences.</li>
            </ul>
          </section>
        </Card>

        <Card>
          <section aria-labelledby="states-heading">
            <SectionTitle id="states-heading">What the statuses mean</SectionTitle>
            <p className="mt-1 text-sm text-muted">
              Statuses describe the current evidence. Verity doesn't use confidence percentages and doesn't claim to prove what's true.
            </p>
            <dl className="mt-3 space-y-2.5">
              {EVENT_STATUSES.map((s) => (
                <div key={s} className="flex flex-col gap-1 sm:flex-row sm:items-baseline sm:gap-3">
                  <dt className="w-32 shrink-0">
                    <StatusBadge status={s} />
                  </dt>
                  <dd className="text-sm">{STATUS_DISPLAY[s].description}</dd>
                </div>
              ))}
            </dl>
          </section>
        </Card>

        <Card>
          <section aria-labelledby="data-heading">
            <SectionTitle id="data-heading">Data source</SectionTitle>
            <p className="mt-1 text-sm">{api.sourceLabel}</p>
            <p className="mt-1 text-xs text-muted">
              Map data © OpenStreetMap contributors. Basemap tiles are loaded only for the area on screen.
            </p>
            <Button
              variant="ghost"
              size="sm"
              className="mt-3 -ml-2"
              onClick={() => {
                writeStored(STORAGE_KEYS.onboarded, false);
                navigate("/welcome");
              }}
            >
              Show the welcome screen again
            </Button>
          </section>
        </Card>
      </div>
    </PageLayout>
  );
}
