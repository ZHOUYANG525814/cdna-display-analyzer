// shadcn convention: `cn` merges class strings, with later Tailwind utilities
// winning over earlier ones of the same property (tailwind-merge). Used by
// every UI primitive so callers can override styles by passing className.
import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
