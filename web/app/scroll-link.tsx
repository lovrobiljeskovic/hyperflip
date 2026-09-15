"use client";

import type { ReactNode } from "react";

/** In-page section link that scrolls without ever putting "#section" in the URL. */
export function ScrollLink({ to, className, children, onClick }: { to: string; className?: string; children: ReactNode; onClick?: () => void }) {
  return (
    <a
      href="/"
      className={className}
      onClick={(e) => {
        e.preventDefault();
        onClick?.();
        document.getElementById(to)?.scrollIntoView({ behavior: "smooth" });
      }}
    >
      {children}
    </a>
  );
}
