/**
 * Account state: balance, positions, and the transfer ledger (deposits, withdrawals,
 * realised PnL, funding, fees — the venue's own record of every cash movement).
 *
 *   pnpm example examples/account.ts
 *
 * Needs a session: VARIATIONAL_COOKIES (a Cookie header or session JSON, in .env or the
 * environment), else ./session.json from the browser extension. See docs/AUTH.md.
 */
import { OmniClient } from '../dist/index.js'
import { loadEnv } from './_env.ts'

loadEnv()
// `||`, not `??`: an empty VARIATIONAL_COOKIES= line in .env should fall through too.
const client = OmniClient.fromSession(process.env['VARIATIONAL_COOKIES'] || 'session.json')
const me = await client.getMe()
if (me.token === '') throw new Error('session rejected or expired: export a fresh one')

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
