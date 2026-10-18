import { ChevronLeft } from "lucide";
import type { ReactNode } from "react";
import { Link } from "react-router";
import { Icon } from "../components/ui/Icon";
import { DataSourceBanner, TopBar } from "./TopBar";

export function PageLayout({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <div className="flex h-full flex-col">
      <TopBar />
      <DataSourceBanner />
      <main className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-2xl px-4 pt-4 pb-16">
          <Link to="/map" className="-ml-2 inline-flex h-10 items-center gap-1 rounded-xl px-2 text-sm font-medium text-muted hover:bg-surface-2 hover:text-fg">
            <Icon icon={ChevronLeft} size={18} />
            Map
          </Link>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">{title}</h1>
          {description && <p className="mt-1 text-sm text-muted">{description}</p>}
          <div className="mt-6">{children}</div>
        </div>
      </main>
    </div>
  );
}

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <section className={`rounded-2xl bg-surface p-4 ring-1 ring-line sm:p-5 ${className}`}>{children}</section>;
}
