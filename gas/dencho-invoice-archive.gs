/**
 * 電子帳簿保存法（電子取引データ保存）対応 請求書・領収書 自動アーカイブ
 *
 * 2024年1月から、メールやWeb経由で受け取った請求書・領収書などの電子データは
 * 「電子のまま」保存することが義務づけられています（全法人・個人事業主が対象）。
 * また「日付・金額・取引先」で検索できる状態にしておく必要があります。
 *
 * このスクリプトは kishimoto.karada.condition@gmail.com の
 * Google Apps Script (https://script.google.com) で動かすことを想定しています。
 *
 *   setup()            … 保存フォルダ・索引簿・Gmailラベルを作る（最初に1回）
 *   backfillAll()      … 過去のメールをさかのぼって保存する（最初に1回）
 *   importDriveFolders() … 既存のDriveフォルダにある請求書PDFを取り込む（最初に1回）
 *   indexArchiveFolders() … 保存フォルダに置かれたファイルを索引簿に載せる
 *                           （Macから取り込んだiCloudの請求書もこれで索引簿に反映されます）
 *   dailyArchive()     … 新しく届いた請求書を毎日自動保存する（トリガーで自動実行）
 *   installTrigger()   … dailyArchive を毎朝6時に自動実行する設定（最初に1回）
 *
 * 詳しい手順: リポジトリの docs/dencho-invoice-archive.md を参照
 */

// ───────────────────────────────────────────────────────────
// 設定（ここだけ変えれば運用を調整できます）
// ───────────────────────────────────────────────────────────
const CONFIG = {
  // 保存先のルートフォルダ名（マイドライブ直下に作られます）
  ROOT_FOLDER_NAME: '電子帳簿保存（電子取引データ）',

  // 索引簿（日付・金額・取引先で検索するための一覧表）の名前
  INDEX_SHEET_NAME: '索引簿（電子取引データ）',

  // 処理済みのメールに付けるGmailラベル
  PROCESSED_LABEL: '電帳法/保存済み',
  REVIEW_LABEL: '電帳法/要確認',

  // backfillAll() でさかのぼる開始日（電帳法の義務化は2024年1月から）
  BACKFILL_SINCE: '2024/01/01',

  // dailyArchive() が毎回さかのぼって確認する日数（取りこぼし防止のため多めに）
  DAILY_LOOKBACK_DAYS: 10,

  // 実行結果の通知先。'' ならスクリプト所有者のアドレスに送ります
  NOTIFY_EMAIL: '',

  // 1件も保存しなかった日も通知メールを送るか
  NOTIFY_WHEN_NOTHING: false,

  // true にすると保存はせず「何が保存されるか」だけログに出します
  DRY_RUN: false,

  // 既存のDriveフォルダから発行済み請求書を取り込む場合、そのフォルダIDを列挙
  // （初期値: マイドライブ「やわらぎ > 請求書（きしもとマネジメントオフィス分）」）
  IMPORT_DRIVE_FOLDER_IDS: ['1Ct3I3BplGoT7OfaJcUnbOwSl6el9p-Qq'],
};

/**
 * 取引先の判定ルール。上から順に照合し、最初に一致したものを採用します。
 * 新しい取引先が増えたら、ここに1行足すだけで正しい名前で保存されます。
 */
const VENDOR_RULES = [
  { fromContains: 'payments-noreply@google.com', subjectContains: 'Google Workspace', vendor: 'Google（Google Workspace）', docType: '請求書' },
  { fromContains: 'payments-noreply@google.com', subjectContains: 'Cloud', vendor: 'Google（Google Cloud）', docType: '領収書' },
  { fromContains: 'payments-noreply@google.com', vendor: 'Google', docType: '請求書' },
  { fromContains: 'invoice+statements@mail.anthropic.com', vendor: 'Anthropic, PBC', docType: '領収書' },
  { fromContains: '@stripe.com', subjectContains: 'Railway', vendor: 'Railway Corporation', docType: '領収書' },
  { fromContains: '@stripe.com', vendor: 'Stripe経由の決済', docType: '領収書' },
];

