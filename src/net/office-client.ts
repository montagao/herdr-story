import type { ServerMsg } from '../../shared/types';

export type OutputUpdate = Extract<ServerMsg, { type: 'output' }>;
export interface InteractionTiming { name: string; durationMs: number; at: number; outcome: 'ok' | 'error' }
export interface CallOptions { signal?: AbortSignal; timeoutMs?: number; onProgress?: (stage: 'creating' | 'starting' | 'ready') => void }

/**
 * What the office asks of its data source. The live bridge speaks it over a socket; the demo
 * answers from a snapshot. Everything above the network layer types against this.
 */
export interface OfficeClient {
  readonly connected: boolean;
  readonly outputStreaming: boolean;
  on(listener: (msg: ServerMsg) => void): () => void;
  call(method: string, params?: Record<string, unknown>, options?: CallOptions): Promise<unknown>;
  watchOutput(target: string, callback: (update: OutputUpdate) => void): () => void;
  outputFresh(target: string): boolean;
  uploadImage(image: Blob): Promise<string>;
  performanceSnapshot(): InteractionTiming[];
}
