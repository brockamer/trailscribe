import { Config } from '../config/env';

/**
 * Ledger for cost tracking. Maintains counts of requests and token
 * usage within the current cycle (monthly). Calculates costs using
 * rates provided via environment variables. In production this
 * should persist data in a database or key/value store.
 */
export class Ledger {
  private requests = 0;
  private inputTokens = 0;
  private outputTokens = 0;
  private cycleStart: Date;
  private config: Config;

  constructor(config: Config) {
    this.config = config;
    this.cycleStart = this.getCycleStart();
  }

  /**
   * Record a new request and token counts.
   */
  record(opts: { inputTokens: number; outputTokens: number }): void {
    this.ensureCycle();
    this.requests += 1;
    this.inputTokens += opts.inputTokens;
    this.outputTokens += opts.outputTokens;
  }

  /**
   * Get a human readable summary string.
   */
  getSummary(): string {
    this.ensureCycle();
    const totalTokens = this.inputTokens + this.outputTokens;
    const cost = this.getCycleCost();
    const startDateStr = this.cycleStart.toISOString().slice(0, 10);
    return `${this.requests} requests • ${totalTokens.toLocaleString()} tok • $${cost.toFixed(2)} (since ${startDateStr})`;
  }

  /**
   * Get current cycle cost in dollars.
   */
  getCycleCost(): number {
    this.ensureCycle();
    const inputRate = parseFloat(this.config.OPENAI_INPUT_COST_PER_1K ?? '0');
    const outputRate = parseFloat(this.config.OPENAI_OUTPUT_COST_PER_1K ?? '0');
    const inputCost = (this.inputTokens / 1000) * inputRate;
    const outputCost = (this.outputTokens / 1000) * outputRate;
    return inputCost + outputCost;
  }

  /**
   * Reset counts when a new cycle (month) begins.
   */
  private ensureCycle(): void {
    const now = new Date();
    const currentCycle = this.getCycleStart();
    if (currentCycle.getTime() !== this.cycleStart.getTime()) {
      this.requests = 0;
      this.inputTokens = 0;
      this.outputTokens = 0;
      this.cycleStart = currentCycle;
    }
  }

  /**
   * Determine the start date of the current cycle (first day of month).
   */
  private getCycleStart(): Date {
    const now = new Date();
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  }
}