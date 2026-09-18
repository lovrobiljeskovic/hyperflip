import { LandingHeader } from "../landing-header";
import { SiteFooter } from "../site-footer";

export default function LegalLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-full flex-col">
      <LandingHeader />
      <main className="mx-auto w-full max-w-3xl px-4 py-12 leading-relaxed sm:px-6 sm:py-20 [&_h1]:display [&_h1]:text-5xl [&_h2]:mt-10 [&_h2]:text-xl [&_h2]:font-semibold [&_p]:mt-4 [&_p]:text-dim [&_ul]:mt-4 [&_ul]:list-disc [&_ul]:space-y-2 [&_ul]:pl-5 [&_ul]:text-dim [&_a]:text-accent [&_a]:underline [&_a]:underline-offset-4 [&_code]:mono [&_code]:text-fg">
        {children}
      </main>
      <SiteFooter />
    </div>
  );
}
