"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS: { href: string; label: string; icon: React.ReactNode }[] = [
  {
    href: "/practice",
    label: "Practice",
    icon: (
      <path d="M4 20l4-1L19.5 7.5a2.1 2.1 0 00-3-3L5 16l-1 4zM13 6l4 4" />
    ),
  },
  {
    href: "/study",
    label: "Flashcards",
    icon: (
      <path d="M4 7a2 2 0 012-2h9a2 2 0 012 2v10a2 2 0 01-2 2H6a2 2 0 01-2-2V7zm5 12l8.5.9a2 2 0 002.2-1.8l1-9.3" />
    ),
  },
  {
    href: "/dictation",
    label: "Dictation",
    icon: (
      <path d="M4 13a8 8 0 0116 0M4 13v4a2 2 0 002 2h1v-6H6a2 2 0 00-2 2zm16 0v4a2 2 0 01-2 2h-1v-6h1a2 2 0 012 2z" />
    ),
  },
  {
    href: "/dictionary",
    label: "Dictionary",
    icon: (
      <path d="M5 19.5V5a2 2 0 012-2h12v16H7a2 2 0 00-2 2zm0 0A2.5 2.5 0 007.5 22H19M9 7h6M9 11h4" />
    ),
  },
  {
    href: "/translate",
    label: "Translate",
    icon: (
      <path d="M3 5h9M7.5 3v2c0 4-2 7-4.5 9m3-5c1 2.5 3 4.5 5.5 5.5M13 21l4.5-10L22 21m-7.5-3h6" />
    ),
  },
  {
    href: "/review",
    label: "Review",
    icon: <path d="M4 20V10m6 10V4m6 16v-7m4 7H2" />,
  },
  {
    href: "/settings",
    label: "Settings",
    icon: (
      <path d="M12 15a3 3 0 100-6 3 3 0 000 6zm7.4-3a7.4 7.4 0 00-.1-1.2l2-1.6-2-3.4-2.4 1a7.5 7.5 0 00-2-1.2L14.5 3h-5l-.4 2.6a7.5 7.5 0 00-2 1.2l-2.4-1-2 3.4 2 1.6a7.4 7.4 0 000 2.4l-2 1.6 2 3.4 2.4-1a7.5 7.5 0 002 1.2l.4 2.6h5l.4-2.6a7.5 7.5 0 002-1.2l2.4 1 2-3.4-2-1.6c.07-.4.1-.8.1-1.2z" />
    ),
  },
];

export default function Nav() {
  const pathname = usePathname();
  return (
    <nav className="flex items-center gap-0.5">
      {LINKS.map((l) => {
        const active = pathname?.startsWith(l.href);
        return (
          <Link
            key={l.href}
            href={l.href}
            className={
              "flex items-center gap-1.5 rounded-full px-3.5 py-2 text-sm font-medium transition-colors " +
              (active
                ? "bg-[#e8f0fe] text-[#1967d2]"
                : "text-[#5f6368] hover:bg-[#f1f3f4] hover:text-[#202124]")
            }
          >
            <svg
              className="h-[18px] w-[18px]"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              {l.icon}
            </svg>
            <span className="hidden lg:inline">{l.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
