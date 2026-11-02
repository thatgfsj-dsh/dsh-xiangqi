// 宿主层配置：xiangqi.config.json + XQ_* 环境变量。
// 查找顺序（DESIGN §6）：$XQ_CONFIG → $DSH_HOME/plugins-data/xiangqi/config.json → 仓库根 xiangqi.config.json。
// 全部缺失时用默认值；凭据只从配置/环境读，绝不写死、绝不进日志。
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 仓库根目录（本文件位于 <repo>/src/host/config.mjs）。 */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

/**
 * 默认配置。
 * proxy 默认指向本机 Clash（实测 cloudflared 直连 CF 边缘超时，必须走代理）；
 * 置空字符串表示不注入代理环境变量。
 */
export function defaultConfig() {
  return {
    // 服务
    host: '127.0.0.1',
    port: null, // null = 在 5000-5050 里挑空闲口
    portRange: [5000, 5050],
    minutes: 20, // 全局限时（分钟）
    dataDir: join(REPO_ROOT, '.data'), // 记谱落盘目录（games/<gameId>.md）
    // 口令（可选固定值，便于本地调试；正常情况下每局随机生成）
    token: null,
    // 隧道
    proxy: 'http://127.0.0.1:7897',
    binPath: null, // cloudflared 可执行文件覆盖
    binArgs: [], // 附加在 provider 参数之前的参数（测试/调试用，如 node 脚本）
    tunnelTimeoutMs: 30000, // 拿不到公网 URL 的超时
    tunnelStopTimeoutMs: 5000, // stop() 等子进程退出的上限
    provider: 'cloudflared', // 默认提供方
    natfrp: {
      token: '',
      tunnelId: '',
      clientPath: null,
      args: null, // 可选：完整参数模板，支持 {token} {tunnelId} 占位
    },
  }
}

/** 环境变量名 → 配置路径。 */
const ENV_OVERRIDES = [
  ['XQ_TOKEN', ['token'], 'string'],
  ['XQ_PORT', ['port'], 'number'],
  ['XQ_MINUTES', ['minutes'], 'number'],
  ['XQ_NATFRP_TOKEN', ['natfrp', 'token'], 'string'],
  ['XQ_NATFRP_TUNNEL', ['natfrp', 'tunnelId'], 'string'],
  ['XQ_NATFRP_CLIENT', ['natfrp', 'clientPath'], 'string'],
  ['XQ_CLOUDFLARED', ['binPath'], 'string'],
  ['XQ_PROXY', ['proxy'], 'string'],
  ['XQ_DATA_DIR', ['dataDir'], 'string'],
  ['XQ_PROVIDER', ['provider'], 'string'],
  ['XQ_TUNNEL_TIMEOUT_MS', ['tunnelTimeoutMs'], 'number'],
]

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 深合并：只覆盖对象里显式出现的键，数组整体替换。 */
function deepMerge(base, patch) {
  if (!isPlainObject(patch)) return base
  const out = { ...base }
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue
    if (isPlainObject(value) && isPlainObject(base[key])) out[key] = deepMerge(base[key], value)
    else out[key] = value
  }
  return out
}

function setPath(target, path, value) {
  let node = target
  for (let i = 0; i < path.length - 1; i += 1) {
    if (!isPlainObject(node[path[i]])) node[path[i]] = {}
    node = node[path[i]]
  }
  node[path[path.length - 1]] = value
}

function coerce(value, kind) {
  if (kind === 'number') {
    const n = Number(value)
    return Number.isFinite(n) ? n : undefined
  }
  return String(value)
}

