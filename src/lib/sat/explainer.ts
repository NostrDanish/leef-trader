/**
 * Public "About / How it works" content (mirror of docs/EXPLAINER.md).
 * Facts checked against WAX mainnet on 23 Oct 2026. No keys or secrets here.
 */
export const LINKS = {
  platform: "https://leef-trader.vercel.app/",
  bot: "https://t.me/LEEF_Trader_Bot",
  community: "https://t.me/leefmaincorp",
  leef: "https://leeftoken.io",
  explainer: "https://github.com/NostrDanish/leef-trader/blob/main/docs/EXPLAINER.md",
} as const;

export type Row = [string, string, string?];
export type Block = { heading: string; intro?: string; rows?: Row[]; bullets?: string[]; note?: string };

export const SAT_ALLOCATION: Row[] = [
  ["35%", "Locked liquidity (SAT/LEEF, SAT/WAX, SAT/stablecoin)", "Over a third in locked depth, so a large sale moves the price less."],
  ["25%", "User rewards, released over 4 years", "Slow release avoids a dump and rewards real use."],
  ["15%", "Treasury (2-of-3 multisig)", "Runway and future pools."],
  ["15%", "Team, 12-month cliff, 36-month vesting", "Team stays at or under 15% and can't sell early."],
  ["10%", "LEEF community airdrop", "Ties SAT to the people who already back LEEF."],
];

export const REVENUE_SPLIT: Row[] = [
  ["30%", "satlp", "Buys SAT and deepens SAT liquidity."],
  ["20%", "leeflp", "Backs LEEF: LEEF/WAX and SAT/LEEF liquidity."],
  ["30%", "ops", "CPU, RAM, hosting. Stars pay out in TON after up to 21 days, so ops needs a buffer."],
  ["10%", "rewards", "SAT bought back for user rewards."],
  ["10%", "reserve", "Stablecoin reserve; with ops about two months of runway at the start."],
];

export const ACCOUNTS: Row[] = [
  ["sattoken1111", "SAT token contract, controlled by smartaadmin1"],
  ["smartatrader", "Trader / treasury contract: plans, subscriptions, revenue split, buybacks, LP + lock"],
  ["smartaadmin1", "Admin 2-of-3 multisig, SAT issuer, holds the 10M airdrop SAT"],
  ["smartafees11", "Fee 2-of-3 multisig, owns the locked SAT/LEEF position and claims its fees"],
  ["smartabot111", "Bot account; its bot key can only call buyback, addlp, collectfees, lpwithdraw, pause"],
  ["leefmaincorp", "LEEF token contract"],
  ["leefstakerio", "LEEF staking (counts ×1.5 in the airdrop)"],
  ["swap.alcor", "Alcor DEX: pools, swaps, LP positions and LP locks"],
  ["wrap.alcor", "Alcor-wrapped USDT used for USDT plans (6 decimals)"],
  ["eosio.token", "WAX system token contract (WAX, 8 decimals)"],
];

export const TXS: Row[] = [
  ["Create smartatrader", "56b9ba783cfcb47b358f4455437bdfaf29b7dd25e198cdb20c08319ead985c17"],
  ["Create sattoken1111 / smartaadmin1 / smartafees11 / smartabot111", "7b6aac8b240972debb8db63ae75d770ddf39b3dbca31a6cf9a0c54087f92f50b"],
  ["Deploy SAT token", "ef26671c7cd6e5989ab40c8423d42dfa6736f160db1b7eca74841cf25f648d33"], // gitleaks:allow (public WAX tx id)
  ["Deploy trader contract", "9a0516217101a0a0beffa7474d9d3ed437898e3d14663b9aa7a97b5f8ba89860"],
  ["Create SAT (100M max)", "aeda753fbcde4e52989f0c522f4aca35a5c77105d98282508a50763664b77fec"],
  ["Low caps (1% / 5%)", "b7c7f23486b5f3e54e424d0cf9e47e56ea8183f5a591bf38f58f5a4d8e5a063c"],
  ["Admin + fee accounts to 2-of-3 multisig", "65ea96feb71aaa83fcf9dbd4c82d3a29f1c84f33b61156dda608a362f0beefdb"],
  ["Contracts handed to the multisig", "4785ab565f5f6070b7d28f770fa969d95f2e49d1d37ab3ec6271cd69d5ce7973"],
  ["Issue 10M SAT for the launch LP", "a673ab3882e37b9267ebb318af31667760b3165668f89e31f6c6908abec87790"],
  ["Create pool 12905 (LEEF/SAT)", "2685d9dbb1c403ef98c4a9f38514bad8ab5b9be1b1c49f76c6a583b81827937b"],
  ["Add liquidity + lock to 2068", "6979fedf610e62a52ff5d47295380bfac3f241612afdc7d0e65f8967ca04776c"],
  ["Issue 10M SAT for the airdrop", "cde3ce9c4ec9c14ac6841871577e0c95ae1ee6bcdecaedc73c88594450d0588d"],
];
export const txUrl = (id: string) => `https://waxblock.io/transaction/${id}`;

