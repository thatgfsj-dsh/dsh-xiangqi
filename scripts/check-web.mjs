#!/usr/bin/env node
// dsh-xiangqi 前端静态自检（零依赖，只读文件）。
// 用法：node scripts/check-web.mjs   失败时退出码 1。
//
// 检查项：
//   1. web/ 四个前端文件存在、非空、UTF-8 无 BOM、单文件 ≤ 1000 行
//   2. index.html 有全部必要挂载点、viewport/charset、noscript 提示、只引用 /assets/ 下的本地资源
//   3. web/ 内没有任何 http(s) 外链资源（不含文档，只查 web/）
//   4. app.js / pieces.js 不使用 HTML 字符串拼接、不使用动态代码执行
//   5. app.js 从 URL 读取口令、后续只用 x-xiangqi-token 头，且没有硬编码口令常量
//   6. style.css 不外链字体、不使用 @import，棋盘字体族为楷体/衬线

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const WEB = join(ROOT, 'web')
const MAX_LINES = 1000

const WEB_FILES = [
  'index.html', 'app.js', 'style.css', 'pieces.js', 'sound.js', 'feedback.js', 'record-view.js',
  'gomoku.html', 'gomoku.js', 'gomoku.css',
  'chess.html', 'chess.js', 'chess.css',
]
const DOC_FILES = ['README.md', 'CHANGELOG.md', 'docs/USER-MANUAL.md', 'docs/DESIGN.md']

const MOUNT_IDS = [
  'board',
  'layer-pieces',
  'layer-marks',
  'timer',
  'turn-text',
  'turn-you',
  'record-list',
  'record-scroll',
  'overlay',
  'toast',
  'net-banner',
  'btn-new',
  'btn-undo',
  'btn-resign',
  'btn-record',
  'btn-sound',
  'btn-again',
]

const passes = []
const failures = []

function ok(name) {
  passes.push(name)
}

function fail(name, detail) {
  failures.push(detail ? name + ' → ' + detail : name)
}

function check(name, condition, detail) {
  if (condition) ok(name)
  else fail(name, detail)
}

function readText(relPath) {
  return readFileSync(join(ROOT, relPath), 'utf8')
}

function lineCount(text) {
  const normalized = text.replace(/\r\n/g, '\n')
  if (normalized === '') return 0
  const lines = normalized.split('\n')
  return lines[lines.length - 1] === '' ? lines.length - 1 : lines.length
}

function findLines(text, regex) {
  const hits = []
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  for (let i = 0; i < lines.length; i++) {
    if (regex.test(lines[i])) hits.push(i + 1)
  }
  return hits
}

// ---------- 1. 文件存在性与编码 ----------
const texts = new Map()
for (const name of WEB_FILES) {
  const path = join(WEB, name)
  const exists = existsSync(path)
  check('web/' + name + ' 存在', exists, '缺少文件 ' + path)
  if (!exists) continue
  const text = readFileSync(path, 'utf8')
  texts.set(name, text)
  check('web/' + name + ' 非空', text.trim().length > 0, '文件为空')
  check('web/' + name + ' 无 BOM', text.charCodeAt(0) !== 0xfeff, '文件以 BOM 开头')
  check('web/' + name + ' 是合法 UTF-8', !text.includes('\ufffd'), '包含替换字符，可能不是 UTF-8')
  const lines = lineCount(text)
  check('web/' + name + ' 行数 ≤ ' + MAX_LINES + '（实际 ' + lines + '）', lines <= MAX_LINES, '文件过长，请拆分')
}

for (const name of DOC_FILES) {
  const exists = existsSync(join(ROOT, name))
  check(name + ' 存在', exists, '缺少文档 ' + name)
}

const html = texts.get('index.html')
const appJs = texts.get('app.js')
const css = texts.get('style.css')
const piecesJs = texts.get('pieces.js')