/**
 * 取引書類ではないので保存しない差出人（お知らせ・自動通知など）。
 * 誤って予約通知やレポートメールを取引データとして保存しないための除外リストです。
 */
const EXCLUDE_SENDERS = [
  'no-reply-claude@mail.anthropic.com',   // Claudeの定期実行レポート
  'noreply@kishimotocondition.com',       // 予約システムの通知メール
  'workspace-noreply@google.com',         // Google Workspaceのお知らせ
  'calendar-notification@google.com',
];

// 取引データらしさを判定するキーワード（件名・本文）
const DOC_KEYWORDS = ['請求書', 'ご請求', '請求金額', '領収書', 'レシート', '明細書', '利用明細', 'お支払い', 'invoice', 'receipt', 'statement'];

// 金額の直前によく出てくる語（この近くの数字を優先して金額とみなす）
const AMOUNT_KEYWORDS = [
  'ご請求金額', '請求金額', 'ご請求額', 'お支払い金額', 'お支払金額', '合計金額',
  '税込合計', '合計', '総額', 'Amount paid', 'Amount due', 'Total paid', 'Total',
];

const PROP = PropertiesService.getScriptProperties();

// ───────────────────────────────────────────────────────────
// ① 初期セットアップ
// ───────────────────────────────────────────────────────────

/** 保存フォルダ・索引簿・Gmailラベルを作る。何度実行しても重複しません。 */
function setup() {
  const root = getOrCreateRootFolder_();
  const sheet = getOrCreateIndexSheet_(root);
  getOrCreateLabel_(CONFIG.PROCESSED_LABEL);
  getOrCreateLabel_(CONFIG.REVIEW_LABEL);

  const msg =
    '準備ができました。\n\n' +
    '保存フォルダ: ' + root.getUrl() + '\n' +
    '索引簿      : ' + sheet.getParent().getUrl() + '\n\n' +
    '次に backfillAll() を実行すると、過去のメールから請求書を集めます。';
  Logger.log(msg);
  return msg;
}

/** dailyArchive を毎朝6時に自動実行する設定。 */
function installTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'dailyArchive') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('dailyArchive').timeBased().atHour(6).everyDays(1).create();
  Logger.log('毎朝6時台に dailyArchive を自動実行するトリガーを設定しました。');
}

// ───────────────────────────────────────────────────────────
// ② 実行のエントリーポイント
// ───────────────────────────────────────────────────────────

/** 過去のメールをさかのぼって保存する（最初に1回だけ実行） */
function backfillAll() {
  return runArchive_(CONFIG.BACKFILL_SINCE, '過去分の一括取り込み');
}

/** 毎日の自動保存（トリガーから実行される） */
function dailyArchive() {
  const since = formatDate_(new Date(Date.now() - CONFIG.DAILY_LOOKBACK_DAYS * 86400000));
  return runArchive_(since, '日次の自動保存');
}

/** 保存はせず、何が保存されるかだけ確認する */
function dryRunAll() {
  const saved = CONFIG.DRY_RUN;
  CONFIG.DRY_RUN = true;
  try {
    return runArchive_(CONFIG.BACKFILL_SINCE, 'お試し実行（保存しません）');
  } finally {
    CONFIG.DRY_RUN = saved;
  }
}

function runArchive_(sinceDate, title) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) {
    Logger.log('別の処理が実行中のため中止しました。');
    return '別の処理が実行中';
  }
  try {
    const ctx = buildContext_();
    const results = []
      .concat(archiveReceived_(ctx, sinceDate))
      .concat(archiveIssued_(ctx, sinceDate));
    const report = buildReport_(title, results, ctx);
    Logger.log(report);
    if (results.length > 0 || CONFIG.NOTIFY_WHEN_NOTHING) notify_(title, report, results, ctx);
    return report;
  } finally {
    lock.releaseLock();
  }
}

