import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { STATUS } from "@/lib/contracts";
import { formatUsdc, multiplier } from "@/lib/format";
import { appCanonical } from "@/lib/site";
import { loadSlip } from "@/lib/slip";
import { ShareOnX } from "../share-on-x";
import { SlipCard } from "../slip-card";

export const revalidate = 60;

const STAMP: Record<number, string> = { [STATUS.Open]: "Minted", [STATUS.Won]: "Won", [STATUS.Dead]: "Lost", [STATUS.Void]: "Void" };

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const slip = await loadSlip((await params).id);
  if (!slip) return { title: "Slip not found" };
  const line = `${formatUsdc(slip.premium)} USDC to win ${formatUsdc(slip.maxPayout)} USDC (${multiplier(slip.premium, slip.maxPayout)})`;
  return {
    title: `Slip #${slip.id}`,
    description: `${slip.legs.length}-leg slip on Hyperflip. ${line}.`,
    alternates: { canonical: appCanonical(`/slip/${slip.id}`) },
  };
}

export default async function SlipPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const slip = await loadSlip(id);
  if (!slip) notFound();
  const url = appCanonical(`/slip/${slip.id}`);
  return (
    <main className="mx-auto w-[min(100%-2rem,400px)] py-12 sm:py-16">
      <SlipCard
        legs={slip.legs}
        premium={slip.premium}
        maxPayout={slip.maxPayout}
        id={slip.id}
        stamp={STAMP[slip.status] ?? "Minted"}
        footer={
          <div className="grid grid-cols-2 gap-2">
            <ShareOnX legs={slip.legs} premium={slip.premium} maxPayout={slip.maxPayout} url={url} />
            <Link
              href="/build"
              className="mono flex items-center justify-center rounded-[8px] border border-line py-[13px] text-[12px] uppercase tracking-[0.1em] text-fg transition-colors hover:border-dim"
            >
              Build your own
            </Link>
          </div>
        }
      />
    </main>
  );
}
