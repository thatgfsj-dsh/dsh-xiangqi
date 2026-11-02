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

const WEB_FILES = ['index.html', 'app.js', 'style.css', 'pieces.js']
const DOC_FILES = ['README.md', 'docs/USER-MANUAL.md']

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
  'btn-tunnel',
  'btn-again',
  'tunnel-status',
  'tunnel-url',
  'btn-copy',
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
for (const [name, text] of [['app.js', appJs], ['pieces.js', piecesJs]]) {
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
