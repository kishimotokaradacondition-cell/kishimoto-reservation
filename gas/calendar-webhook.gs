/**
 * きしもとカラダcondiTion 予約システム → Googleカレンダー連携用 Webhook
 *
 * このスクリプトを kishimoto.karada.condition@gmail.com の
 * Google Apps Script (https://script.google.com) に貼り付けて
 * 「ウェブアプリ」としてデプロイすると、予約システムから
 * 予約確定と同時にGoogleカレンダーへ予定が自動作成されます。
 *
 * 詳しい手順: リポジトリの docs/google-calendar-setup.md を参照
 */

// 予定を入れるカレンダー。'' ならメインカレンダー（デフォルト）
const CALENDAR_ID = '';

// 予約システム側の環境変数 GCAL_WEBHOOK_TOKEN と同じ値を設定すると
// 第三者からの偽リクエストを拒否できる。'' なら照合しない。
const SHARED_TOKEN = '';

function doPost(e) {
  try {
    const data = JSON.parse(e.postData.contents);

    if (SHARED_TOKEN && data.token !== SHARED_TOKEN) {
      return json_({ ok: false, error: 'invalid token' });
    }

    if (data.action === 'create') return createEvent_(data);
    if (data.action === 'cancel') return cancelEvent_(data);
    return json_({ ok: false, error: 'unknown action: ' + data.action });
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  }
}

function getCalendar_() {
  if (CALENDAR_ID) {
    const cal = CalendarApp.getCalendarById(CALENDAR_ID);
    if (cal) return cal;
  }
  return CalendarApp.getDefaultCalendar();
}

/** タイトルにこの予約番号（例: 予約No.14）が含まれるか。No.1 と No.14 を混同しない */
function hasReservationNo_(title, id) {
  const m = String(title).match(/予約No\.(\d+)/);
  return !!m && m[1] === String(id);
}

function createEvent_(d) {
  const cal = getCalendar_();
  const start = new Date(d.date + 'T' + d.time + ':00+09:00');
  const end = new Date(start.getTime() + Number(d.duration || 45) * 60000);

  // 同じ予約番号の予定が既にあれば作らない（重複防止）
  const dayStart = new Date(start.getTime() - 24 * 3600 * 1000);
  const dayEnd = new Date(end.getTime() + 24 * 3600 * 1000);
  const dup = cal.getEvents(dayStart, dayEnd).filter(function (ev) {
    return hasReservationNo_(ev.getTitle(), d.reservation_id);
  });
  if (dup.length > 0) {
    return json_({ ok: true, skipped: 'duplicate', count: dup.length });
  }

  const title = '予約No.' + d.reservation_id + ' ' + d.customer_name + '様（' +
    d.service_label + Number(d.duration || 45) + '分）';
  const description =
    'お名前: ' + d.customer_name + ' 様\n' +
    '電話番号: ' + (d.customer_phone || '') + '\n' +
    '区分: ' + d.service_label + '（' + Number(d.duration || 45) + '分）\n' +
    'ご要望: ' + (d.customer_note || '（なし）') + '\n' +
    'Web予約システムから自動作成';

  const ev = cal.createEvent(title, start, end, { description: description });
  return json_({ ok: true, event_id: ev.getId() });
}

function cancelEvent_(d) {
  const cal = getCalendar_();
  // 今日から90日先までの予定から、該当の予約番号を含む予定だけ削除する
  const now = new Date();
  const until = new Date(now.getTime() + 90 * 24 * 3600 * 1000);
  const targets = cal.getEvents(now, until).filter(function (ev) {
    return hasReservationNo_(ev.getTitle(), d.reservation_id);
  });
  targets.forEach(function (ev) { ev.deleteEvent(); });
  return json_({ ok: true, deleted: targets.length });
}

function json_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * 動作テスト用: エディタ上でこの関数を選んで「実行」すると、
 * 明日10:00にテスト予定が作られます（初回実行時にカレンダーへの
 * アクセス許可を求められるので許可してください）。
 * テスト後は カレンダーから「予約No.99999」の予定を削除してください。
 */
function testCreate() {
  const tomorrow = new Date(Date.now() + 24 * 3600 * 1000);
  const y = tomorrow.getFullYear();
  const m = ('0' + (tomorrow.getMonth() + 1)).slice(-2);
  const day = ('0' + tomorrow.getDate()).slice(-2);
  const result = createEvent_({
    reservation_id: 99999,
    customer_name: 'テスト',
    customer_phone: '000-0000-0000',
    customer_note: '連携テスト',
    date: y + '-' + m + '-' + day,
    time: '10:00',
    duration: 45,
    service_label: 'きしもとカラダ整体',
  });
  Logger.log(result.getContent());
}
