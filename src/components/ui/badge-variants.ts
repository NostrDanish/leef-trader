import { cva } from "class-variance-authority"

export const badgeVariants = cva(
  "inline-flex w-fit shrink-0 items-center justify-center gap-1 overflow-hidden rounded-full border border-transparent px-2 py-0.5 text-xs font-medium whitespace-nowrap transition-[color,box-shadow] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 [&>svg]:pointer-events-none [&>svg]:size-3",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground [a&]:hover:bg-primary/90",
        secondary:
          "bg-secondary text-secondary-foreground [a&]:hover:bg-secondary/90",
        destructive:
          "bg-destructive text-white focus-visible:ring-destructive/20 dark:bg-destructive/60 dark:focus-visible:ring-destructive/40 [a&]:hover:bg-destructive/90",
        outline:
          "border-border text-foreground [a&]:hover:bg-accent [a&]:hover:text-accent-foreground",
        ghost: "[a&]:hover:bg-accent [a&]:hover:text-accent-foreground",
        link: "text-primary underline-offset-4 [a&]:hover:underline",
        plain: "border-border bg-surface-2 text-muted-foreground",
        accent: "border-accent/30 bg-accent/10 text-accent",
        leef: "border-leef/30 bg-leef/10 text-leef",
        wax: "border-wax/30 bg-wax/10 text-wax",
        buy: "border-buy/30 bg-buy/10 text-buy",
        sell: "border-sell/30 bg-sell/10 text-sell",
        warn: "border-warn/30 bg-warn/10 text-warn",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)