/** 既存のDriveフォルダにある請求書PDFを索引簿に取り込む */
function importDriveFolders() {
  const ctx = buildContext_();
  const results = [];

  CONFIG.IMPORT_DRIVE_FOLDER_IDS.forEach(function (folderId) {
    let source;
    try {
      source = DriveApp.getFolderById(folderId);
    } catch (err) {
      Logger.log('フォルダを開けませんでした（ID: ' + folderId + '）: ' + err);
      return;
    }
    const files = source.getFiles();
    while (files.hasNext()) {
      const file = files.next();
      if (file.getMimeType() !== MimeType.PDF) continue;   // PDF以外（元データの表計算など）は対象外

      const key = 'drive:' + file.getId();
      if (ctx.processedKeys[key]) continue;

      const date = file.getLastUpdated();
      const parsed = parseIssuedFileName_(file.getName());
      const record = {
        key: key,
        date: date,
        vendor: parsed.counterparty || '（未設定）',
        amount: parsed.amount,
        currency: parsed.amount ? 'JPY' : '',
        side: '発行',
        docType: parsed.docType,
        source: 'Drive',
        party: '自社発行',
        subject: file.getName(),
        gmailUrl: '',
        needsReview: !parsed.amount || !parsed.counterparty,
        note: '既存フォルダから取り込み（元: ' + source.getName() + '）',
      };

      if (CONFIG.DRY_RUN) {
        results.push(Object.assign({ fileName: file.getName(), fileUrl: file.getUrl() }, record));
        continue;
      }

      const targetFolder = getYearFolder_(ctx.root, '発行', date);
      const fileName = buildFileName_(record, file.getName());
      const copied = file.makeCopy(fileName, targetFolder);
      results.push(Object.assign({ fileName: fileName, fileUrl: copied.getUrl() }, record));
      ctx.processedKeys[key] = true;
    }
  });

  appendToIndex_(ctx, results);
  const report = buildReport_('既存Driveフォルダの取り込み', results, ctx);
  Logger.log(report);
  return report;
}

/**
 * 保存フォルダの中にあって索引簿にまだ載っていないファイルを拾って追記する。
 *
 * Macの `scripts/dencho/icloud_invoice_collect.sh` が iCloud から集めたファイルや、
 * 手作業でフォルダに入れたファイルを索引簿に反映させるために使います。
 * ファイル名が「日付_取引先_金額」の形になっていれば、そこから読み取ります。
 */
function indexArchiveFolders() {
  const ctx = buildContext_();
  const results = [];

  ['受領', '発行'].forEach(function (side) {
    const it = ctx.root.getFoldersByName(side);
    if (!it.hasNext()) return;
    const sideFolder = it.next();

    const years = sideFolder.getFolders();
    while (years.hasNext()) {
      const yearFolder = years.next();
      const files = yearFolder.getFiles();

      while (files.hasNext()) {
        const file = files.next();
        const key = 'drive:' + file.getId();
        if (ctx.processedKeys[key]) continue;

        const parsed = parseArchiveFileName_(file.getName());
        results.push({
          key: key,
          date: parsed.date || file.getLastUpdated(),
          vendor: parsed.vendor || '（未設定）',
          amount: parsed.amount,
          currency: parsed.currency,
          side: side,
          docType: guessDocType_(file.getName()),
          source: 'フォルダ',
          party: '',
          subject: file.getName(),
          gmailUrl: '',
          fileName: file.getName(),
          fileUrl: file.getUrl(),
          needsReview: !parsed.amount || !parsed.vendor || !parsed.date,
          note: 'フォルダに置かれていたファイルを索引簿に追加',
        });
        ctx.processedKeys[key] = true;
      }
    }
  });

  appendToIndex_(ctx, results);
  const report = buildReport_('保存フォルダの取り込み', results, ctx);
  Logger.log(report);
  return report;
}

/** 「20260801_やわらぎ_11000円_請求書.pdf」から日付・取引先・金額を読み取る */
function parseArchiveFileName_(name) {
  const m = String(name).match(/^(\d{8})_([^_]+)_(?:(\d+)(円|USD)|金額未確認)_?/);
  if (!m) return { date: null, vendor: '', amount: null, currency: '' };

  const y = Number(m[1].substring(0, 4));
  const mo = Number(m[1].substring(4, 6));
  const d = Number(m[1].substring(6, 8));
  const date = (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) ? new Date(y, mo - 1, d) : null;

  return {
    date: date,
    vendor: m[2],
    amount: m[3] ? Number(m[3]) : null,
    currency: m[3] ? (m[4] === 'USD' ? 'USD' : 'JPY') : '',
  };
}