// ---------- 2. HTML 结构 ----------
if (html) {
  check('index.html 声明 doctype', /^\s*<!doctype html>/i.test(html), '首行应为 <!doctype html>')
  check('index.html 声明 lang="zh-CN"', /<html[^>]*lang="zh-CN"/i.test(html), '缺少 lang="zh-CN"')
  check('index.html 声明 charset="utf-8"', /<meta[^>]*charset="utf-8"/i.test(html), '缺少 UTF-8 声明')
  check('index.html 有 viewport', /<meta[^>]*name="viewport"[^>]*width=device-width/i.test(html), '缺少手机 viewport')
  for (const id of MOUNT_IDS) {
    check('index.html 有挂载点 #' + id, new RegExp('id="' + id + '"').test(html), '缺少 id="' + id + '"')
  }
  check('index.html 有 noscript 降级提示', /<noscript[\s>]/i.test(html), '缺少 <noscript>')
  check('index.html 用 type="module" 引入 app.js', /<script[^>]*type="module"[^>]*src="\/assets\/app\.js"/i.test(html), '缺少 type="module" 的 /assets/app.js')
  check('index.html 引用 /assets/style.css', /<link[^>]*href="\/assets\/style\.css"/i.test(html), '缺少 /assets/style.css')
  check('index.html 有 SVG 棋盘线格', /<svg[^>]*class="board-grid"/i.test(html), '缺少棋盘 SVG')
  check('index.html 有楚河汉界', html.includes('楚') && html.includes('汉'), '缺少楚河汉界文字')
  check('index.html 有九宫斜线', /class="grid-palace"/.test(html), '缺少九宫斜线')
  check('index.html 有炮兵位标记', /class="grid-mark"/.test(html), '缺少炮兵位十字标记')

  // 只允许 /assets/、data:、#、相对本地路径
  const attrRegex = /\b(?:src|href)\s*=\s*"([^"]*)"/gi
  let match
  while ((match = attrRegex.exec(html)) !== null) {
    const value = match[1].trim()
    if (!value) continue
    const allowed = value.startsWith('/assets/') || value.startsWith('data:') || value.startsWith('#') || value.startsWith('/')
    check('index.html 资源为本地路径：' + value.slice(0, 48), allowed, '出现非本地资源引用')
  }
  check('index.html 无内联脚本', !/<script(?![^>]*\bsrc=)[^>]*>/i.test(html), '不允许内联脚本')
}

