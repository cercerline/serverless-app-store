/**
 * Pre-publication screening.
 *
 * This is **triage, not antivirus.** It applies deterministic rules to facts that
 * can be verified from the uploaded file itself — declared permissions, whether a
 * signature block exists, and tell-tale strings in the bytecode. It reliably
 * catches policy violations (an app that asks for network access when the site
 * forbids it) and it surfaces suspicious patterns for a human to look at.
 *
 * It does **not** detect novel malware. A determined attacker can hide behaviour
 * behind obfuscation or dynamic loading that no string scan will see. Treat a
 * "pass" as "no known reason to worry", never as "verified safe".
 */

export interface ScreeningInput {
  kind: string;
  /** Permissions parsed **server-side** from the APK, not taken from the client. */
  permissions: string[];
  packageName: string | null;
  apkSize: number | null;
  /** Whether the archive carries a signature block. */
  signed: boolean | null;
  /** Suspicious bytecode strings, only populated when the scan ran. */
  dexFindings?: string[];
  /**
   * Permissions the submitter claimed. A mismatch against the server-parsed set
   * means the metadata was fabricated, which is itself a strong signal.
   */
  claimedPermissions?: string[];
}

export interface ScreeningResult {
  decision: "pass" | "flag" | "block";
  /** Human-readable reasons the submission cannot be published. */
  blockers: string[];
  /** Human-readable reasons a human should look before approving. */
  warnings: string[];
  /** 0–100; higher means more reasons for concern. Purely advisory. */
  riskScore: number;
  /** The authoritative permission list the screen observed. */
  observedPermissions: string[];
}

// ------------------------------------------------------------------- policy

/**
 * Permissions that grant a capability the site refuses to distribute.
 *
 * `INTERNET` is the only permission that actually grants network access on
 * Android — the platform enforces it with a kernel-level group id, so an app
 * without it genuinely cannot open a socket. `ACCESS_NETWORK_STATE` and
 * `ACCESS_WIFI_STATE` only let an app *observe* connectivity, so they are
 * reported but not blocked.
 */
export const DEFAULT_BLOCKED_PERMISSIONS = ["INTERNET"];

/** Where the blocked list comes from: config, else the default. */
export function blockedPermissions(): string[] {
  const configured = process.env.BLOCKED_PERMISSIONS?.trim();
  if (configured === undefined) return DEFAULT_BLOCKED_PERMISSIONS;
  if (configured === "") return []; // explicitly disabled
  return configured
    .split(",")
    .map((p) => p.trim().toUpperCase())
    .filter(Boolean);
}

/** Matches anything that touches networking, for reporting and warning. */
export const NETWORK_PERMISSIONS =
  /(^|\.)(INTERNET|ACCESS_NETWORK_STATE|ACCESS_WIFI_STATE|CHANGE_NETWORK_STATE|CHANGE_WIFI_STATE)$/i;

/** Normalises `android.permission.INTERNET` and `INTERNET` to the same key. */
export function normalizePermission(permission: string): string {
  return permission.trim().replace(/^android\.permission\./i, "").toUpperCase();
}

/**
 * Permissions that make an app worth a closer look.
 *
 * None of these are malicious on their own — a legitimate app may need the
 * camera — but each is heavily abused, so their presence raises the score and
 * asks a human to confirm the app's stated purpose matches what it asks for.
 */
const RISKY_PERMISSIONS: Array<{ match: RegExp; weight: number; label: string }> = [
  { match: /^SEND_SMS$/i, weight: 35, label: "发送短信（可能被用于扣费）" },
  { match: /^RECEIVE_SMS$/i, weight: 30, label: "接收短信（可截获验证码）" },
  { match: /^READ_SMS$/i, weight: 30, label: "读取短信（可窃取验证码）" },
  { match: /^CALL_PHONE$/i, weight: 15, label: "直接拨打电话" },
  { match: /^READ_CONTACTS$|^WRITE_CONTACTS$/i, weight: 20, label: "读写通讯录" },
  { match: /^RECORD_AUDIO$/i, weight: 20, label: "录音" },
  { match: /^CAMERA$/i, weight: 12, label: "使用相机" },
  { match: /^ACCESS_BACKGROUND_LOCATION$/i, weight: 30, label: "后台定位" },
  { match: /^ACCESS_FINE_LOCATION$/i, weight: 15, label: "精确定位" },
  { match: /^REQUEST_INSTALL_PACKAGES$/i, weight: 40, label: "安装其他应用（常见于恶意软件）" },
  { match: /^SYSTEM_ALERT_WINDOW$/i, weight: 30, label: "悬浮窗（可做界面覆盖攻击）" },
  { match: /^BIND_ACCESSIBILITY_SERVICE$/i, weight: 40, label: "无障碍服务（木马最常滥用的权限）" },
  { match: /^BIND_DEVICE_ADMIN$/i, weight: 35, label: "设备管理器权限" },
  { match: /^MANAGE_EXTERNAL_STORAGE$/i, weight: 25, label: "完全访问存储" },
  { match: /^READ_EXTERNAL_STORAGE$|^WRITE_EXTERNAL_STORAGE$/i, weight: 10, label: "读写外部存储" },
  { match: /^QUERY_ALL_PACKAGES$/i, weight: 12, label: "查看所有已安装应用" },
  { match: /^RECEIVE_BOOT_COMPLETED$/i, weight: 10, label: "开机自启" },
  { match: /^FOREGROUND_SERVICE$/i, weight: 8, label: "常驻前台服务" },
  { match: /^READ_PHONE_STATE$|^READ_PHONE_NUMBERS$/i, weight: 15, label: "读取电话状态" },
  { match: /^GET_ACCOUNTS$/i, weight: 20, label: "读取设备账号" },
];

