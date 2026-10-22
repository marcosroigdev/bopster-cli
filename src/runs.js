import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'

/**
 * What a `create` has done so far, saved after every step, so a run that stops halfway picks up
 * where it was instead of asking a second question or staking twice. One file per plan.
 */
export function runPathFor(config, planPath) {
  return join(config.runsDir, `${basename(planPath, '.json')}.json`)
}

export function loadRun(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

export function saveRun(path, run) {
  mkdirSync(join(path, '..'), { recursive: true })
  const tmp = `${path}.tmp`
  writeFileSync(tmp, `${JSON.stringify(run, null, 2)}\n`)
  renameSync(tmp, path)
}