// ───────────────────────────────────────────────────────────
// ③ Gmailからの取り込み
// ───────────────────────────────────────────────────────────

/** 受領した請求書・領収書（自分あてに届いたもの） */
function archiveReceived_(ctx, sinceDate) {
  const vendorFroms = VENDOR_RULES
    .map(function (r) { return r.fromContains.replace(/^@/, ''); })
    .filter(function (v, i, a) { return a.indexOf(v) === i; });

  const query =
    'after:' + sinceDate + ' -in:draft -in:chats -in:sent ' +
    '(has:attachment OR from:(' + vendorFroms.join(' OR ') + ')) ' +
    '({' + DOC_KEYWORDS.join(' ') + '} OR from:(' + vendorFroms.join(' OR ') + '))';

  return processThreads_(ctx, query);
}

/** 発行した請求書・領収書（自分が送ったもの。控えの保存も義務です） */
function archiveIssued_(ctx, sinceDate) {
  const query =
    'after:' + sinceDate + ' in:sent has:attachment ' +
    '{' + DOC_KEYWORDS.join(' ') + '}';

  return processThreads_(ctx, query);
}

function processThreads_(ctx, query) {
  const results = [];
  let start = 0;
  const PAGE = 50;

  for (;;) {
    let threads;
    try {
      threads = GmailApp.search(query, start, PAGE);
    } catch (err) {
      Logger.log('Gmail検索に失敗しました: ' + err + ' / query=' + query);
      break;
    }
    if (threads.length === 0) break;

    threads.forEach(function (thread) {
      thread.getMessages().forEach(function (msg) {
        try {
          results.push.apply(results, processMessage_(ctx, msg, thread));
        } catch (err) {
          Logger.log('メールの処理に失敗しました（' + msg.getSubject() + '）: ' + err);
        }
      });
    });

    start += PAGE;
    if (start >= 500) break;   // 暴走防止（1回の実行で最大500スレッド）
  }

  appendToIndex_(ctx, results);
  return results;
}

