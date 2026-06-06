/**
 * Resilience measurement module.
 * Captures a per-recording event log + computed summary and exports it as JSON.
 */

export { ResilienceCollector, loadPersistedReport, listPersistedLogs } from './ResilienceCollector';
export { downloadJSON } from './download';
export {
  computeSummary,
  RRS_WEIGHTS,
  MAX_ACCEPTABLE_SWITCH_FREQUENCY,
  MAX_ACCEPTABLE_RECOVERY_S
} from './metrics';
export * from './types';
