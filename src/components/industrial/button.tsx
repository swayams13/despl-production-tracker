import type { ButtonHTMLAttributes } from "react";
import Link from "next/link";

/**
 * Canonical Button (DESIGN_SYSTEM.md §2). Three variants only — Primary
 * (accent fill, the one action per screen that matters), Secondary (the
 * default — `.btn` alone already matches this spec byte-for-byte, see
 * globals.css's INDUSTRIAL THEME block), Ghost (toolbar icons). Wraps the
 * `.btn`/`.btn-accent`/`.btn-ghost`/`.btn-outline-accent` classes already
 * shipped and pixel-reviewed — this is a typed entry point, not new CSS.
 *
 * `destructive` maps to the critical-red confirm button DESIGN_SYSTEM.md §16
 * calls for on Reject/destructive dialogs — no such CSS class existed before
 * this pass, so it's the one genuinely new visual variant here.
 */
type ButtonVariant = "primary" | "secondary" | "ghost" | "outline-accent" | "destructive";

const VARIANT_CLASS: Record<ButtonVariant, string> = {
  primary: "btn btn-accent",
  secondary: "btn",
  ghost: "btn btn-ghost",
  "outline-accent": "btn btn-outline-accent",
  destructive: "btn btn-destructive",
};

interface ButtonOwnProps {
  variant?: ButtonVariant;
  /** Renders as a Next Link instead of a <button> — same class, real navigation. */
  href?: string;
}

export function Button({
  variant = "secondary",
  href,
  className,
  children,
  ...rest
}: ButtonOwnProps & ButtonHTMLAttributes<HTMLButtonElement> & { className?: string }) {
  const cls = className ? `${VARIANT_CLASS[variant]} ${className}` : VARIANT_CLASS[variant];
  if (href) {
    return (
      <Link href={href} className={cls}>
        {children}
      </Link>
    );
  }
  return (
    <button type="button" className={cls} {...rest}>
      {children}
    </button>
  );
}