function processMessage_(ctx, msg, thread) {
  const from = msg.getFrom();

  // 検索条件ではなく差出人で判定する。1つのスレッドに受け取ったメールと
  // 送ったメールが混在していても、受領/発行を取り違えません。
  const side = isSelfAddress_(ctx, from) ? '発行' : '受領';
  if (side === '受領' && isExcludedSender_(from)) return [];

  const subject = msg.getSubject() || '（件名なし）';
  const body = safeBody_(msg);
  const attachments = msg.getAttachments({ includeInlineImages: false, includeAttachments: true })
    .filter(function (att) { return isArchivableAttachment_(att); });

  // 取引書類らしさの判定：添付PDFがある、または既知の取引先からのメール
  const rule = side === '受領' ? matchVendorRule_(from, subject) : null;
  const hasKeyword = containsKeyword_(subject) || containsKeyword_(body);
  if (attachments.length === 0 && !rule) return [];
  if (!hasKeyword && !rule) return [];

  const amountInfo = extractAmount_(subject + '\n' + body);
  const date = msg.getDate();
  const counterparty = side === '受領'
    ? (rule ? rule.vendor : extractSenderName_(from))
    : extractRecipientName_(msg);

  const base = {
    date: date,
    vendor: counterparty,
    amount: amountInfo.amount,
    currency: amountInfo.currency,
    side: side,
    docType: rule ? rule.docType : guessDocType_(subject + ' ' + body),
    source: 'Gmail',
    party: side === '受領' ? from : msg.getTo(),
    subject: subject,
    gmailUrl: 'https://mail.google.com/mail/u/0/#all/' + thread.getId(),
    needsReview: !amountInfo.amount,
    note: '',
  };

  const results = [];

  if (attachments.length > 0) {
    attachments.forEach(function (att, i) {
      const key = msg.getId() + '#' + i;
      if (ctx.processedKeys[key]) return;

      const record = Object.assign({}, base, { key: key });
      if (CONFIG.DRY_RUN) {
        results.push(Object.assign({ fileName: att.getName(), fileUrl: '' }, record));
        return;
      }
      const folder = getYearFolder_(ctx.root, side, date);
      const fileName = buildFileName_(record, att.getName());
      const saved = folder.createFile(att.copyBlob().setName(fileName));
      results.push(Object.assign({ fileName: fileName, fileUrl: saved.getUrl() }, record));
      ctx.processedKeys[key] = true;
    });
  } else {
    // 添付がない「本文型」の請求書・領収書は、メール本文そのものをPDFにして残す
    const key = msg.getId() + '#body';
    if (ctx.processedKeys[key]) return results;

    const record = Object.assign({}, base, {
      key: key,
      note: 'メール本文をPDF化して保存（添付なし。Web明細へのリンクがある場合はPDFを別途ダウンロードして差し替えてください）',
      needsReview: true,
    });
    if (CONFIG.DRY_RUN) {
      results.push(Object.assign({ fileName: '(メール本文PDF)', fileUrl: '' }, record));
      return results;
    }
    const folder = getYearFolder_(ctx.root, side, date);
    const fileName = buildFileName_(record, 'メール本文.pdf');
    const blob = messageToPdfBlob_(msg, record, fileName);
    const saved = folder.createFile(blob);
    results.push(Object.assign({ fileName: fileName, fileUrl: saved.getUrl() }, record));
    ctx.processedKeys[key] = true;
  }

  if (!CONFIG.DRY_RUN && results.length > 0) {
    thread.addLabel(getOrCreateLabel_(CONFIG.PROCESSED_LABEL));
    if (results.some(function (r) { return r.needsReview; })) {
      thread.addLabel(getOrCreateLabel_(CONFIG.REVIEW_LABEL));
    }
  }
  return results;
}

// ───────────────────────────────────────────────────────────
// ④ 保存先フォルダと索引簿
// ───────────────────────────────────────────────────────────

function buildContext_() {
  const root = getOrCreateRootFolder_();
  const sheet = getOrCreateIndexSheet_(root);
  return {
    root: root,
    sheet: sheet,
    processedKeys: loadProcessedKeys_(sheet),
    selfEmails: getSelfEmails_(),
  };
}

/** 自分のメールアドレス（エイリアス含む）。受領と発行を取り違えないために使います */
function getSelfEmails_() {
  const list = [];
  try { list.push(Session.getEffectiveUser().getEmail()); } catch (err) { /* 取得できないこともある */ }
  try { GmailApp.getAliases().forEach(function (a) { list.push(a); }); } catch (err) { /* 同上 */ }
  return list.filter(Boolean).map(function (a) { return a.toLowerCase(); });
}

function getOrCreateRootFolder_() {
  const id = PROP.getProperty('ROOT_FOLDER_ID');
  if (id) {
    try { return DriveApp.getFolderById(id); } catch (err) { /* 消された場合は作り直す */ }
  }
  const folder = getOrCreateChildFolder_(DriveApp.getRootFolder(), CONFIG.ROOT_FOLDER_NAME);
  PROP.setProperty('ROOT_FOLDER_ID', folder.getId());
  return folder;
}

function getOrCreateChildFolder_(parent, name) {
  const it = parent.getFoldersByName(name);
  return it.hasNext() ? it.next() : parent.createFolder(name);
}

/** 受領/発行 × 年 のフォルダを返す（例: 受領/2026） */
function getYearFolder_(root, side, date) {
  const sideFolder = getOrCreateChildFolder_(root, side);
  return getOrCreateChildFolder_(sideFolder, String(date.getFullYear()));
}

const INDEX_HEADERS = [
  '通番', '取引年月日', '取引先', '税込金額', '通貨', '区分', '書類種別',
  'ファイル名', '保存先リンク', '取得元', '差出人/宛先', '件名',
  '元メール', '重複防止キー', '登録日時', '要確認', '備考',
];

