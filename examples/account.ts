/**
 * Account state: balance, positions, and the transfer ledger (deposits, withdrawals,
 * realised PnL, funding, fees — the venue's own record of every cash movement).
 *
 *   npm run example examples/account.ts
 *
 * Needs a session: ./session.json from examples/login.ts, or VARIATIONAL_COOKIES copied
 * from a logged-in browser (docs/AUTH.md).
 */
import { existsSync, readFileSync } from 'node:fs'
import { curlTransport, OmniClient, type SessionBundle } from '../dist/index.js'
import { loadEnv } from './_env.ts'

loadEnv()
const session: SessionBundle | undefined = existsSync('session.json')
  ? (JSON.parse(readFileSync('session.json', 'utf8')) as SessionBundle)
  : undefined
const cookies = session?.cookies ?? process.env['VARIATIONAL_COOKIES']
if (!cookies) throw new Error('no session: run examples/login.ts or set VARIATIONAL_COOKIES')

const client = new OmniClient({ fetchImpl: curlTransport, cookies })
const me = await client.getMe()
if (me.token === '') throw new Error('session rejected or expired — log in again')

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
