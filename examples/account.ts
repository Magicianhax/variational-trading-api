/**
 * Account state: balance, positions, and the transfer ledger (deposits, withdrawals,
 * realised PnL, funding, fees — the venue's own record of every cash movement).
 *
 *   pnpm example examples/account.ts [path/to/session.json]
 *
 * Needs a session, found in the same order as `pnpm session:check`: the path given,
 * else ./session.json (from the browser extension), else VARIATIONAL_COOKIES (in .env
 * or the environment). See docs/AUTH.md.
 */
import { clientFromEnv, exitWith } from './_env.ts'

const client = clientFromEnv()
const me = await client.getMe()
if (me.token === '') exitWith('The venue did not accept the session (signed out or expired).')

const portfolio = await client.getPortfolio()
console.log('balance', portfolio.balance, '| unrealised', portfolio.upnl)

for (const p of await client.getPositions()) {
  const i = p.position_info
  console.log(
    `  ${i.instrument.underlying.padEnd(6)} qty ${i.qty} @ ${i.avg_entry_price}  mark ${p.price_info.price}`,
  )
}

// Sum the ledger by type. Settled funding for YOUR account lives here — there is no
// market-wide funding history endpoint (docs/API.md).
const totals = new Map<string, number>()
for (let offset = 0; ; offset += 100) {
  const page = await client.getTransfers({ limit: 100, offset, order: 'asc' })
  for (const t of page.rows)
    totals.set(t.transfer_type, (totals.get(t.transfer_type) ?? 0) + Number(t.qty))
  if (page.rows.length < 100) break
}
for (const [type, sum] of totals) console.log(`  ${type.padEnd(14)} ${sum.toFixed(2)}`)