/** 规范化并兜底配置：类型修正、范围收敛、相对 dataDir 锚定到仓库根。 */
export function normalizeConfig(raw, { repoRoot = REPO_ROOT } = {}) {
  const base = defaultConfig()
  const merged = deepMerge(base, isPlainObject(raw) ? raw : {})

  const rawPort = merged.port
  const port = rawPort === null || rawPort === undefined || rawPort === '' ? null : Number(rawPort)
  merged.port = Number.isInteger(port) && port > 0 && port <= 65535 ? port : null

  const minutes = Number(merged.minutes)
  merged.minutes = Number.isFinite(minutes) && minutes > 0 ? minutes : base.minutes

  const timeout = Number(merged.tunnelTimeoutMs)
  merged.tunnelTimeoutMs = Number.isFinite(timeout) && timeout > 0 ? timeout : base.tunnelTimeoutMs

  const stopTimeout = Number(merged.tunnelStopTimeoutMs)
  merged.tunnelStopTimeoutMs =
    Number.isFinite(stopTimeout) && stopTimeout > 0 ? stopTimeout : base.tunnelStopTimeoutMs

  const range = Array.isArray(merged.portRange) ? merged.portRange.map(Number) : base.portRange
  const lo = Number.isInteger(range[0]) ? range[0] : base.portRange[0]
  const hi = Number.isInteger(range[1]) ? range[1] : base.portRange[1]
  merged.portRange = lo <= hi ? [lo, hi] : base.portRange.slice()

  merged.host = typeof merged.host === 'string' && merged.host ? merged.host : base.host
  merged.proxy = typeof merged.proxy === 'string' ? merged.proxy : base.proxy
  merged.token = typeof merged.token === 'string' && merged.token ? merged.token : null
  merged.binPath = typeof merged.binPath === 'string' && merged.binPath ? merged.binPath : null
  merged.binArgs = Array.isArray(merged.binArgs) ? merged.binArgs.map(String) : []
  merged.provider = merged.provider === 'natfrp' ? 'natfrp' : 'cloudflared'

  if (typeof merged.dataDir !== 'string' || !merged.dataDir) merged.dataDir = base.dataDir
  if (!isAbsolute(merged.dataDir)) merged.dataDir = resolve(repoRoot, merged.dataDir)

  const natfrp = isPlainObject(merged.natfrp) ? merged.natfrp : {}
  merged.natfrp = {
    token: typeof natfrp.token === 'string' ? natfrp.token : '',
    tunnelId:
      typeof natfrp.tunnelId === 'string'
        ? natfrp.tunnelId
        : Number.isFinite(natfrp.tunnelId)
          ? String(natfrp.tunnelId)
          : '',
    clientPath:
      typeof natfrp.clientPath === 'string' && natfrp.clientPath ? natfrp.clientPath : null,
    args: Array.isArray(natfrp.args) ? natfrp.args.map(String) : null,
  }

  return merged
}

/**
 * 按 DESIGN §6 的顺序找配置文件。
 * @returns {{ path: string|null, source: 'env'|'dsh-home'|'repo'|'none' }}
 */
export function findConfigPath({ env = process.env, repoRoot = REPO_ROOT } = {}) {
  const explicit = env.XQ_CONFIG
  if (explicit) {
    const path = isAbsolute(explicit) ? explicit : resolve(repoRoot, explicit)
    return { path, source: 'env' }
  }
  const dshHome = env.DSH_HOME || join(homedir(), '.dsh')
  const homePath = join(dshHome, 'plugins-data', 'xiangqi', 'config.json')
  if (existsSync(homePath)) return { path: homePath, source: 'dsh-home' }
  const repoPath = join(repoRoot, 'xiangqi.config.json')
  if (existsSync(repoPath)) return { path: repoPath, source: 'repo' }
  return { path: null, source: 'none' }
}

/**
 * 读配置：文件缺失/损坏都不抛，退化为默认值。
 * @returns {{ config: object, source: string, path: string|null, warnings: string[] }}
 */
export function loadConfig({ env = process.env, repoRoot = REPO_ROOT } = {}) {
  const warnings = []
  const { path, source } = findConfigPath({ env, repoRoot })
  let raw = {}
  if (path) {
    try {
      raw = JSON.parse(readFileSync(path, 'utf8'))
      if (!isPlainObject(raw)) {
        warnings.push(`配置文件不是 JSON 对象：${path}`)
        raw = {}
      }
    } catch (error) {
      warnings.push(`配置文件读取失败（${path}）：${error.message}`)
      raw = {}
    }
  }
  for (const [name, configPath, kind] of ENV_OVERRIDES) {
    if (env[name] === undefined || env[name] === '') continue
    const value = coerce(env[name], kind)
    if (value === undefined) {
      warnings.push(`环境变量 ${name} 不是合法数字，已忽略`)
      continue
    }
    setPath(raw, configPath, value)
  }
  const config = normalizeConfig(raw, { repoRoot })
  return { config, source, path, warnings }
}

export default loadConfig
