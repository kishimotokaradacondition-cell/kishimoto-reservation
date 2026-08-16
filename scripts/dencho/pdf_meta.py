#!/usr/bin/env python3
"""
PDFから「取引年月日・取引先・金額」を読み取る補助スクリプト。

icloud_invoice_collect.sh から呼ばれます。単体でも使えます:
    python3 pdf_meta.py 請求書.pdf

出力（タブ区切り1行）:
    取引年月日<TAB>取引先<TAB>金額<TAB>通貨<TAB>書類種別

読み取れなかった項目は空欄で返します。あくまで下読みであり、
最終的な値は索引簿で人が確認する前提です。

終了コード:
    0 = 読み取りできた（項目が空でも0）
    2 = macOSのPDF読み取り機能が使えない（Quartzが無い）
    3 = PDFを開けなかった／文字が入っていない（画像だけのスキャンPDFなど）
"""

import re
import sys

# 自社名。取引先の候補からは除外する（請求書には自社名も必ず載っているため）
OWN_NAME_HINTS = ['きしもと', 'キシモト', '岸本', 'kishimoto', 'condiTion', 'コンディション']

# 金額の直前によく出てくる語。この近くの数字を優先して金額とみなす
AMOUNT_KEYWORDS = [
    'ご請求金額', '請求金額', 'ご請求額', 'お支払い金額', 'お支払金額', '合計金額',
    '税込合計', '御請求金額', '合計', '総額', 'Amount paid', 'Amount due', 'Total',
]

AMOUNT_PATTERNS = [
    (re.compile(r'(?:￥|¥|\\)\s?([0-9][0-9,]*(?:\.[0-9]+)?)'), 'JPY'),
    (re.compile(r'([0-9][0-9,]*(?:\.[0-9]+)?)\s*円'), 'JPY'),
    (re.compile(r'JPY\s?([0-9][0-9,]*(?:\.[0-9]+)?)', re.I), 'JPY'),
    (re.compile(r'(?:US)?\$\s?([0-9][0-9,]*(?:\.[0-9]+)?)'), 'USD'),
    (re.compile(r'USD\s?([0-9][0-9,]*(?:\.[0-9]+)?)', re.I), 'USD'),
]

# 会社名らしい並び。「株式会社やわらぎ」「やわらぎ株式会社」の両方を拾う
COMPANY_PATTERNS = [
    re.compile(r'((?:株式会社|合同会社|有限会社|合資会社|一般社団法人|医療法人)[^\s　、。／/]{1,20})'),
    re.compile(r'([^\s　、。／/]{1,20}(?:株式会社|合同会社|有限会社))'),
]

ERA_START = {'令和': 2018, '平成': 1988, '昭和': 1925}


def read_pdf_text(path):
    """macOS標準のPDF機能で本文テキストを取り出す。"""
    try:
        from Foundation import NSURL
        from Quartz import PDFDocument
    except ImportError:
        sys.exit(2)

    url = NSURL.fileURLWithPath_(path)
    doc = PDFDocument.alloc().initWithURL_(url)
    if doc is None:
        sys.exit(3)
    text = doc.string()
    if not text or not text.strip():
        sys.exit(3)
    return text


def extract_amount(text):
    """「合計」などの語の近くを優先し、なければ本文中で最大の金額を採用する。"""
    for keyword in AMOUNT_KEYWORDS:
        pos = text.find(keyword)
        if pos < 0:
            continue
        hits = find_amounts(text[pos:pos + 120])
        if hits:
            return hits[0]

    hits = find_amounts(text)
    if not hits:
        return None
    hits.sort(key=lambda h: h[0], reverse=True)
    return hits[0]


def find_amounts(chunk):
    found = []
    for pattern, currency in AMOUNT_PATTERNS:
        for m in pattern.finditer(chunk):
            try:
                value = float(m.group(1).replace(',', ''))
            except ValueError:
                continue
            if value > 0:
                found.append((value, currency))
    return found


def extract_date(text):
    """請求書によくある日付表記を西暦 YYYY-MM-DD にそろえて返す。"""
    m = re.search(r'(令和|平成|昭和)\s*(\d{1,2}|元)\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日', text)
    if m:
        era_year = 1 if m.group(2) == '元' else int(m.group(2))
        year = ERA_START[m.group(1)] + era_year
        return '%04d-%02d-%02d' % (year, int(m.group(3)), int(m.group(4)))

    m = re.search(r'(20\d{2})\s*[年/\-.]\s*(\d{1,2})\s*[月/\-.]\s*(\d{1,2})', text)
    if m:
        return '%04d-%02d-%02d' % (int(m.group(1)), int(m.group(2)), int(m.group(3)))

    return ''


def extract_vendor(text):
    """自社名を除いた最初の会社名を取引先の候補とする。"""
    head = text[:1500]   # 発行者名は先頭付近にあることが多い
    for pattern in COMPANY_PATTERNS:
        for m in pattern.finditer(head):
            name = m.group(1).strip()
            if any(hint in name for hint in OWN_NAME_HINTS):
                continue
            return name

    m = re.search(r'([^\s　、。／/]{2,20})\s*(?:御中|様)', head)
    if m and not any(hint in m.group(1) for hint in OWN_NAME_HINTS):
        return m.group(1).strip()
    return ''


def guess_doc_type(text):
    head = text[:500]
    if '領収' in head or re.search(r'receipt', head, re.I):
        return '領収書'
    if '請求' in head or re.search(r'invoice', head, re.I):
        return '請求書'
    if '明細' in head or re.search(r'statement', head, re.I):
        return '明細書'
    return ''


def main():
    if len(sys.argv) < 2:
        sys.stderr.write('使い方: python3 pdf_meta.py <PDFファイル>\n')
        sys.exit(1)

    text = read_pdf_text(sys.argv[1])
    # 全角スペースや改行のゆらぎを吸収してから解析する
    flat = text.replace('　', ' ').replace('\r', '\n')
    compact = re.sub(r'[ \t]*\n[ \t]*', '\n', flat)

    amount = extract_amount(compact)
    fields = [
        extract_date(compact),
        extract_vendor(compact),
        str(int(amount[0])) if amount else '',
        amount[1] if amount else '',
        guess_doc_type(compact),
    ]
    sys.stdout.write('\t'.join(fields) + '\n')


if __name__ == '__main__':
    main()