function getOrCreateIndexSheet_(root) {
  const id = PROP.getProperty('INDEX_SHEET_ID');
  if (id) {
    try {
      const existing = SpreadsheetApp.openById(id).getSheetByName('索引簿');
      if (existing) return existing;
    } catch (err) { /* 消された・名前が変わった場合は作り直す */ }
  }

  const it = root.getFilesByName(CONFIG.INDEX_SHEET_NAME);
  let ss;
  if (it.hasNext()) {
    ss = SpreadsheetApp.open(it.next());
  } else {
    ss = SpreadsheetApp.create(CONFIG.INDEX_SHEET_NAME);
    DriveApp.getFileById(ss.getId()).moveTo(root);
  }

  let sheet = ss.getSheetByName('索引簿');
  if (!sheet) {
    sheet = ss.getSheets()[0];
    sheet.setName('索引簿');
  }
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, INDEX_HEADERS.length).setValues([INDEX_HEADERS])
      .setFontWeight('bold').setBackground('#e8eaed');
    sheet.setFrozenRows(1);
    sheet.getRange(2, 2, sheet.getMaxRows() - 1, 1).setNumberFormat('yyyy/mm/dd');
    sheet.getRange(2, 4, sheet.getMaxRows() - 1, 1).setNumberFormat('#,##0');
    sheet.setColumnWidth(3, 200);
    sheet.setColumnWidth(12, 280);
  }

  PROP.setProperty('INDEX_SHEET_ID', ss.getId());
  return sheet;
}

/** 索引簿に既に載っているデータを読み、二重保存を防ぐ */
function loadProcessedKeys_(sheet) {
  const map = {};
  const last = sheet.getLastRow();
  if (last < 2) return map;
  sheet.getRange(2, 14, last - 1, 1).getValues().forEach(function (row) {
    if (row[0]) map[String(row[0])] = true;
  });
  return map;
}

function appendToIndex_(ctx, results) {
  if (CONFIG.DRY_RUN || results.length === 0) return;

  const sheet = ctx.sheet;
  const startNo = sheet.getLastRow();   // ヘッダー行があるので、行数がそのまま通番になる
  const now = new Date();

  const rows = results.map(function (r, i) {
    return [
      startNo + i,
      r.date,
      r.vendor,
      r.amount || '',
      r.currency || '',
      r.side,
      r.docType,
      r.fileName,
      r.fileUrl,
      r.source,
      r.party,
      r.subject,
      r.gmailUrl,
      r.key,
      now,
      r.needsReview ? '要確認' : '',
      r.note || '',
    ];
  });

  sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, INDEX_HEADERS.length).setValues(rows);
}

// ───────────────────────────────────────────────────────────
// ⑤ 判定・抽出のこまごまとした処理
// ───────────────────────────────────────────────────────────

function isSelfAddress_(ctx, address) {
  const lower = String(address || '').toLowerCase();
  return (ctx.selfEmails || []).some(function (a) { return lower.indexOf(a) >= 0; });
}

function isExcludedSender_(from) {
  const lower = String(from).toLowerCase();
  return EXCLUDE_SENDERS.some(function (s) { return lower.indexOf(s.toLowerCase()) >= 0; });
}

function matchVendorRule_(from, subject) {
  const f = String(from).toLowerCase();
  const s = String(subject || '');
  for (let i = 0; i < VENDOR_RULES.length; i++) {
    const rule = VENDOR_RULES[i];
    if (f.indexOf(rule.fromContains.toLowerCase()) < 0) continue;
    if (rule.subjectContains && s.indexOf(rule.subjectContains) < 0) continue;
    return rule;
  }
  return null;
}

function containsKeyword_(text) {
  const lower = String(text || '').toLowerCase();
  return DOC_KEYWORDS.some(function (k) { return lower.indexOf(k.toLowerCase()) >= 0; });
}

function isArchivableAttachment_(att) {
  const type = att.getContentType();
  const name = String(att.getName()).toLowerCase();
  if (att.getSize() > 25 * 1024 * 1024) return false;
  if (type === MimeType.PDF || /\.pdf$/.test(name)) return true;
  if (/\.(xlsx|xls|csv|docx|png|jpg|jpeg)$/.test(name)) return true;
  return false;
}

