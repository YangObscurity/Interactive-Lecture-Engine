/**
 * prompts/loadContract.mts - Node loader for engine AI feature contracts under `site/ai-contracts/`.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { isValidAiContract, type AiFeatureContract } from './contracts.ts'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SITE_ROOT = path.resolve(HERE, '../../..')
const CONTRACTS_DIR = path.join(SITE_ROOT, 'ai-contracts')

export function resolveAiContractPath(contractId: string): string {
  const safeId = contractId.replace(/[^a-z0-9-]/gi, '')
  if (!safeId || safeId !== contractId) {
    throw new Error(`Invalid contract id: ${JSON.stringify(contractId)}`)
  }
  return path.join(CONTRACTS_DIR, `${safeId}.json`)
}

export function loadAiContract(contractId = 'concept-draft'): AiFeatureContract {
  const filePath = resolveAiContractPath(contractId)
  if (!fs.existsSync(filePath)) {
    throw new Error(`AI contract not found: ${filePath}`)
  }
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown
  if (!isValidAiContract(raw)) {
    throw new Error(`AI contract is malformed: ${filePath}`)
  }
  return raw
}
