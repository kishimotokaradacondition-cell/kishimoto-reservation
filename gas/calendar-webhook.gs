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

  // オンラインカウンセリング整体はGoogle Meetのリンク付きで予定を作り、
  // 発行されたMeetのURLを予約システムに返す（確認メールに記載される）
  if (d.service === 'online') {
    try {
      const meetUrl = createEventWithMeet_(title, description, start, end, d);
      return json_({ ok: true, meet_url: meetUrl });
    } catch (err) {
      // Calendar API（拡張サービス）が未設定などで失敗した場合は
      // Meetなしの通常予定を作成する（予約自体は落とさない）
      const ev = cal.createEvent(title, start, end, { description: description });
      return json_({ ok: true, event_id: ev.getId(), meet_url: '',
                     meet_error: String(err) });
    }
  }

  const ev = cal.createEvent(title, start, end, { description: description });
  return json_({ ok: true, event_id: ev.getId() });
}

/**
 * Google Meet付きの予定を作成してMeetのURLを返す。
 *
 * ※事前設定が必要: Apps Scriptエディタ左側の「サービス +」から
 * 「Google Calendar API」を追加しておくこと（識別子: Calendar）。
 * 追加していないとこの関数は失敗し、Meetなしの予定にフォールバックする。
 */
function createEventWithMeet_(title, description, start, end, d) {
  const calId = CALENDAR_ID || 'primary';
  const event = {
    summary: title,
    description: description,
    start: { dateTime: start.toISOString() },
    end:   { dateTime: end.toISOString() },
    conferenceData: {
      createRequest: {
        requestId: 'reservation-' + d.reservation_id + '-' + Date.now(),
        conferenceSolutionKey: { type: 'hangoutsMeet' },
      },
    },
  };
  // お客様のメールアドレスをゲストに追加すると、Googleからも
  // Meetリンク入りの招待メールが届く（確認メールの保険になる）
  if (d.customer_email) {
    event.attendees = [{ email: d.customer_email }];
  }
  const created = Calendar.Events.insert(event, calId, {
    conferenceDataVersion: 1,
    sendUpdates: d.customer_email ? 'all' : 'none',
  });
  return created.hangoutLink || '';
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

/**
 * オンラインカウンセリング整体（Google Meet付き）の動作テスト用。
 * 実行前に「サービス +」から Google Calendar API を追加しておくこと。
 * 実行するとログに meet_url が出ます。URLが空なら meet_error を確認。
 * テスト後は カレンダーから「予約No.99998」の予定を削除してください。
 */
function testCreateOnline() {
  const tomorrow = new Date(Date.now() + 24 * 3600 * 1000);
  const y = tomorrow.getFullYear();
  const m = ('0' + (tomorrow.getMonth() + 1)).slice(-2);
  const day = ('0' + tomorrow.getDate()).slice(-2);
  const result = createEvent_({
    reservation_id: 99998,
    customer_name: 'オンラインテスト',
    customer_phone: '000-0000-0000',
    customer_note: 'Meet連携テスト',
    date: y + '-' + m + '-' + day,
    time: '21:00',
    duration: 30,
    service: 'online',
    service_label: 'オンラインカウンセリング整体',
  });
  Logger.log(result.getContent());
}