function guessDocType_(text) {
  const t = String(text || '');
  if (t.indexOf('領収') >= 0 || /receipt/i.test(t)) return '領収書';
  if (t.indexOf('請求') >= 0 || /invoice/i.test(t)) return '請求書';
  if (t.indexOf('明細') >= 0 || /statement/i.test(t)) return '明細書';
  return 'その他';
}

/**
 * 本文から税込金額を取り出す。
 * 「合計」「Amount paid」などの語の近くにある数字を優先し、
 * 見つからなければ本文中で最も大きい金額を採用します（自動判定なので要確認欄で二重チェック）。
 */
function extractAmount_(text) {
  const t = String(text || '').replace(/ /g, ' ');

  for (let i = 0; i < AMOUNT_KEYWORDS.length; i++) {
    const pos = t.indexOf(AMOUNT_KEYWORDS[i]);
    if (pos < 0) continue;
    const near = t.substring(pos, pos + 120);
    const hit = firstAmountIn_(near);
    if (hit) return hit;
  }

  const all = allAmountsIn_(t);
  if (all.length === 0) return { amount: null, currency: '' };
  all.sort(function (a, b) { return b.amount - a.amount; });
  return all[0];
}

const AMOUNT_PATTERNS = [
  { re: /(?:￥|¥|\\)\s?([0-9][0-9,]*(?:\.[0-9]+)?)/g, currency: 'JPY' },
  { re: /([0-9][0-9,]*(?:\.[0-9]+)?)\s*円/g, currency: 'JPY' },
  { re: /JPY\s?([0-9][0-9,]*(?:\.[0-9]+)?)/gi, currency: 'JPY' },
  { re: /([0-9][0-9,]*(?:\.[0-9]+)?)\s?JPY/gi, currency: 'JPY' },
  { re: /(?:US)?\$\s?([0-9][0-9,]*(?:\.[0-9]+)?)/g, currency: 'USD' },
  { re: /USD\s?([0-9][0-9,]*(?:\.[0-9]+)?)/gi, currency: 'USD' },
];

function allAmountsIn_(text) {
  const found = [];
  AMOUNT_PATTERNS.forEach(function (p) {
    const re = new RegExp(p.re.source, p.re.flags);
    let m;
    while ((m = re.exec(text)) !== null) {
      const n = Number(String(m[1]).replace(/,/g, ''));
      if (isFinite(n) && n > 0) found.push({ amount: n, currency: p.currency });
    }
  });
  return found;
}

function firstAmountIn_(text) {
  const all = allAmountsIn_(text);
  return all.length > 0 ? all[0] : null;
}

/** 「山田太郎 <taro@example.com>」→「山田太郎」。表示名がなければドメイン名 */
function extractSenderName_(from) {
  const s = String(from || '');
  const m = s.match(/^\s*"?([^"<]+?)"?\s*</);
  if (m && m[1].trim()) return m[1].trim();
  const domain = s.match(/@([\w.-]+)/);
  return domain ? domain[1] : s;
}

function extractRecipientName_(msg) {
  const to = String(msg.getTo() || '');
  const first = to.split(',')[0];
  return extractSenderName_(first);
}

/** 「やわらぎ様　請求書_8月度.pdf」のようなファイル名から取引先・書類種別を推測する */
function parseIssuedFileName_(name) {
  const n = String(name || '');
  const party = n.match(/^([^\s　_]+?)\s*様/);
  const amount = n.match(/([0-9][0-9,]{2,})\s*円/);
  return {
    counterparty: party ? party[1] : '',
    amount: amount ? Number(amount[1].replace(/,/g, '')) : null,
    docType: guessDocType_(n),
  };
}

