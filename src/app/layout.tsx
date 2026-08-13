import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "DESPL Production Tracker",
  description:
    "Production tracking from PO to dispatch for Dhruv EPC Solutions Pvt. Ltd.",
};

export const viewport: Viewport = {
  // Supervisors use this one-handed on the shop floor; let them zoom.
  initialScale: 1,
  width: "device-width",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}
