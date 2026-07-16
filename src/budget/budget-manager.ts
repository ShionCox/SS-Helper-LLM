import { logger } from '../runtime/logger';
import { validateBudgetConfigs } from '../validation/settings';

/**
 * 预算与熔断器 —— 控制每个 consumer 的调用频率和成本
 */

export interface BudgetConfig {
    maxRPM?: number;       // 每分钟最大请求数
    maxTokens?: number;    // 单次最大 token
    maxLatencyMs?: number; // 最大延迟容忍
}

interface ConsumerState {
    requestTimestamps: number[];  // 最近请求时间戳（用于限流）
    consecutiveFailures: number;  // 连续失败计数
    circuitOpenUntil: number;     // 熔断器打开至该时间
}

/**
 * 预算与熔断管理
 */
export class BudgetManager {
    private configs: Map<string, BudgetConfig> = new Map();
    private states: Map<string, ConsumerState> = new Map();

    // 熔断阈值
    private readonly CIRCUIT_FAILURE_THRESHOLD = 5;
    private readonly CIRCUIT_OPEN_DURATION_MS = 60_000; // 1 分钟

    /**
     * 为指定 consumer 设置预算
     */
    setConfig(consumer: string, config: BudgetConfig): void {
        this.configs.set(consumer, Object.freeze({ ...validateBudgetConfigs({ [consumer]: config })[consumer] }));
    }

    /**
     * 删除指定 consumer 的预算配置
     */
    removeConfig(consumer: string): void {
        this.configs.delete(consumer);
    }

    replaceConfigs(configs: Record<string, BudgetConfig> = {}): void {
        const validated = validateBudgetConfigs(configs);
        this.configs.clear();
        for (const [consumer, config] of Object.entries(validated)) this.configs.set(consumer, Object.freeze({ ...config }));
    }

    resetCircuit(consumer?: string): void {
        if (consumer) this.states.delete(consumer);
        else this.states.clear();
    }

    getCircuitState(consumer: string): { consecutiveFailures: number; openUntil: number } {
        const state = this.getState(consumer);
        return { consecutiveFailures: state.consecutiveFailures, openUntil: state.circuitOpenUntil };
    }

    /**
     * 取得或初始化 consumer 状态
     */
    private getState(consumer: string): ConsumerState {
        if (!this.states.has(consumer)) {
            this.states.set(consumer, {
                requestTimestamps: [],
                consecutiveFailures: 0,
                circuitOpenUntil: 0,
            });
        }
        return this.states.get(consumer)!;
    }

    /**
     * 检查是否允许请求（限流 + 熔断）
     */
    canRequest(consumer: string): { allowed: boolean; reason?: string } {
        const state = this.getState(consumer);
        const now = Date.now();

        // 检查熔断器
        if (state.circuitOpenUntil > now) {
            return { allowed: false, reason: `熔断器激活中，将于 ${new Date(state.circuitOpenUntil).toLocaleTimeString()} 恢复` };
        }

        // 检查限流
        const config = this.configs.get(consumer);
        if (config?.maxRPM) {
            const oneMinuteAgo = now - 60_000;
            state.requestTimestamps = state.requestTimestamps.filter(t => t > oneMinuteAgo);
            if (state.requestTimestamps.length >= config.maxRPM) {
                return { allowed: false, reason: `已达到限流上限 (${config.maxRPM} RPM)` };
            }
        }

        return { allowed: true };
    }

    /**
     * 记录一次成功请求
     */
    recordSuccess(consumer: string): void {
        const state = this.getState(consumer);
        state.requestTimestamps.push(Date.now());
        state.consecutiveFailures = 0;  // 重置失败计数
    }

    /**
     * 记录一次失败请求
     */
    recordFailure(consumer: string): void {
        const state = this.getState(consumer);
        state.requestTimestamps.push(Date.now());
        state.consecutiveFailures++;

        // 触发熔断
        if (state.consecutiveFailures >= this.CIRCUIT_FAILURE_THRESHOLD) {
            state.circuitOpenUntil = Date.now() + this.CIRCUIT_OPEN_DURATION_MS;
            logger.warn(`[BudgetManager] 已为 consumer="${consumer}" 触发熔断，将于 ${this.CIRCUIT_OPEN_DURATION_MS / 1000}s 后恢复`);
        }
    }

    /**
     * 获取 consumer 配置中的 budget 参数
     */
    getConfig(consumer: string): BudgetConfig | undefined {
        const config = this.configs.get(consumer);
        return config ? { ...config } : undefined;
    }
}