/** メール本文をPDFにする（添付ファイルがない請求書・領収書メール用） */
function messageToPdfBlob_(msg, record, fileName) {
  const header =
    '<div style="font-family:sans-serif;border:1px solid #999;padding:12px;margin-bottom:16px">' +
    '<div><b>取引年月日</b>: ' + formatDate_(record.date) + '</div>' +
    '<div><b>取引先</b>: ' + escapeHtml_(record.vendor) + '</div>' +
    '<div><b>金額</b>: ' + (record.amount ? record.amount.toLocaleString() + ' ' + record.currency : '（要確認）') + '</div>' +
    '<div><b>差出人</b>: ' + escapeHtml_(msg.getFrom()) + '</div>' +
    '<div><b>件名</b>: ' + escapeHtml_(msg.getSubject()) + '</div>' +
    '</div>';

  let body = '';
  try {
    body = msg.getBody();
  } catch (err) {
    body = '<pre>' + escapeHtml_(safeBody_(msg)) + '</pre>';
  }

  const html = '<html><head><meta charset="utf-8"></head><body>' + header + body + '</body></html>';
  return Utilities.newBlob(html, 'text/html', fileName).getAs(MimeType.PDF).setName(fileName);
}

function safeBody_(msg) {
  try {
    return msg.getPlainBody() || '';
  } catch (err) {
    return '';
  }
}

/**
 * 保存するファイル名を「日付_取引先_金額」の形にそろえる。
 * 索引簿だけでなくファイル名でも Drive 検索でヒットするようにしています。
 */
function buildFileName_(record, originalName) {
  const ext = (String(originalName).match(/\.[A-Za-z0-9]+$/) || ['.pdf'])[0];
  const base = String(originalName).replace(/\.[A-Za-z0-9]+$/, '');
  const amount = record.amount
    ? String(Math.round(record.amount)) + (record.currency === 'USD' ? 'USD' : '円')
    : '金額未確認';

  const parts = [
    Utilities.formatDate(record.date, 'Asia/Tokyo', 'yyyyMMdd'),
    sanitize_(record.vendor),
    amount,
    sanitize_(base).substring(0, 40),
  ];
  return parts.join('_').substring(0, 180) + ext;
}

function sanitize_(s) {
  return String(s || '')
    .replace(/[\/\\:*?"<>|]/g, '')
    .replace(/\s+/g, '')
    .trim() || '不明';
}

function escapeHtml_(s) {
  return String(s || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatDate_(d) {
  return Utilities.formatDate(d, 'Asia/Tokyo', 'yyyy/MM/dd');
}

function getOrCreateLabel_(name) {
  return GmailApp.getUserLabelByName(name) || GmailApp.createLabel(name);
}

// ───────────────────────────────────────────────────────────
// ⑥ 実行結果の報告
// ───────────────────────────────────────────────────────────

function buildReport_(title, results, ctx) {
  const lines = ['【' + title + '】' + (CONFIG.DRY_RUN ? '（お試し実行・保存していません）' : '')];
  lines.push('保存件数: ' + results.length + '件');

  if (results.length > 0) {
    lines.push('');
    results.forEach(function (r) {
      lines.push(
        '・' + formatDate_(r.date) + '  ' + r.vendor + '  ' +
        (r.amount ? r.amount.toLocaleString() + (r.currency === 'USD' ? ' USD' : ' 円') : '金額未確認') +
        '  [' + r.side + '/' + r.docType + ']  ' + r.fileName
      );
    });

    const review = results.filter(function (r) { return r.needsReview; });
    if (review.length > 0) {
      lines.push('');
      lines.push('※ ' + review.length + '件は金額などを自動で読み取れませんでした。');
      lines.push('   索引簿の「要確認」列を絞り込んで、手で埋めてください。');
    }
  }

  if (ctx && ctx.sheet) {
    lines.push('');
    lines.push('索引簿: ' + ctx.sheet.getParent().getUrl());
    lines.push('保存先: ' + ctx.root.getUrl());
  }
  return lines.join('\n');
}

function notify_(title, report, results, ctx) {
  const to = CONFIG.NOTIFY_EMAIL || Session.getEffectiveUser().getEmail();
  if (!to) return;
  try {
    MailApp.sendEmail({
      to: to,
      subject: '【電帳法】' + title + '：' + results.length + '件を保存しました',
      body: report,
    });
  } catch (err) {
    Logger.log('通知メールの送信に失敗しました: ' + err);
  }
}
