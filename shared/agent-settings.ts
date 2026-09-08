export interface AgentModelOption { id: string; label: string; efforts: string[] }
export interface AgentSettingsOptions { models: AgentModelOption[]; efforts: string[] }
export const CODEX_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
export const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
export const supportsAgentSettings = (kind: string) => kind === 'codex' || kind === 'claude';

/** Only model identifiers and known effort values cross the browser/CLI boundary. */
export function checkedAgentSettings(kind: string, params: Record<string, unknown>) {
  const value = (key: string) => {
    if (params[key] == null) return '';
    if (typeof params[key] !== 'string') throw new Error(`${key} must be text`);
    return (params[key] as string).trim();
  };
  const model = value('model'), effort = value('effort');
  if ((model || effort) && !supportsAgentSettings(kind)) throw new Error('Model and effort controls are available for Codex and Claude');
  if (model && !/^[A-Za-z0-9][A-Za-z0-9._:/\[\]-]{0,159}$/.test(model)) throw new Error('Enter a valid model ID');
  if (effort && !(kind === 'codex' ? CODEX_EFFORTS : CLAUDE_EFFORTS).includes(effort)) throw new Error('Unsupported effort level');
  return { model, effort };
}

export function agentLaunchArgs(kind: string, settings: { model: string; effort: string }) {
  const args: string[] = [];
  if (settings.model) args.push('--model', settings.model);
  if (settings.effort) args.push(...(kind === 'codex' ? ['-c', `model_reasoning_effort="${settings.effort}"`] : ['--effort', settings.effort]));
  return args;
}
