/** Route rates in USD per million tokens. Snapshot: official DeepSeek pricing, 2026-10-04.
 * Peak rates reserve safely across peak/off-peak boundaries. Unknown routes are explicitly estimates.
 * BIMAX_MODEL_PRICING_JSON supplies exact provider:model rates for BYOK/custom deployments.
 */
export interface TokenRates { input: number; output: number; cachedInput?: number; basis?: string }
export function ratesFor(provider: string | null, model: string, env: NodeJS.ProcessEnv = process.env): TokenRates {
  if (env.BIMAX_MODEL_PRICING_JSON) {
    const configured = JSON.parse(env.BIMAX_MODEL_PRICING_JSON)[`${provider}:${model}`];
    if (configured) {
      if (![configured.input, configured.output, configured.cachedInput ?? configured.input].every(n => Number.isFinite(n) && n >= 0)) throw new Error('Invalid model pricing configuration.');
      return { ...configured, basis: 'configured' };
    }
  }
  if (provider === 'deepseek') {
    if (['deepseek-flash', 'deepseek-v4-flash', 'deepseek-v4-flash-vision-exp'].includes(model)) return { input: 0.3, output: 1.2, cachedInput: 0.006, basis: 'documented peak estimate' };
    if (model === 'deepseek-v4-pro') return { input: 1.32, output: 3.96, cachedInput: 0.044, basis: 'documented peak estimate' };
  }
  if (['ollama', 'vllm', 'lmstudio', 'llamacpp'].includes(provider || '')) return { input: 0, output: 0, basis: 'local inference' };
  return { input: 2, output: 2, basis: 'unpriced route estimate; configure BIMAX_MODEL_PRICING_JSON' };
}
export function tokenCost(rates: TokenRates, input: number, output: number, cachedInput = 0): number {
  const clean = (n: number) => Number.isFinite(n) && n >= 0 ? n : 0;
  const i = clean(input), o = clean(output), cached = Math.min(i, clean(cachedInput));
  return ((i - cached) * rates.input + cached * (rates.cachedInput ?? rates.input) + o * rates.output) / 1_000_000;
}