// ---------- 3. web/ 内无 http(s) 外链 ----------
const externalHits = []
for (const name of WEB_FILES) {
  const text = texts.get(name)
  if (!text) continue
  for (const line of findLines(text, /https?:\/\//i)) externalHits.push(name + ':' + line)
  for (const line of findLines(text, /(?:src|href)\s*=\s*["']\/\//i)) externalHits.push(name + ':' + line + '（协议相对外链）')
}
check('web/ 内无 http(s) 外链资源', externalHits.length === 0, externalHits.join('、'))

// ---------- 4. JS 不使用 HTML 字符串 / 动态执行 ----------
for (const [name, text] of [
  ['app.js', appJs],
  ['pieces.js', piecesJs],
  ['sound.js', texts.get('sound.js')],
  ['gomoku.js', texts.get('gomoku.js')],
  ['chess.js', texts.get('chess.js')],
]) {
  if (!text) continue
  for (const [label, regex] of [
    ['innerHTML', /\binnerHTML\b/],
    ['outerHTML', /\bouterHTML\b/],
    ['insertAdjacentHTML', /\binsertAdjacentHTML\b/],
    ['document.write', /\bdocument\.write\s*\(/],
    ['eval(', /\beval\s*\(/],
    ['new Function', /\bnew\s+Function\s*\(/],
  ]) {
    const hits = findLines(text, regex)
    check('web/' + name + ' 不使用 ' + label, hits.length === 0, '第 ' + hits.join('、') + ' 行')
  }
}

// ---------- 5. 口令处理 ----------
if (appJs) {
  check('app.js 从 URL 读取口令', /URLSearchParams/.test(appJs), '应使用 URLSearchParams 读取 ?k=')
  check('app.js 用 x-xiangqi-token 头', /x-xiangqi-token/.test(appJs), '缺少鉴权头')
  const tokenLiteral = appJs.match(/['"`]([a-z0-9]{18})['"`]/)
  check('app.js 无硬编码 18 位口令常量', tokenLiteral === null, tokenLiteral ? '疑似口令：' + tokenLiteral[1].slice(0, 4) + '…' : '')
  const queryToken = findLines(appJs, /[?&]k=/)
  check('app.js 不在请求地址里拼口令', queryToken.length === 0, '第 ' + queryToken.join('、') + ' 行')
  check('app.js 不把口令写进控制台', !/console\.(?:log|info|debug|warn|error)\s*\(\s*store\.token/.test(appJs), '不要输出 token')
}

// ---------- 6. 样式：无外链字体 / 楷体字体族 ----------
if (css) {
  check('style.css 无 @import', !/@import/i.test(css), '不允许 @import')
  check('style.css 无 @font-face', !/@font-face/i.test(css), '不允许外链或内嵌字体')
  const remoteUrl = findLines(css, /url\(\s*['"]?https?:/i)
  check('style.css 无外链 url()', remoteUrl.length === 0, '第 ' + remoteUrl.join('、') + ' 行')
  check('style.css 使用楷体字体族', /"Kaiti SC"/.test(css) && /"KaiTi"/.test(css), '缺少 "Kaiti SC","KaiTi" 字体族')
  check('style.css 有手机三段式布局', /grid-template-areas/.test(css) && /min-width:\s*720px/.test(css), '缺少手机/桌面断点布局')
  check('style.css 有棋子渐变与内阴影', /radial-gradient/.test(css) && /inset/.test(css), '缺少棋子立体样式')
  check('style.css 有低时间闪烁动画', /@keyframes\s+timer-blink/.test(css), '缺少 ≤60s 闪烁动画')
  check('style.css 有棋子抖动动画', /@keyframes\s+piece-shake/.test(css), '缺少非法走子抖动动画')
}

// ---------- 7. 前端不 import 任何第三方包 ----------
if (appJs) {
  const specifiers = []
  const fromRegex = /\bfrom\s+['"]([^'"]+)['"]/g
  const bareRegex = /\bimport\s+['"]([^'"]+)['"]/g
  let found
  while ((found = fromRegex.exec(appJs)) !== null) specifiers.push(found[1])
  while ((found = bareRegex.exec(appJs)) !== null) specifiers.push(found[1])
  const badImports = specifiers.filter((spec) => !spec.startsWith('.') && !spec.startsWith('/'))
  check('app.js 只 import 相对路径模块', badImports.length === 0, badImports.join('、'))
}

// ---------- 8. 音效与招数提示 ----------
if (appJs) {
  check('app.js 引入 ./sound.js', /from\s+['"]\.\/sound\.js['"]/.test(appJs), '缺少音效模块 import')
  check('app.js 引入 ./feedback.js', /from\s+['"]\.\/feedback\.js['"]/.test(appJs), '缺少反馈模块 import')
  check('app.js 引入 ./record-view.js', /from\s+['"]\.\/record-view\.js['"]/.test(appJs), '缺少棋谱视图 import')
  check('app.js 用 pointerdown/keydown 解锁音频', /pointerdown[\s\S]{0,160}sound\.unlock|sound\.unlock[\s\S]{0,240}keydown/.test(appJs), '缺少用户手势解锁')
  check('app.js 接通音效开关与招数提示', /renderSoundButton/.test(appJs) && /feedback\.onSnapshot/.test(appJs), '缺少音效开关/反馈接通')
}
const soundJs = texts.get('sound.js')
if (soundJs) {
  check('sound.js 使用 Web Audio 合成', /AudioContext/.test(soundJs), '应使用 AudioContext')
  check('sound.js 有走子/将军/结束三种音效', /playMove/.test(soundJs) && /playAlert/.test(soundJs) && /playEnd/.test(soundJs), '缺少音效种类')
  check('sound.js 音效开关持久化', /localStorage/.test(soundJs), '缺少 localStorage 持久化')
}
const feedbackJs = texts.get('feedback.js')
if (feedbackJs) {
  check('feedback.js 有招数提示', /announceTags/.test(feedbackJs) && /playAlert/.test(feedbackJs), '缺少将军提示')
  check('feedback.js 区分人类/agent 音色', /side/.test(feedbackJs) && /playMove/.test(feedbackJs), '缺少音色区分')
}
const recordViewJs = texts.get('record-view.js')
if (recordViewJs) {
  check('record-view.js 渲染招数徽标', /record-tag/.test(recordViewJs), '缺少 record-tag')
}
if (css) {
  check('style.css 有招数徽标样式', /\.record-tag\b/.test(css), '缺少 .record-tag 样式')
}

// ---------- 9. 动态刷新 / 手机首屏 / 落子动画 / 去穿透 UI ----------
if (html) {
  check('index.html 不再有穿透按钮', !/id="btn-tunnel"/.test(html), '穿透按钮应移除')
  check('index.html 不再有穿透面板', !/id="tunnel-panel"|id="tunnel-status"/.test(html), '穿透面板应移除')
}
if (appJs) {
  check('app.js 使用长轮询 /api/wait 动态刷新', /API\.wait/.test(appJs) && /\/api\/wait/.test(appJs), '缺少长轮询')
  check('app.js 不再用 SSE/EventSource', !/EventSource|text\/event-stream|connectEvents/.test(appJs), 'SSE 代码应移除')
  check('app.js 有落子动画（WAAPI）', /function animateMove/.test(appJs) && /\.animate\(/.test(appJs), '缺少落子动画')
  check('app.js 有拿起态切换', /is-picked/.test(appJs), '缺少 is-picked')
  check('app.js 不再有穿透接口调用', !/API\.tunnel|toggleTunnel/.test(appJs), '穿透前端逻辑应移除')
}
if (css) {
  check('style.css 有拿起抬起样式', /\.piece\.is-picked/.test(css), '缺少 .piece.is-picked')
  check('style.css 手机首屏棋盘占满剩余高度', /\.stage\s*\{[\s\S]*?height:\s*calc\(100svh - 1\d\dpx\)/.test(css), '缺少手机首屏高度')
  check('style.css 棋谱不再挤占首屏（无 max-height 限制）', /\.record\s*\{[\s\S]*?max-height:\s*none/.test(css), '棋谱应放在首屏下方')
}

// ---------- 10. 五子棋前端 ----------
const gmHtml = texts.get('gomoku.html')
const gmJs = texts.get('gomoku.js')
const gmCss = texts.get('gomoku.css')
if (gmHtml) {
  check('gomoku.html 声明 doctype/lang/charset', /^\s*<!doctype html>/i.test(gmHtml) && /lang="zh-CN"/.test(gmHtml) && /charset="utf-8"/i.test(gmHtml), '缺少基础声明')
  check('gomoku.html 有 viewport', /name="viewport"[^>]*width=device-width/i.test(gmHtml), '缺少手机 viewport')
  check('gomoku.html 引入 /assets/gomoku.css', /href="\/assets\/gomoku\.css"/.test(gmHtml), '缺少 gomoku.css')
  check('gomoku.html 引入 /assets/gomoku.js（module）', /<script[^>]*type="module"[^>]*src="\/assets\/gomoku\.js"/i.test(gmHtml), '缺少 module 脚本')
  check('gomoku.html 有棋盘挂载点', /id="board"/.test(gmHtml), '缺少 #board')
  check('gomoku.html 有 SVG 网格与棋子层', /id="board-grid"/.test(gmHtml) && /id="board-stones"/.test(gmHtml), '缺少 SVG 网格/棋子层')
}
if (gmJs) {
  check('gomoku.js 用长轮询 /api/gomoku/wait', /\/api\/gomoku\/wait/.test(gmJs), '缺少长轮询')
  check('gomoku.js 落子走 /api/gomoku/move', /\/api\/gomoku\/move/.test(gmJs), '缺少落子接口')
  check('gomoku.js 15×15 棋盘', /const SIZE = 15/.test(gmJs), '棋盘应为 15×15')
  check('gomoku.js 不拼接 HTML', !/innerHTML|insertAdjacentHTML/.test(gmJs), '不允许 innerHTML')
}
if (gmCss) {
  check('gomoku.css 有 SVG 棋盘线样式', /\.board-grid line/.test(gmCss), '缺少 SVG 棋盘线样式')
  check('gomoku.css 有黑/白棋子样式', /\.stone--black/.test(gmCss) && /\.stone--white/.test(gmCss), '缺少棋子样式')
}

// ---------- 11. 国际象棋前端 ----------
const chHtml = texts.get('chess.html')
const chJs = texts.get('chess.js')
const chCss = texts.get('chess.css')
if (chHtml) {
  check('chess.html 声明 doctype/lang/charset', /^\s*<!doctype html>/i.test(chHtml) && /lang="zh-CN"/.test(chHtml) && /charset="utf-8"/i.test(chHtml), '缺少基础声明')
  check('chess.html 有 viewport', /name="viewport"[^>]*width=device-width/i.test(chHtml), '缺少手机 viewport')
  check('chess.html 引入 /assets/chess.css', /href="\/assets\/chess\.css"/.test(chHtml), '缺少 chess.css')
  check('chess.html 引入 /assets/chess.js（module）', /<script[^>]*type="module"[^>]*src="\/assets\/chess\.js"/i.test(chHtml), '缺少 module 脚本')
  check('chess.html 有棋盘与升变面板', /id="board"/.test(chHtml) && /id="promo"/.test(chHtml), '缺少棋盘/升变面板')
}
if (chJs) {
  check('chess.js 用长轮询 /api/chess/wait', /\/api\/chess\/wait/.test(chJs), '缺少长轮询')
  check('chess.js 走子走 /api/chess/move', /\/api\/chess\/move/.test(chJs), '缺少走子接口')
  check('chess.js 8×8 棋盘', /for \(let file = 0; file < 8/.test(chJs), '棋盘应为 8×8')
  check('chess.js 不拼接 HTML', !/innerHTML|insertAdjacentHTML/.test(chJs), '不允许 innerHTML')
  check('chess.js 有升变选择', /promoQ|promotion/.test(chJs), '缺少升变处理')
}
if (chCss) {
  check('chess.css 有 8×8 网格', /repeat\(8,/.test(chCss), '缺少 8 列网格')
  check('chess.css 有明暗格样式', /\.sq--light/.test(chCss) && /\.sq--dark/.test(chCss), '缺少明暗格样式')
  check('chess.css 有棋子样式', /\.piece--white/.test(chCss) && /\.piece--black/.test(chCss), '缺少棋子样式')
}

// ---------- 汇总 ----------
const total = passes.length + failures.length
console.log('dsh-xiangqi 前端自检（web/ + 文档）')
for (const name of passes) console.log('  ok  ' + name)
if (failures.length > 0) {
  console.log('')
  for (const item of failures) console.log('  FAIL  ' + item)
  console.log('')
  console.log('结果：' + failures.length + '/' + total + ' 项失败，退出码 1')
  process.exitCode = 1
} else {
  console.log('')
  console.log('结果：' + total + ' 项全部通过')
  process.exitCode = 0
}