export const BLOCKS: Block[] = [
  {
    heading: "What the platform and the bot do",
    bullets: [
      "leef-trader (this app, also a Telegram Mini App): live Alcor prices and pools, swap quotes, LP tools, IL calculator, portfolio, login with your own WAX wallet (keys never touch the app) and the SAT treasury tab read straight from chain.",
      "@LEEF_Trader_Bot: prices, your plan (/plan) and the exact transfer to sign for a subscription (/subscribe). It never signs for you and never takes trade or config orders from chat.",
    ],
    note: "Honest status: the public bot is not live for auto-trading yet. It runs in paper mode until launch, so a paid plan today only creates an on-chain subscription record.",
  },
  {
    heading: "Trading engine",
    bullets: [
      "Arbitrage between Alcor pools (2-pool routes on Basic, up to 3-pool on Pro); a route must end with more of the starting token.",
      "Grid levels on LEEF and stablecoin pairs (Pro, still being ported to the public bot).",
      "Simulate first: every trade is simulated on live pool state before signing.",
      "Min-out on every swap; same-token loops need at least input + 1 unit, so a losing trade is rejected by the chain.",
      "10% drawdown stop: automation pauses; only the admin multisig can unpause.",
      "No wash trading and no trades between our own wallets.",
    ],
  },
  {
    heading: "Plans and tiers",
    rows: [
      ["Plan 1 / 11 · Basic · 30 days", "213 WAX / 0.975 USDT (≈ 75 Stars)"],
      ["Plan 2 / 12 · Pro · 30 days", "427 WAX / 1.95 USDT (≈ 150 Stars)"],
      ["Plan 3 / 13 · Pro · 365 days", "4,269 WAX / 19.5 USDT (≈ 1,500 Stars)"],
      ["Free", "Prices, info and paper mode. Everyone falls back to Free if the chain can't be read."],
      ["Basic", "Auto-trading on your own WAX account with a trade-only key, 2-pool arbitrage, up to 50 WAX per trade, hourly Telegram report. Stars subscription = Basic."],
      ["Pro", "Basic + 3-pool routes, up to 150 WAX per trade, up to 60 trades an hour, reserved worker slots. Grid and Jev screening planned, not in the public bot yet."],
    ],
    note: "Pay the plan price to smartatrader with memo sub:<plan_id> from your own wallet. A 20% discount for paying in SAT is planned, not live.",
  },
  {
    heading: "Locked liquidity",
    rows: [
      ["Pool", "Alcor 12905, LEEF / SAT, 0.3% fee"],
      ["Position", "153128, full range, owned by smartafees11 (2-of-3 multisig)"],
      ["Seeded with", "1,063,887,425.3611 LEEF + 9,999,999.9762 SAT (start ≈ 106.39 LEEF per SAT)"],
      ["Lock", "Alcor native lockpos, unlocks 22 Oct 2068 (~42 years)"],
      ["Fees", "Still claimable while locked, by the fee multisig"],
    ],
  },
  {
    heading: "Community airdrop: 10,000,000 SAT",
    bullets: [
      "Already issued and held by smartaadmin1. Nothing has been sent yet.",
      "30% (3M) to Founder NFT holders: collection leeftokennft, template 654718 \"LEEF Founders Token\". Split mode (held NFTs only vs per NFT of the template): TBD.",
      "70% (7M) by LEEF weight: wallet ×1, staked on leefstakerio ×1.5, LEEF side of Alcor LP ×1.5 (committed LEEF counts more).",
      "Minimum weight 100,000 LEEF. Cap 5% (500,000 SAT) per account; the excess is shared out to everyone else.",
      "Excluded by category: SAT system accounts, LEEF project contracts, DEX / pool / burn / drop accounts, accounts with deployed code. Team trading wallets are included under the same rules and cap.",
      "Snapshot at an unannounced time. Sent once @LEEF_Trader_Bot and this platform are live with SAT.",
      "Memo: SAT LEEF community airdrop - leef-trader.vercel.app & t.me/LEEF_Trader_Bot",
    ],
  },
  {
    heading: "Contract limits and status",
    bullets: [
      "The bot can move at most 1% of a bucket per action and 5% per day.",
      "smartatrader has no action that removes or transfers liquidity; fees only go to smartafees11.",
      "Tokens, swaps, pools and payout destinations are whitelisted; our trading wallets are deny-listed as bot or payout target.",
      "Not audited yet: deployed with low caps, raised only after an independent audit. No absolute (fixed amount) cap yet.",
    ],
  },
];
