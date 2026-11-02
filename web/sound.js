// 落子音效（Web Audio 实时合成，无音频文件、无外链、无第三方库）。
// 设计目标：能"听出是谁在走"——人类落子偏低沉，agent 落子偏清脆；吃子另有一声脆响。
// 浏览器自动播放策略：必须等一次用户手势后才能出声，所以对外暴露 unlock()。

const DEFAULT_STORAGE_KEY = 'xq-sound-enabled'

function readEnabled(storageKey) {
  try {
    const raw = window.localStorage.getItem(storageKey)
    return raw === null ? true : raw !== '0'
  } catch {
    return true
  }
}

/**
 * 创建音效套件。
 * @param {{storageKey?: string}} [options]
 * @returns {{enabled:boolean, unlock:()=>void, toggle:()=>boolean, setEnabled:(v:boolean)=>void, playMove:Function, playEnd:Function}}
 */
export function createSoundKit(options = {}) {
  const storageKey = options.storageKey || DEFAULT_STORAGE_KEY
  let ctx = null
  let master = null
  let enabled = readEnabled(storageKey)

  function persist() {
    try {
      window.localStorage.setItem(storageKey, enabled ? '1' : '0')
    } catch {
      /* 隐私模式下忽略 */
    }
  }

  function ensureContext() {
    if (!enabled) return null
    const Ctor = typeof window !== 'undefined' ? window.AudioContext || window.webkitAudioContext : null
    if (!Ctor) return null
    if (!ctx) {
      ctx = new Ctor()
      master = ctx.createGain()
      master.gain.value = 0.32 // 整体偏轻，不吵
      master.connect(ctx.destination)
    }
    if (ctx.state === 'suspended') ctx.resume().catch(() => {})
    return ctx
  }

  function envelope(node, { attack = 0.002, decay = 0.12, peak = 0.5, delay = 0 }) {
    const t0 = (ctx.currentTime || 0) + delay
    node.gain.setValueAtTime(0.0001, t0)
    node.gain.exponentialRampToValueAtTime(Math.max(peak, 0.0002), t0 + attack)
    node.gain.exponentialRampToValueAtTime(0.0001, t0 + attack + decay)
  }

  function tone({ freq = 180, endFreq = null, decay = 0.09, peak = 0.5, delay = 0, type = 'sine' }) {
    const audio = ensureContext()
    if (!audio) return
    const osc = audio.createOscillator()
    const gain = audio.createGain()
    osc.type = type
    const t0 = audio.currentTime + delay
    osc.frequency.setValueAtTime(freq, t0)
    if (endFreq) osc.frequency.exponentialRampToValueAtTime(Math.max(endFreq, 20), t0 + decay)
    envelope(gain, { decay, peak, delay })
    osc.connect(gain)
    gain.connect(master)
    osc.start(t0)
    osc.stop(t0 + decay + 0.02)
  }

  function noiseBurst({ decay = 0.035, peak = 0.35, freq = 1400, q = 1.2, delay = 0 }) {
    const audio = ensureContext()
    if (!audio) return
    const frames = Math.max(1, Math.floor(audio.sampleRate * (decay + 0.01)))
    const buffer = audio.createBuffer(1, frames, audio.sampleRate)
    const data = buffer.getChannelData(0)
    for (let i = 0; i < frames; i += 1) {
      const fade = 1 - i / frames
      data[i] = (Math.random() * 2 - 1) * fade * fade
    }
    const src = audio.createBufferSource()
    src.buffer = buffer
    const filter = audio.createBiquadFilter()
    filter.type = 'bandpass'
    filter.frequency.value = freq
    filter.Q.value = q
    const gain = audio.createGain()
    envelope(gain, { attack: 0.001, decay, peak, delay })
    src.connect(filter)
    filter.connect(gain)
    gain.connect(master)
    const t0 = audio.currentTime + delay
    src.start(t0)
    src.stop(t0 + decay + 0.02)
  }

  // 木质落子声：低频"咚" + 带通噪声"嗒"
  function playClack({ pitch = 170, bright = 1300, volume = 0.55 } = {}) {
    tone({ freq: pitch, endFreq: pitch * 0.62, decay: 0.075, peak: volume * 0.7 })
    noiseBurst({ freq: bright, decay: 0.03, peak: volume * 0.5 })
  }

  /**
   * 走子音效。
   * @param {{side?: 'human'|'agent', capture?: boolean}} [detail]
   */
  function playMove(detail = {}) {
    if (!enabled) return
    const agent = detail.side === 'agent'
    if (detail.capture) {
      // 吃子：先一声脆裂，再一记闷响
      noiseBurst({ freq: 2400, decay: 0.045, peak: 0.4 })
      playClack({ pitch: agent ? 200 : 165, bright: 1800, volume: 0.6 })
      tone({ freq: 110, endFreq: 62, decay: 0.11, peak: 0.35, delay: 0.02 })
      return
    }
    // agent 落子更清脆（高一点），人类落子更沉（低一点）
    playClack(agent ? { pitch: 205, bright: 1650, volume: 0.5 } : { pitch: 160, bright: 1250, volume: 0.52 })
  }

  /**
   * 对局结束音效。
   * @param {{win?: boolean}} [detail] win=true 表示「你赢了」
   */
  function playEnd(detail = {}) {
    if (!enabled) return
    const win = detail.win === true
    const notes = win ? [523.25, 659.25, 783.99] : [392, 329.63, 261.63]
    notes.forEach((freq, index) => {
      tone({ freq, decay: 0.28, peak: 0.32, delay: index * 0.12 })
    })
  }

  /**
   * 将军 / 危险的提示音：两声短促的高音。
   */
  function playAlert() {
    if (!enabled) return
    tone({ freq: 880, decay: 0.09, peak: 0.3, type: 'triangle' })
    tone({ freq: 1174.66, decay: 0.12, peak: 0.28, delay: 0.1, type: 'triangle' })
  }

  function unlock() {
    ensureContext()
  }

  function setEnabled(value) {
    enabled = Boolean(value)
    persist()
    if (!enabled && master) master.gain.value = 0
    if (enabled && master) master.gain.value = 0.32
    return enabled
  }

  return {
    get enabled() {
      return enabled
    },
    unlock,
    toggle: () => setEnabled(!enabled),
    setEnabled,
    playMove,
    playEnd,
    playAlert,
  }
}

export default createSoundKit