/**
 * Bytecode strings that indicate a capability worth investigating.
 *
 * These are class and method names that appear in the DEX string table. They are
 * legitimate in some apps (a plugin host really does use `DexClassLoader`), so
 * they raise the score rather than blocking.
 */
export const SUSPICIOUS_DEX_PATTERNS: Array<{ pattern: RegExp; weight: number; label: string }> = [
  { pattern: /DexClassLoader|InMemoryDexClassLoader|PathClassLoader/, weight: 25, label: "动态加载代码（可绕过静态检测）" },
  { pattern: /Ldalvik\/system\/BaseDexClassLoader/, weight: 20, label: "自定义类加载器" },
  { pattern: /Runtime;->exec|Ljava\/lang\/ProcessBuilder/, weight: 25, label: "执行系统命令" },
  { pattern: /\/system\/bin\/su|\/system\/xbin\/su|magisk/i, weight: 40, label: "尝试获取 root 权限" },
  { pattern: /setComponentEnabledSetting/, weight: 20, label: "动态隐藏/显示组件（可隐藏图标）" },
  { pattern: /Landroid\/telephony\/SmsManager/, weight: 25, label: "发送短信的底层接口" },
  { pattern: /android\/provider\/Settings\$Secure/, weight: 20, label: "修改系统安全设置" },
  { pattern: /AccessibilityService/, weight: 20, label: "无障碍服务" },
  { pattern: /MediaProjection|createScreenCaptureIntent/, weight: 20, label: "屏幕录制/截屏" },
  { pattern: /getDeviceId|getImei|getSubscriberId/, weight: 25, label: "读取设备唯一标识" },
  { pattern: /Landroid\/content\/pm\/PackageInstaller/, weight: 25, label: "静默安装应用" },
  { pattern: /http:\/\/(\d{1,3}\.){3}\d{1,3}/, weight: 20, label: "硬编码 IP 地址的明文 HTTP 请求" },
];

// ------------------------------------------------------------------- scoring

function asSet(permissions: string[]): Set<string> {
  return new Set(permissions.map(normalizePermission).filter(Boolean));
}

/**
 * Applies the rules and returns a decision.
 *
 * `block` is reserved for a violated policy or a fabricated submission — things
 * that are unambiguous. Everything else that looks off becomes `flag`, so the
 * administrator sees the reason next to the approve button instead of the
 * submission silently disappearing.
 */
export function screenSubmission(input: ScreeningInput): ScreeningResult {
  const blockers: string[] = [];
  const warnings: string[] = [];
  let risk = 0;

  const observed = [...asSet(input.permissions)];
  const blocked = blockedPermissions();

  // ---------------------------------------------------------- policy: network
  if (blocked.length > 0) {
    const violations = observed.filter((p) => blocked.includes(p));
    if (violations.length > 0) {
      blockers.push(
        `本站不接受需要联网的应用，但该 APK 声明了：${violations.join(", ")}。` +
          `这是 Android 上唯一能真正发起网络请求的权限，去掉后重新打包即可提交。`,
      );
      risk += 100;
    }
    // Observing connectivity without being able to use it is unusual; worth a look.
    const observers = observed.filter(
      (p) => NETWORK_PERMISSIONS.test(p) && !blocked.includes(p),
    );
    if (observers.length > 0) {
      warnings.push(`声明了网络状态类权限（${observers.join(", ")}），但未声明联网权限，请确认用途。`);
      risk += 10;
    }
  }

  // ------------------------------------------------------------- file sanity
  if (!input.apkSize || input.apkSize <= 0) {
    blockers.push("没有检测到应用文件，无法发布。");
    risk += 100;
  }

  if (input.kind === "apk" && !input.packageName) {
    warnings.push("未能从 APK 中读出包名，文件可能不完整或已损坏。");
    risk += 30;
  }

  // ------------------------------------------------------------- permissions
  for (const permission of observed) {
    for (const rule of RISKY_PERMISSIONS) {
      if (rule.match.test(permission)) {
        warnings.push(`申请了敏感权限：${rule.label}（${permission}）`);
        risk += rule.weight;
        break;
      }
    }
  }

  // ------------------------------------------------------- metadata integrity
  if (input.claimedPermissions && input.claimedPermissions.length > 0) {
    const claimed = asSet(input.claimedPermissions);
    const missing = observed.filter((p) => !claimed.has(p));
    if (missing.length > 0) {
      warnings.push(
        `提交的权限清单与实际文件不符，文件里还有：${missing.slice(0, 8).join(", ")}` +
          `${missing.length > 8 ? ` 等 ${missing.length} 项` : ""}。以文件为准。`,
      );
      risk += 45;
    }
  }

  // --------------------------------------------------------------- signature
  if (input.kind === "apk" && input.signed === false) {
    warnings.push("APK 未包含签名块，正常渠道无法安装，请确认文件来源。");
    risk += 30;
  }

  // --------------------------------------------------------------- bytecode
  for (const finding of input.dexFindings ?? []) {
    warnings.push(`代码中发现：${finding}`);
    const rule = SUSPICIOUS_DEX_PATTERNS.find((r) => r.label === finding);
    risk += rule?.weight ?? 15;
  }

  const decision: ScreeningResult["decision"] =
    blockers.length > 0 ? "block" : warnings.length > 0 ? "flag" : "pass";

  return {
    decision,
    blockers,
    warnings,
    riskScore: Math.min(100, risk),
    observedPermissions: observed,
  };
}

/** One-line summary for the review queue. */
export function summarizeScreening(result: ScreeningResult): string {
  if (result.decision === "block") return `自动拦截：${result.blockers[0]}`;
  if (result.decision === "flag") return `需人工确认（风险分 ${result.riskScore}）：${result.warnings[0]}`;
  return "自动初筛通过";
}
