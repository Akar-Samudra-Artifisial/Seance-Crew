// Stand-ins for @kirocrew/app-sdk/ui in tests: plain elements with the same props.
import type { ReactNode } from "react";

export function PageHeader({ title, subtitle }: { title: string; subtitle?: string; children?: ReactNode }) {
  return (
    <header>
      <h1>{title}</h1>
      {subtitle === undefined ? null : <p>{subtitle}</p>}
    </header>
  );
}

export function Card({ children }: { children?: ReactNode; className?: string }) {
  return <section>{children}</section>;
}

export function CardTitle({ children }: { children?: ReactNode; className?: string }) {
  return <h3>{children}</h3>;
}

export function StatCard({ label, value }: { label: string; value: ReactNode; accent?: boolean }) {
  return (
    <div>
      <span>{label}</span>: <span>{value}</span>
    </div>
  );
}
