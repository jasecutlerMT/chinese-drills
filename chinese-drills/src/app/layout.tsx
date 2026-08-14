import type { Metadata } from "next";
import Link from "next/link";
import Nav from "./nav";
import QuitButton from "./quit-button";
import "./globals.css";

export const metadata: Metadata = {
  title: "汉字 Drills",
  description: "Written Mandarin production drills with a persistent error log",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="sticky top-0 z-10 border-b border-[#dadce0] bg-white/85 backdrop-blur-md">
          <div className="mx-auto flex h-16 max-w-5xl items-center justify-between px-6">
            <Link href="/practice" className="flex items-center gap-3">
              <span
                className="zh flex h-9 w-9 items-center justify-center rounded-xl text-lg font-semibold text-white shadow-sm"
                style={{ background: "linear-gradient(135deg, #1a73e8 0%, #6c3fe4 100%)" }}
              >
                汉
              </span>
              <span className="text-lg text-[#5f6368]">
                <span className="font-medium text-[#202124]">Drills</span>
              </span>
            </Link>
            <div className="flex items-center gap-3">
              <Nav />
              <div className="h-6 w-px bg-[#dadce0]" />
              <QuitButton />
            </div>
          </div>
        </header>
        <main className="mx-auto max-w-5xl px-6 py-10">{children}</main>
      </body>
    </html>
  );
}
