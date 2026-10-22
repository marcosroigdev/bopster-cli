import { usdc } from '../amounts.js'
import { loadPlan, validatePlan } from '../plan.js'

/** `validate <plan.json>...`: the local checks only (shape, dates, caps). No network, no key. */
export async function validate(config, planPaths, { log }) {
  for (const path of planPaths) {
    const { mcpArgs, stakes } = validatePlan(loadPlan(path).raw, config)
    log(`✓ ${path}: ${mcpArgs.title}, ${mcpArgs.template.type}, closes ${mcpArgs.end_time}, YES ${usdc(stakes.YES)}, NO ${usdc(stakes.NO)}`)
  }
}
