/**
 * `@batak-dev/recording-sdk/presets` — built-in backend presets.
 *
 * The recording-service preset is the default backend contract, separated from the engine
 * core. Pass it to `defineRecordingConfig`. A fully decoupled app can instead define its own
 * preset (operations + stores + endpoints + transport) and skip this entry entirely.
 */
export * from './presets/recordingService';
