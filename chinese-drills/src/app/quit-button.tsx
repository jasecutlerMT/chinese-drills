"use client";

import { useState } from "react";

export default function QuitButton() {
  const [confirming, setConfirming] = useState(false);
  const [off, setOff] = useState(false);

  const quit = async () => {
    try {
      await fetch("/api/quit", { method: "POST" });
    } catch {
      // The server may die before the response arrives — that's success.
    }
    setOff(true);
  };

  if (off) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#f8f9fa]">
        <div className="g-card g-enter max-w-sm p-10 text-center">
          <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-[#f1f3f4]">
            <PowerIcon className="h-7 w-7 text-[#5f6368]" />
          </div>
          <p className="text-lg font-medium text-[#202124]">The app is off</p>
          <p className="mt-2 text-sm text-[#5f6368]">
            You can close this tab. To start again, double-click{" "}
            <span className="font-medium">Chinese Drills</span> on your Desktop.
          </p>
        </div>
      </div>
    );
  }

  if (confirming) {
    return (
      <div className="flex items-center gap-2">
        <span className="text-sm text-[#5f6368]">Turn off?</span>
        <button
          onClick={quit}
          className="rounded-full bg-[#d93025] px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-[#b3261e]"
        >
          Yes, quit
        </button>
        <button onClick={() => setConfirming(false)} className="g-btn-text">
          Cancel
        </button>
      </div>
    );
  }

  return (
    <button
      onClick={() => setConfirming(true)}
      title="Quit the app"
      aria-label="Quit the app"
      className="flex h-10 w-10 items-center justify-center rounded-full text-[#d93025] transition-colors hover:bg-[#fce8e6]"
    >
      <PowerIcon className="h-6 w-6" />
    </button>
  );
}

function PowerIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
      <path d="M12 3v8" />
      <path d="M6.3 6.5a8 8 0 1011.4 0" />
    </svg>
  );
}
