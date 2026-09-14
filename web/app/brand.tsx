import { ViewTransition } from "react";
import Link from "next/link";

export function HyperflipLogo({ className = "" }: { className?: string }) {
  return <img src="/brand/logo-clean.svg" alt="" className={className} />;
}

export function HyperflipBrand({ shared = false, href = "/" }: { shared?: boolean; href?: string }) {
  const mark = <HyperflipLogo className="size-8" />;
  return (
    <Link href={href} prefetch={false} className="flex shrink-0 items-center gap-2.5" aria-label="Hyperflip home">
      {shared ? (
        <ViewTransition name="hyperflip-mark" share="hyperflip-mark" default="none">
          {mark}
        </ViewTransition>
      ) : (
        mark
      )}
      <span className="display text-[19px] tracking-[-0.045em]">hyperflip</span>
    </Link>
  );
}
