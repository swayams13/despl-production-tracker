import type { NextConfig } from "next";

// ponytail: script-src/style-src keep 'unsafe-inline' — Next's App Router
// hydration payload is an inline <script> with per-request content (can't be
// hashed) and ~40 components use inline style={{}} (Radix/sonner included;
// can't be hashed either, style attributes don't support nonces). Tightening
// script-src needs a per-request nonce wired through middleware — a bigger
// change than this item's scope. Report-Only for now so nothing breaks if
// something here was missed; flip to enforced (`Content-Security-Policy`)
// once prod headers are confirmed clean.
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join("; ");

const nextConfig: NextConfig = {
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Content-Security-Policy-Report-Only", value: CSP },
        ],
      },
    ];
  },
};

export default nextConfig;
