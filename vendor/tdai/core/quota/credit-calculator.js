/**
 * CreditCalculator — 基于 token 用量和模型系数计算 Credit 消耗
 *
 * 规则 (锚点: MiniMax M2.7):
 * - Input:  1.0 Credit / 1k tokens
 * - Cache:  0.2 Credit / 1k tokens
 * - Output: 4.0 Credit / 1k tokens
 * - 模型系数: M2.7=1.0, 旗舰型=15.0, 极速型=0.8
 */
/** 模型系数表 (可通过配置扩展) */
const DEFAULT_MODEL_MULTIPLIERS = {
    "minimax-m2.7": 1.0,
    "MiniMax-M1": 1.0,
    // 旗舰型
    "gpt-4o": 15.0,
    "gpt-5": 15.0,
    "claude-4.5-sonnet": 15.0,
    // 极速型
    "deepseek-v3.2": 0.8,
    "deepseek-v3": 0.8,
};
const DEFAULT_RATES = {
    inputRate: 1.0,
    cacheRate: 0.2,
    outputRate: 4.0,
};
export class CreditCalculator {
    rates;
    modelMultipliers;
    defaultMultiplier;
    constructor(opts) {
        this.rates = { ...DEFAULT_RATES, ...opts?.rates };
        this.modelMultipliers = { ...DEFAULT_MODEL_MULTIPLIERS, ...opts?.modelMultipliers };
        this.defaultMultiplier = opts?.defaultMultiplier ?? 1.0;
    }
    /**
     * 计算单次 LLM 调用的 Credit 消耗
     * @returns 消耗的 Credit 数 (原始浮点数，与监控侧保持严格一致)
     */
    calculate(usage, model) {
        const multiplier = this.modelMultipliers[model] ?? this.defaultMultiplier;
        const inputCredits = (usage.inputTokens / 1000) * this.rates.inputRate;
        const cacheCredits = ((usage.cacheTokens ?? 0) / 1000) * this.rates.cacheRate;
        const outputCredits = (usage.outputTokens / 1000) * this.rates.outputRate;
        const total = (inputCredits + cacheCredits + outputCredits) * multiplier;
        return total;
    }
    /** 获取模型系数 */
    getMultiplier(model) {
        return this.modelMultipliers[model] ?? this.defaultMultiplier;
    }
}
