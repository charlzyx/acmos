import type { WireFormat } from '../ir/types.ts';
import type { Logger } from '../log/logger.ts';
import type { Store } from '../state/store.ts';
import {
  callUpstream,
  isFailoverable,
  pickKey,
  UpstreamCompatibilityError,
  UpstreamError,
  UpstreamStreamPreflightError,
} from '../upstream/client.ts';
import type { ResolvedTarget, Route } from './registry.ts';

/**
 * 顺序 fallback 调度。
 *
 * 约束：**只在首字节吹出去之前允许切换上游。** 一旦开始向客户端写响应体，
 * 就不能再换人了 —— 客户端已经收到半截内容，中途换模型会产出前后矛盾的输出。
 * 所以这里只负责「拿到 response 头」，流本身交给调用方直接转发。
 */

export interface DispatchOptions {
  route: Route;
  reqId: string;
  ingress: WireFormat;
  logger: Logger;
  store: Store;
  globalProxy?: string | undefined;
  signal?: AbortSignal | undefined;
  /** 会话粘性的键。为空则不启用粘性。 */
  sessionKey?: string | undefined;
  /** 针对具体目标构造上游请求体；可异步执行按目标的图片旁路。 */
  buildBody: (target: ResolvedTarget) => unknown | Promise<unknown>;
  resolvePath: (target: ResolvedTarget) => string;
  /** 传给上游的会话 id（如 Codex 的 prompt_cache_key / session_id 头）。 */
  sessionId?: string | undefined;
}

export interface DispatchResult {
  target: ResolvedTarget;
  response: Response;
  /** 第几次尝试命中（从 0 开始），用于日志与用量归因。 */
  attempt: number;
  /** 提交粘性：调用方确认流正常开始后再调，避免把失败目标记成偏好。 */
  commitSticky: () => void;
}

function cooldownKey(target: ResolvedTarget): string {
  return `${target.providerId}/${target.modelId}`;
}

/**
 * combo 的目标顺序就是 fallback 优先级，严格保持声明顺序。
 *
 * 只要会话粘性选中了一个偏好目标，就把它提到队首；其余成员维持声明顺序。
 * 不再按 wire 协议分组重排 —— 那会把同为异协议的次选整体排到首选之前，
 * 破坏 combo 的语义（combo/max 声明 codex sol 优先，失败落 opencode，
 * 但 sol 是 resp、opencode 是 cc，入站 cc 时分组重排会让 opencode 抢跑）。
 * 格式转换的代价本就由转换层承担，不该反过来改写业务优先级。
 */
function orderTargets(
  targets: ResolvedTarget[],
  _ingress: WireFormat,
  preferred: ResolvedTarget | undefined,
): ResolvedTarget[] {
  if (!preferred || !targets.includes(preferred)) return targets;
  return [preferred, ...targets.filter((target) => target !== preferred)];
}

