# LEEF Trader, @LEEF_Trader_Bot and SAT: how it all works

Last checked against WAX mainnet: 23 Oct 2026. Every number below was read from the chain or from the
repos ([leef-trader](https://github.com/NostrDanish/leef-trader), leef-trader-tg). Anything not decided yet is marked **TBD**.

- Platform: https://leef-trader.vercel.app/
- Telegram bot: [t.me/LEEF_Trader_Bot](https://t.me/LEEF_Trader_Bot)
- Official LEEF community: [t.me/leefmaincorp](https://t.me/leefmaincorp)
- LEEF project: https://leeftoken.io

> SAT and the trader contracts are a sub-system next to the LEEF contracts on WAX. They only *use* LEEF through
> normal token transfers and never hold permissions on `leefmaincorp` or `leefstakerio`.

## 1. What the platform and the bot do

**leef-trader platform** (web app, also opens as a Telegram Mini App): a trading terminal for WAX. Live prices and
pools from Alcor, swap quotes, LP tools, an impermanent-loss calculator, a portfolio view, a wallet login through your
own WAX wallet (Cloud Wallet / Anchor; keys never touch the app), and the **SAT treasury** tab, which reads the SAT
contracts straight from chain. The only thing you can sign there is your own subscription payment.

**@LEEF_Trader_Bot** (Telegram): shows prices, your plan (`/plan`) and the exact transfer to sign for a subscription
(`/subscribe`). The bot never signs anything for you and never takes trade or config orders from chat.
**Honest status: the public bot is not live for auto-trading yet.** It runs in paper mode until launch, so a paid
plan today only creates an on-chain subscription record.

## 2. The trading engine (high level)

- **Arbitrage:** looks for price gaps between Alcor pools (2-pool routes on Basic, up to 3-pool routes on Pro) and
  only trades a route that ends with more of the starting token.
- **Grid:** places buy/sell levels around a price on LEEF and stablecoin pairs (Pro feature, still being ported to the public bot).
- **Safety rules, always on:**
  - **Simulate first.** Every trade is simulated against live pool state before it is signed.
  - **Min-out.** Each swap sets a minimum output; for loops back to the same token it must be at least input + 1 unit,
    so a trade that would lose is rejected by the chain.
  - **10% drawdown stop.** If a wallet or the treasury drops 10% from its start value, automation stops
    (on the contract it calls `pause`, and only the admin multisig can unpause).
  - **No wash trading** and no trades between our own wallets.
  - Per-trade and per-hour caps per tier (see section 5).

## 3. SAT token

| | |
|---|---|
| Token contract | `sattoken1111` (eosio.token-compatible) |
| Symbol / decimals | SAT, 4 |
| Max supply | **100,000,000 SAT**, fixed, no inflation |
| Current supply | **20,000,000 SAT** (10M in the SAT/LEEF launch LP, 10M reserved for the community airdrop) |
| Issuer | `smartaadmin1` (2-of-3 multisig) |

### Allocation (35 / 25 / 15 / 15 / 10) and why

| Share | Use | Why |
|---|---|---|
| 35% (35M) | Locked liquidity (SAT/LEEF, SAT/WAX, SAT/stablecoin) | Over a third in locked depth, so a large sale moves the price less. |
| 25% (25M) | User rewards, released over 4 years | Slow release avoids a dump and rewards real use. |
| 15% (15M) | Treasury (multisig) | Runway and future pools, controlled by 2-of-3 signers. |
| 15% (15M) | Team, 12-month cliff, 36-month vesting | Team stays at or under 15% and can't sell early. |
| 10% (10M) | LEEF community airdrop | Ties SAT to the people who already back LEEF. |

Only the 10M launch LP and the 10M airdrop are issued so far. The rest is issued later by the multisig.

## 4. Revenue split (30 / 20 / 30 / 10 / 10) and why

Subscription payments to `smartatrader` are split on-chain the moment they arrive:

| Bucket | Share | Why |
|---|---|---|
| `satlp` | 30% | Buys SAT and deepens SAT liquidity. |
| `leeflp` | 20% | Backs LEEF: LEEF/WAX and SAT/LEEF liquidity. |
| `ops` | 30% | CPU, RAM, hosting. Stars pay out in TON after up to 21 days, so ops needs a buffer. |
| `rewards` | 10% | SAT bought back for user rewards. |
| `reserve` | 10% | Stablecoin reserve. With ops this is about two months of runway at the start. |

Half of all revenue goes back into liquidity. There is no profit share paid to holders.

## 5. Plans and tiers

| Plan id | Price | Days | Tier |
|---|---|---|---|
| 1 / 11 | 213 WAX / 0.975 USDT (≈ 75 Telegram Stars) | 30 | Basic |
| 2 / 12 | 427 WAX / 1.95 USDT (≈ 150 Stars) | 30 | Pro |
| 3 / 13 | 4,269 WAX / 19.5 USDT (≈ 1,500 Stars) | 365 | Pro |

Stars price is based on $0.013 per Star; WAX prices were set at WAX = $0.004568 (23 Oct 2026) and can be updated by the multisig.
USDT is `wrap.alcor` USDT (6 decimals). WAX is `eosio.token` WAX. Pro yearly = 10 months' price for 12.

| Tier | What it unlocks |
|---|---|
| **Free** | Prices, info and paper mode. No auto-trading. Everyone falls back to Free if the chain can't be read. |
| **Basic** | Auto-trading on your own WAX account with a limited trade-only key, 2-pool arbitrage, up to 50 WAX per trade, hourly Telegram report. A Stars subscription = Basic. |
| **Pro** | Everything in Basic, 3-pool routes, up to 150 WAX per trade, up to 60 trades an hour, reserved worker slots. Grid and Jev screening are planned for Pro and not in the public bot yet. |

To subscribe you send the plan price to `smartatrader` with memo `sub:<plan_id>` (or `sub:<plan_id>:<account>`) from your own wallet.
A **20% discount for paying in SAT** is planned but **not live** (needs SAT-priced plans set by the multisig).

## 6. Locked liquidity

| | |
|---|---|
| Pool | Alcor **12905**, LEEF / SAT, 0.3% fee |
| Position | **153128**, full range, owned by `smartafees11` (2-of-3 multisig) |
| Seeded with | 1,063,887,425.3611 LEEF + 9,999,999.9762 SAT (start price ≈ 106.39 LEEF per SAT) |
| Lock | Alcor native `lockpos`, unlock **22 Oct 2068** (~42 years) |
| Fees | Still claimable while locked (Alcor `collect`), by the fee multisig |

Locked liquidity can't be removed or transferred until 2068. Check it yourself: `swap.alcor` table `locks`, scope `12905`, row `pos_id 153128`.
A tiny mainnet test lock also exists in pool 12405 (WAX/USDT), made by the `smartatrader` contract to prove the lock path works.

## 7. Community airdrop: 10,000,000 SAT

The 10M SAT is already issued and held by `smartaadmin1`. **Nothing has been sent yet.**

- **30% (3M SAT) to Founder NFT holders:** collection `leeftokennft`, template `654718` "LEEF Founders Token".
  Whether this is split over held NFTs only or reserved per NFT across the whole template is **TBD**.
- **70% (7M SAT) by LEEF weight:**
  - LEEF in your wallet counts **×1**.
  - LEEF staked on `leefstakerio` counts **×1.5**.
  - The LEEF side of your Alcor LP positions counts **×1.5**.
  - Staked and LP LEEF count more because that LEEF is committed and supports the ecosystem.
  - Minimum weight **100,000 LEEF**, so we don't send thousands of dust transfers.
- **Cap: 5% (500,000 SAT) per account.** Anything above the cap is shared out to everyone else, so no single whale takes the drop.
- **Exclusions by category:** SAT system accounts, LEEF project contracts, DEX / pool / burn / drop accounts, and accounts with
  deployed contract code. The team's trading wallets are **included** under the same rules and cap.
- **Snapshot:** taken at an unannounced time, so nobody can buy in just for the drop.
- **When:** once @LEEF_Trader_Bot and the leef-trader platform are live with SAT.
- **Memo:** `SAT LEEF community airdrop - leef-trader.vercel.app & t.me/LEEF_Trader_Bot`
- Not counted yet: Taco and other DEX LP tokens.

## 8. Accounts and contracts

| Account | Role |
|---|---|
| `sattoken1111` | SAT token contract. Controlled by `smartaadmin1`. |
| `smartatrader` | Trader / treasury contract: plans, subscriptions, revenue split, buybacks, LP + lock. Controlled by `smartaadmin1`. |
| `smartaadmin1` | Admin, 2-of-3 multisig. SAT issuer. Holds the 10M airdrop SAT. |
| `smartafees11` | Fee recipient, 2-of-3 multisig. Owns the locked SAT/LEEF position and claims its fees. |
| `smartabot111` | Bot account. Its bot key can only call `buyback`, `addlp`, `collectfees`, `lpwithdraw`, `pause` on `smartatrader`. |
| `leefmaincorp` | LEEF token contract (max 420B, supply 132B LEEF). |
| `leefstakerio` | LEEF staking (counted in the airdrop at ×1.5). |
| `swap.alcor` | Alcor DEX: pools, swaps, LP positions and LP locks. |
| `wrap.alcor` | Alcor-wrapped USDT used for USDT plans (6 decimals). |
| `eosio.token` | WAX system token contract (WAX, 8 decimals). |

## 9. Contract limits and status

- The bot can move at most **1% of a bucket per action** and **5% per day**.
- `smartatrader` has no action that removes or transfers liquidity. Fees only go to `smartafees11`.
- Tokens, swaps, pools and payout destinations are whitelisted. Our trading wallets are deny-listed as bot or payout target.
- **Not audited yet.** Deployed with low caps; caps are only raised after an independent audit. There is no absolute (fixed amount) cap yet.

## 10. On-chain proof (waxblock.io)

| Step | Transaction |
|---|---|
| Create `smartatrader` | [56b9ba78…](https://waxblock.io/transaction/56b9ba783cfcb47b358f4455437bdfaf29b7dd25e198cdb20c08319ead985c17) |
| Create `sattoken1111`, `smartaadmin1`, `smartafees11`, `smartabot111` | [7b6aac8b…](https://waxblock.io/transaction/7b6aac8b240972debb8db63ae75d770ddf39b3dbca31a6cf9a0c54087f92f50b) |
| Deploy SAT token | [ef26671c…](https://waxblock.io/transaction/ef26671c7cd6e5989ab40c8423d42dfa6736f160db1b7eca74841cf25f648d33) |
| Deploy trader contract | [9a051621…](https://waxblock.io/transaction/9a0516217101a0a0beffa7474d9d3ed437898e3d14663b9aa7a97b5f8ba89860) |
| Create SAT (100M max) | [aeda753f…](https://waxblock.io/transaction/aeda753fbcde4e52989f0c522f4aca35a5c77105d98282508a50763664b77fec) |
| Low caps (1% / 5%) | [b7c7f234…](https://waxblock.io/transaction/b7c7f23486b5f3e54e424d0cf9e47e56ea8183f5a591bf38f58f5a4d8e5a063c) |
| Admin + fee accounts to 2-of-3 multisig | [65ea96fe…](https://waxblock.io/transaction/65ea96feb71aaa83fcf9dbd4c82d3a29f1c84f33b61156dda608a362f0beefdb) |
| Contracts handed to the multisig | [4785ab56…](https://waxblock.io/transaction/4785ab565f5f6070b7d28f770fa969d95f2e49d1d37ab3ec6271cd69d5ce7973) |
| Issue 10M SAT for the launch LP | [a673ab38…](https://waxblock.io/transaction/a673ab3882e37b9267ebb318af31667760b3165668f89e31f6c6908abec87790) |
| Create pool 12905 (LEEF/SAT) | [2685d9db…](https://waxblock.io/transaction/2685d9dbb1c403ef98c4a9f38514bad8ab5b9be1b1c49f76c6a583b81827937b) |
| Add liquidity + lock to 2068 | [6979fedf…](https://waxblock.io/transaction/6979fedf610e62a52ff5d47295380bfac3f241612afdc7d0e65f8967ca04776c) |
| Issue 10M SAT for the airdrop | [cde3ce9c…](https://waxblock.io/transaction/cde3ce9c4ec9c14ac6841871577e0c95ae1ee6bcdecaedc73c88594450d0588d) |

Not financial advice. SAT is a utility token for paying and using the trader; it is not a share of profits.
