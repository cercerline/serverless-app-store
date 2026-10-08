/** Shared presentation helpers. */

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || Number.isNaN(bytes)) return "—";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`;
}

export function formatDate(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

/** Turns an Android permission constant into something readable. */
export function formatPermission(permission: string): string {
  const known: Record<string, string> = {
    INTERNET: "网络访问",
    ACCESS_NETWORK_STATE: "查看网络状态",
    ACCESS_WIFI_STATE: "查看 Wi-Fi 状态",
    CAMERA: "相机",
    RECORD_AUDIO: "录音",
    READ_CONTACTS: "读取联系人",
    WRITE_CONTACTS: "修改联系人",
    ACCESS_FINE_LOCATION: "精确位置",
    ACCESS_COARSE_LOCATION: "大致位置",
    ACCESS_BACKGROUND_LOCATION: "后台位置",
    READ_EXTERNAL_STORAGE: "读取存储",
    WRITE_EXTERNAL_STORAGE: "写入存储",
    READ_MEDIA_IMAGES: "读取图片",
    READ_MEDIA_VIDEO: "读取视频",
    READ_MEDIA_AUDIO: "读取音频",
    POST_NOTIFICATIONS: "发送通知",
    VIBRATE: "振动",
    WAKE_LOCK: "保持唤醒",
    RECEIVE_BOOT_COMPLETED: "开机自启",
    FOREGROUND_SERVICE: "前台服务",
    BLUETOOTH: "蓝牙",
    BLUETOOTH_CONNECT: "蓝牙连接",
    NFC: "NFC",
    CALL_PHONE: "拨打电话",
    READ_PHONE_STATE: "读取电话状态",
    SEND_SMS: "发送短信",
    READ_SMS: "读取短信",
    SYSTEM_ALERT_WINDOW: "悬浮窗",
    REQUEST_INSTALL_PACKAGES: "安装应用",
    QUERY_ALL_PACKAGES: "查看已安装应用",
  };
  return known[permission] ?? permission;
}

/** Media URL for an app asset, served by the media route. */
export function mediaUrl(slug: string, asset: string): string {
  return `/api/media/${encodeURIComponent(slug)}/${asset}`;
}

/** Placeholder shown when an app has no icon. */
export function initialsFor(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return "?";
  // Use the first character for CJK names, the first two for Latin names.
  if (/[\u4e00-\u9fa5]/.test(trimmed[0])) return trimmed.slice(0, 1);
  const words = trimmed.split(/\s+/).filter(Boolean);
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  return trimmed.slice(0, 2).toUpperCase();
}

/**
 * Builds the filename a visitor's browser will save, e.g. `我的应用-v1.2.3.apk`.
 *
 * Downloads redirect straight to object storage, so there is no
 * `Content-Disposition` to set on the way out — the object key is the filename.
 * This is why the key is built from the app name rather than the local file name.
 */
export function buildApkFilename(appName: string, versionName: string | null): string {
  const unsafe = /[\\/:*?"<>|\u0000-\u001f]/g;
  const base = (appName || "app").trim().replace(unsafe, "-").slice(0, 60).trim() || "app";
  const version = versionName
    ? `-v${versionName.trim().replace(unsafe, "-").slice(0, 24)}`
    : "";
  return `${base}${version}.apk`;
}

/**
 * The filename a visitor's browser should save, for either kind of app.
 *
 * Object keys are generated and unreadable (`html/env-admin/pomodoro-muv99egh.html`),
 * so without this the visitor receives a file they cannot identify. HTML uploads
 * keep an `.html` extension rather than being handed out as an `.apk`.
 */
export function buildDownloadName(app: {
  name: string;
  kind?: string | null;
  version_name?: string | null;
}): string {
  if (app.kind === "html") {
    const unsafe = /[\\/:*?"<>|\u0000-\u001f]/g;
    const base = (app.name || "app").trim().replace(unsafe, "-").slice(0, 60).trim() || "app";
    return `${base}.html`;
  }
  return buildApkFilename(app.name, app.version_name ?? null);
}
