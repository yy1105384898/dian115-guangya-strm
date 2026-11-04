import { getRules } from './rules.js'
import { receiveSourceChange } from './source-monitor.js'
export async function run(ctx, input = {}) {
  return receiveSourceChange(ctx, input, getRules(await ctx.settings.get()))
}
