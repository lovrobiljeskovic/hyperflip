import type { Metadata } from "next";
import { accessReturnPath } from "@/lib/access";
import { AccessForm } from "./access-form";

export const metadata: Metadata = { title: "Beta access", robots: { index: false, follow: false } };

export default async function Page({ searchParams }: { searchParams: Promise<{ next?: string; error?: string }> }) {
  const params = await searchParams;
  return <AccessForm nextPath={accessReturnPath(params.next)} unavailable={params.error === "unavailable"} />;
}
