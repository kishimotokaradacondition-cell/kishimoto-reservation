#!/usr/bin/osascript -l JavaScript
// PDFから「取引年月日・取引先・金額」を読み取る補助スクリプト
//
// macOSに最初から入っている osascript だけで動きます（追加インストール不要）。
// icloud_invoice_collect.sh から呼ばれます。単体でも使えます:
//     osascript -l JavaScript pdf_meta.js 請求書.pdf
//
// 出力（タブ区切り1行）:
//     取引年月日<TAB>取引先<TAB>金額<TAB>通貨<TAB>書類種別
//
// 読み取れなかった項目は空欄で返します。あくまで下読みであり、
// 最終的な値は索引簿で人が確認する前提です。
//
// 終了コード:
//     0 = 読み取りできた（項目が空でも0）
//     3 = PDFを開けなかった／文字が入っていない（画像だけのスキャンPDFなど）

ObjC.import('Quartz')

// 自社名。取引先の候補からは除外する（請求書には自社名も必ず載っているため）
var OWN_NAME_HINTS = ['きしもと', 'キシモト', '岸本', 'kishimoto', 'condiTion', 'コンディション']

// 金額の直前によく出てくる語。この近くの数字を優先して金額とみなす
var AMOUNT_KEYWORDS = [
  'ご請求金額', '請求金額', 'ご請求額', 'お支払い金額', 'お支払金額', '合計金額',
  '税込合計', '御請求金額', '合計', '総額', 'Amount paid', 'Amount due', 'Total',
]

var AMOUNT_PATTERNS = [
  [/(?:￥|¥|\\)\s?([0-9][0-9,]*(?:\.[0-9]+)?)/g, 'JPY'],
  [/([0-9][0-9,]*(?:\.[0-9]+)?)\s*円/g, 'JPY'],
  [/JPY\s?([0-9][0-9,]*(?:\.[0-9]+)?)/gi, 'JPY'],
  [/([0-9][0-9,]*(?:\.[0-9]+)?)\s?JPY/gi, 'JPY'],
  [/(?:US)?\$\s?([0-9][0-9,]*(?:\.[0-9]+)?)/g, 'USD'],
  [/USD\s?([0-9][0-9,]*(?:\.[0-9]+)?)/gi, 'USD'],
]

// 会社名らしい並び。「株式会社やわらぎ」「やわらぎ株式会社」の両方を拾う
var COMPANY_PATTERNS = [
  /((?:株式会社|合同会社|有限会社|合資会社|一般社団法人|医療法人)[^\s　、。／\/]{1,20})/g,
  /([^\s　、。／\/]{1,20}(?:株式会社|合同会社|有限会社))/g,
]

var ERA_START = { '令和': 2018, '平成': 1988, '昭和': 1925 }

function pad2(n) {
  return (n < 10 ? '0' : '') + n
}

function findAmounts(chunk) {
  var found = []
  AMOUNT_PATTERNS.forEach(function (p) {
    var re = new RegExp(p[0].source, p[0].flags)
    var m
    while ((m = re.exec(chunk)) !== null) {
      var value = Number(m[1].replace(/,/g, ''))
      if (isFinite(value) && value > 0) found.push({ amount: value, currency: p[1] })
    }
  })
  return found
}

// 「合計」などの語の近くを優先し、なければ本文中で最も大きい金額を採用する
function extractAmount(text) {
  for (var i = 0; i < AMOUNT_KEYWORDS.length; i++) {
    var pos = text.indexOf(AMOUNT_KEYWORDS[i])
    if (pos < 0) continue
    var hits = findAmounts(text.substring(pos, pos + 120))
    if (hits.length > 0) return hits[0]
  }
  var all = findAmounts(text)
  if (all.length === 0) return null
  all.sort(function (a, b) { return b.amount - a.amount })
  return all[0]
}

// 請求書によくある日付表記を西暦 YYYY-MM-DD にそろえて返す
function extractDate(text) {
  var m = text.match(/(令和|平成|昭和)\s*(\d{1,2}|元)\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/)
  if (m) {
    var eraYear = m[2] === '元' ? 1 : Number(m[2])
    return (ERA_START[m[1]] + eraYear) + '-' + pad2(Number(m[3])) + '-' + pad2(Number(m[4]))
  }
  m = text.match(/(20\d{2})\s*[年/\-.]\s*(\d{1,2})\s*[月/\-.]\s*(\d{1,2})/)
  if (m) {
    return m[1] + '-' + pad2(Number(m[2])) + '-' + pad2(Number(m[3]))
  }
  return ''
}

function isOwnName(name) {
  return OWN_NAME_HINTS.some(function (hint) { return name.indexOf(hint) >= 0 })
}

// 自社名を除いた最初の会社名を取引先の候補とする
function extractVendor(text) {
  var head = text.substring(0, 1500)   // 発行者名は先頭付近にあることが多い
  for (var i = 0; i < COMPANY_PATTERNS.length; i++) {
    var re = new RegExp(COMPANY_PATTERNS[i].source, COMPANY_PATTERNS[i].flags)
    var m
    while ((m = re.exec(head)) !== null) {
      var name = m[1].trim()
      if (!isOwnName(name)) return name
    }
  }
  var honorific = head.match(/([^\s　、。／\/]{2,20})\s*(?:御中|様)/)
  if (honorific && !isOwnName(honorific[1])) return honorific[1].trim()
  return ''
}

function guessDocType(text) {
  var head = text.substring(0, 500)
  if (head.indexOf('領収') >= 0 || /receipt/i.test(head)) return '領収書'
  if (head.indexOf('請求') >= 0 || /invoice/i.test(head)) return '請求書'
  if (head.indexOf('明細') >= 0 || /statement/i.test(head)) return '明細書'
  return ''
}

// 本文テキストから5項目をタブ区切りで組み立てる（テストしやすいよう分離）
function parseText(text) {
  // 全角スペースや改行のゆらぎを吸収してから解析する
  var flat = text.replace(/　/g, ' ').replace(/\r/g, '\n')
  var compact = flat.replace(/[ \t]*\n[ \t]*/g, '\n')

  var amount = extractAmount(compact)
  return [
    extractDate(compact),
    extractVendor(compact),
    amount ? String(Math.round(amount.amount)) : '',
    amount ? amount.currency : '',
    guessDocType(compact),
  ].join('\t')
}

function run(argv) {
  if (argv.length < 1) {
    $.exit(1)
  }

  // macOS標準のPDF機能（PDFKit）で本文テキストを取り出す
  var url = $.NSURL.fileURLWithPath(argv[0])
  var doc = $.PDFDocument.alloc.initWithURL(url)
  if (doc.isNil()) $.exit(3)

  var nsText = doc.string
  if (nsText.isNil()) $.exit(3)
  var text = nsText.js
  if (!text || !text.trim()) $.exit(3)

  return parseText(text)
}
