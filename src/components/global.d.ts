/**
 * Keep @types/node globals in the program. TypeScript auto-includes @types
 * packages lazily — previously @types/node rode in via @types/qrcode's
 * dependency (pulled by the now-deleted unused ui/qrcode.tsx). Without an
 * explicit reference, the node-importing lib tests (csp, ai-boundary,
 * telegram miniapp, test/setup) lose their globals and tsc fails.
 */
/// <reference types="node" />