export async function dispatch(options: DispatchOptions): Promise<DispatchResult> {
  const { route, logger, store, signal, sessionKey, buildBody, resolvePath, sessionId } = options;

  let preferred: ResolvedTarget | undefined;
  if (sessionKey && route.combo && route.comboConfig?.sticky) {
    const remembered = store.getSticky(sessionKey, route.combo, route.comboConfig.stickyTtlMs);
    if (remembered) {
      preferred = route.targets.find(
        (t) => t.providerId === remembered.provider && t.modelId === remembered.model,
      );
    }
  }

  const ordered = orderTargets(route.targets, options.ingress, preferred);
  const skipped: string[] = [];
  let lastError: UpstreamError | undefined;
  let attempt = 0;

  for (const [targetIndex, target] of ordered.entries()) {
    const key = cooldownKey(target);
    const until = store.getCooldown(key);
    if (until !== undefined) {
      // 全部目标都在冷却时会走到循环末尾，那时再退化为「无视冷却硬试一次」。
      skipped.push(key);
      continue;
    }

    try {
      const body = await buildBody(target);
      const keyFailover =
        target.auth.keyStrategy === 'failover' &&
        (target.auth.type === 'bearer' || target.auth.type === 'header') &&
        target.auth.keys.length > 1;
      const startKeyIndex = keyFailover ? (pickKey(target)?.index ?? 0) : 0;
      const keyAttempts = keyFailover ? target.auth.keys.length : 1;
      let response: Response | undefined;

      for (let preflightAttempt = 0; preflightAttempt <= 2; preflightAttempt++) {
        try {
          for (let keyAttempt = 0; keyAttempt < keyAttempts; keyAttempt++) {
            try {
              response = await callUpstream({
                target,
                path: resolvePath(target),
                body,
                signal,
                globalProxy: options.globalProxy,
                logger,
                sessionId,
                ...(keyFailover
                  ? { keyIndex: (startKeyIndex + keyAttempt) % target.auth.keys.length }
                  : {}),
              });
              break;
            } catch (err) {
              const error =
                err instanceof UpstreamError
                  ? err
                  : new UpstreamError({ kind: 'internal', message: String(err), raw: err });
              if (
                error.kind === 'canceled' ||
                !isFailoverable(error.kind) ||
                keyAttempt === keyAttempts - 1
              ) {
                throw error;
              }
              logger.warn('同一上游的 API key 失败，尝试下一把 key', {
                provider: target.providerId,
                model: target.modelId,
                keyAttempt,
                kind: error.kind,
                status: error.httpStatus,
              });
            }
          }
          break;
        } catch (err) {
          if (!(err instanceof UpstreamStreamPreflightError) || preflightAttempt === 2) throw err;
          attempt++;
          logger.warn('上游在首个有效输出前失败，重试同一成员', {
            provider: target.providerId,
            model: target.modelId,
            preflightAttempt: preflightAttempt + 1,
          });
        }
      }
      if (!response) {
        throw new UpstreamError({
          kind: 'internal',
          message: `上游 ${target.providerId} 未返回响应`,
        });
      }

      if (targetIndex > 0 || skipped.length > 0) {
        logger.info('已 fallback 到备选上游', {
          provider: target.providerId,
          model: target.modelId,
          attempt,
          skipped,
        });
      }

      return {
        target,
        response,
        attempt,
        commitSticky: () => {
          if (!sessionKey || !route.combo || !route.comboConfig?.sticky) return;
          store.setSticky(sessionKey, route.combo, {
            provider: target.providerId,
            model: target.modelId,
          });
        },
      };
    } catch (err) {
      const error =
        err instanceof UpstreamError
          ? err
          : new UpstreamError({ kind: 'internal', message: String(err), raw: err });

      // 客户端主动断开不是上游的问题，立刻停止，别去骚扰下一个上游。
      if (error.kind === 'canceled') throw error;

      lastError = error;
      attempt++;

      if (
        !isFailoverable(error.kind) &&
        !(route.combo && error instanceof UpstreamCompatibilityError)
      ) {
        logger.warn('直连上游返回不可重试的错误，直接透传给客户端', {
          provider: target.providerId,
          model: target.modelId,
          kind: error.kind,
          status: error.httpStatus,
        });
        throw error;
      }

      if (!isFailoverable(error.kind)) {
        logger.warn('combo 成员不兼容当前请求，尝试下一个成员', {
          provider: target.providerId,
          model: target.modelId,
          kind: error.kind,
          status: error.httpStatus,
        });
        continue;
      }

      const cooldownMs = error.retryAfterMs ?? route.comboConfig?.cooldownMs ?? 60_000;
      store.setCooldown(key, cooldownMs, error.kind);
      logger.warn('上游失败，进入冷却并尝试下一个', {
        provider: target.providerId,
        model: target.modelId,
        kind: error.kind,
        status: error.httpStatus,
        cooldownMs,
      });
    }
  }

  if (lastError) throw lastError;

  // 走到这里说明所有目标都被冷却挡住了。与其直接报错，不如清掉冷却硬试队首 ——
  // 冷却只是启发式，不该让整个 combo 彻底不可用。
  const first = ordered[0];
  if (first) {
    logger.warn('全部目标处于冷却中，清除冷却后重试队首', { skipped });
    store.clearCooldown(cooldownKey(first));
    return dispatch({ ...options, sessionKey: undefined });
  }

  throw new UpstreamError({
    kind: 'internal',
    message: `模型 ${route.requested} 没有可用的上游目标`,
  });
}
