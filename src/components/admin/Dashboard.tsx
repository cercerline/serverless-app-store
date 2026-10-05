"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { AppRecord, AppStatus } from "@/lib/db";
import { buildApkFilename, formatBytes, initialsFor, mediaUrl } from "@/lib/format";
import { inspectApk, uploadWithRetry, type BrowserApkResult } from "@/lib/browser-apk";
import { deleteJsonWithRetry, postJsonWithRetry } from "@/lib/net";
import { StatusBadge } from "./StatusBadge";

interface DashboardProps {
  initialApps: AppRecord[];
  loadError: string | null;
  databaseReady: boolean;
  storageReady: boolean;
  username: string;
  /**
   * `admin` may set visibility and ordering directly; `user` submissions always
   * land in the review queue. The server enforces the same rule, so this only
   * decides what the form offers.
   */
  mode: "admin" | "user";
  /** Maximum apps this account may submit, shown as guidance. */
  quota?: number;
  /**
   * Permissions this site refuses. Checked in the browser for instant feedback;
   * the server re-reads the file and enforces the same list authoritatively.
   */
  blockedPermissions?: string[];
}

/** Editable shape of the form; mirrors the API payload. */
interface FormState {
  id: number | null;
  name: string;
  slug: string;
  package_name: string;
  version_name: string;
  version_code: string;
  /** `apk` or `html`; controls which fields and upload rules apply. */
  kind: "apk" | "html";
  summary: string;
  description: string;
  category: string;
  icon_key: string;
  apk_key: string;
  apk_size: number | null;
  apk_sha256: string;
  min_sdk: string;
  target_sdk: string;
  permissions: string[];
  screenshots: string[];
  status: AppStatus;
  sort_order: string;
  /** Affirmation of the terms; required for a non-admin submission. */
  termsAccepted: boolean;
}

const EMPTY_FORM: FormState = {
  id: null,
  name: "",
  slug: "",
  package_name: "",
  version_name: "",
  version_code: "",
  kind: "apk",
  summary: "",
  description: "",
  category: "",
  icon_key: "",
  apk_key: "",
  apk_size: null,
  apk_sha256: "",
  min_sdk: "",
  target_sdk: "",
  permissions: [],
  screenshots: [],
  status: "pending",
  sort_order: "0",
  termsAccepted: false,
};

function toForm(app: AppRecord): FormState {
  return {
    id: app.id,
    name: app.name,
    slug: app.slug,
    package_name: app.package_name ?? "",
    version_name: app.version_name ?? "",
    version_code: app.version_code === null ? "" : String(app.version_code),
    kind: app.kind === "html" ? "html" : "apk",
    summary: app.summary ?? "",
    description: app.description ?? "",
    category: app.category ?? "",
    icon_key: app.icon_key ?? "",
    apk_key: app.apk_key ?? "",
    apk_size: app.apk_size,
    apk_sha256: app.apk_sha256 ?? "",
    min_sdk: app.min_sdk === null ? "" : String(app.min_sdk),
    target_sdk: app.target_sdk === null ? "" : String(app.target_sdk),
    permissions: app.permissions ?? [],
    screenshots: app.screenshots ?? [],
    status: app.status,
    sort_order: String(app.sort_order ?? 0),
    termsAccepted: false,
  };
}

type UploadStatus = { phase: "idle" | "parsing" | "uploading" | "done" | "error"; message: string; progress: number };

const IDLE_UPLOAD: UploadStatus = { phase: "idle", message: "", progress: 0 };

export function AdminDashboard({
  initialApps,
  loadError,
  databaseReady,
  storageReady,
  username,
  mode,
  quota,
  blockedPermissions = [],
}: DashboardProps) {
  const isAdmin = mode === "admin";

  /**
   * Policy violations found in the browser, so the submitter learns immediately
   * instead of after a round trip. The server repeats this check against the
   * stored file, which is what actually decides.
   */
  const [policyIssues, setPolicyIssues] = useState<string[]>([]);
  const router = useRouter();
  const [apps, setApps] = useState<AppRecord[]>(initialApps);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [upload, setUpload] = useState<UploadStatus>(IDLE_UPLOAD);
  const [apkInfo, setApkInfo] = useState<BrowserApkResult | null>(null);
  const [iconPreview, setIconPreview] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /**
   * Slug the currently edited row is stored under. Icon and screenshot URLs are
   * keyed by slug, so previews must use the *saved* slug rather than `form.slug`,
   * which the admin may have retyped without saving yet.
   */
  const [savedSlug, setSavedSlug] = useState<string>("");
  /**
   * Object URLs for screenshots uploaded in this session, keyed by storage key.
   * They let newly added images preview immediately, before the app has a slug
   * for the index-based media route to resolve against.
   */
  const [shotPreviews, setShotPreviews] = useState<Record<string, string>>({});
  const apkInput = useRef<HTMLInputElement>(null);
  const iconInput = useRef<HTMLInputElement>(null);
  const shotInput = useRef<HTMLInputElement>(null);

  const editing = form.id !== null;

  const set = useCallback(<K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm((previous) => ({ ...previous, [key]: value }));
  }, []);

  function resetForm() {
    setForm(EMPTY_FORM);
    setSavedSlug("");
    setApkInfo(null);
    setIconPreview(null);
    setShotPreviews((previous) => {
      // Release the object URLs so their blobs can be collected.
      for (const url of Object.values(previous)) URL.revokeObjectURL(url);
      return {};
    });
    setFormError(null);
    setPolicyIssues([]);
    setUpload(IDLE_UPLOAD);
    if (apkInput.current) apkInput.current.value = "";
    if (iconInput.current) iconInput.current.value = "";
    if (shotInput.current) shotInput.current.value = "";
  }

  /** Requests a presigned URL and uploads a blob directly to object storage. */
  async function uploadBlob(
    blob: Blob,
    filename: string,
    kind: "apk" | "html" | "icon" | "screenshot",
    onProgress?: (fraction: number) => void,
  ): Promise<{ key: string; publicUrl: string | null }> {
    // Both hops retry: this link to the server and to object storage drops
    // intermittently, and one dropped request used to abort the whole upload.
    const presigned = await postJsonWithRetry<{
      key: string;
      url: string;
      method?: string;
      contentType?: string;
      publicUrl?: string | null;
    }>("/api/apps/presign", { kind, filename, size: blob.size }, { label: "获取上传地址" });

    if (!presigned.url || !presigned.key) {
      throw new Error("获取上传地址失败：服务器未返回有效的上传地址。");
    }

    await uploadWithRetry(presigned.url, blob, {
      method: presigned.method ?? "PUT",
      contentType: presigned.contentType,
      onProgress,
      onRetry: (attempt, total) => {
        onProgress?.(0);
        setUpload((previous) => ({
          ...previous,
          phase: "uploading",
          message: `上传中断，正在重试（第 ${attempt + 1}/${total} 次）…`,
        }));
      },
    });

    return { key: presigned.key, publicUrl: presigned.publicUrl ?? null };
  }

  /**
   * Handles the selected payload file.
   *
   * For APKs the archive is parsed locally first (package name, version,
   * permissions, launcher icon), then uploaded. For HTML bundles there is
   * nothing to parse, so the file is uploaded directly.
   */
  async function handlePayloadSelected(file: File) {
    setFormError(null);
    setNotice(null);

    if (!storageReady) {
      setUpload({
        phase: "error",
        message: "未配置对象存储（R2），无法上传文件。请先完成 R2 环境变量配置。",
        progress: 0,
      });
      return;
    }

    const isApk = /\.(apk|apks|xapk)$/i.test(file.name);

    // An APK uploaded while "Web 应用" is selected would produce a broken entry,
    // so keep the two in sync instead of silently storing a mismatch.
    if (isApk && form.kind !== "apk") set("kind", "apk");
    if (!isApk && form.kind !== "html") set("kind", "html");

    try {
      let result: BrowserApkResult | null = null;

      if (isApk) {
        setUpload({ phase: "parsing", message: "正在读取并解析 APK 信息…", progress: 0 });

        // Reading a File can fail before any network call — for example when the
        // file sits on a cloud-synced folder, a removable drive, or was moved
        // after being picked. The browser then reports a bare "Failed to fetch",
        // which is meaningless to a user, so translate it into something
        // actionable and name the likely remedy.
        try {
          result = await inspectApk(file);
        } catch (readError) {
          const detail = readError instanceof Error ? readError.message : String(readError);
          throw new Error(
            `无法读取这个 APK 文件（${detail}）。` +
              `请确认：① 文件已完整下载、未损坏；② 文件位于本机磁盘（不要放在网盘同步目录、移动硬盘或网络位置）；` +
              `③ 文件没有被其他程序占用。然后把文件复制到桌面再试一次。`,
          );
        }
        setApkInfo(result);

        // Instant policy feedback from the permissions the parser just read.
        if (blockedPermissions.length > 0) {
          const declared = (result.metadata.permissions ?? []).map((p) =>
            p.trim().replace(/^android\.permission\./i, "").toUpperCase(),
          );
          const violations = declared.filter((p) => blockedPermissions.includes(p));
          setPolicyIssues(
            violations.length > 0
              ? [
                  `这个 APK 声明了本站不允许的权限：${violations.join(", ")}。`,
                  `本站不接受需要联网的应用。请去掉该权限后重新打包再上传。`,
                ]
              : [],
          );
        }

        // Prefill only empty fields so a re-upload does not clobber manual edits.
        setForm((previous) => ({
          ...previous,
          kind: "apk",
          name: previous.name || result!.metadata.appName || file.name.replace(/\.apk$/i, ""),
          package_name: previous.package_name || result!.metadata.packageName || "",
          version_name: previous.version_name || result!.metadata.versionName || "",
          version_code:
            previous.version_code ||
            (result!.metadata.versionCode === null ? "" : String(result!.metadata.versionCode)),
          min_sdk:
            previous.min_sdk ||
            (result!.metadata.minSdkVersion === null ? "" : String(result!.metadata.minSdkVersion)),
          target_sdk:
            previous.target_sdk ||
            (result!.metadata.targetSdkVersion === null
              ? ""
              : String(result!.metadata.targetSdkVersion)),
          permissions:
            previous.permissions.length > 0 ? previous.permissions : result!.metadata.permissions,
          apk_size: file.size,
          apk_sha256: result!.sha256 || previous.apk_sha256,
        }));

        if (result.icon) {
          const blob = new Blob([result.icon.bytes as unknown as BlobPart], {
            type: result.icon.mime,
          });
          setIconPreview(URL.createObjectURL(blob));
        }
      } else {
        setUpload({ phase: "uploading", message: "正在上传文件…", progress: 0 });
        setForm((previous) => ({
          ...previous,
          kind: "html",
          name: previous.name || file.name.replace(/\.(html?|zip)$/i, ""),
          apk_size: file.size,
        }));
      }

      // Name the stored object after the app rather than the local file, because
      // downloads now redirect straight to object storage and the object key is
      // what the visitor's browser offers as the saved filename.
      const downloadName = isApk
        ? buildApkFilename(
            result?.metadata.appName ?? form.name ?? file.name.replace(/\.apk$/i, ""),
            result?.metadata.versionName ?? null,
          )
        : file.name;

      const uploaded = await uploadBlob(
        file,
        downloadName,
        isApk ? "apk" : "html",
        (fraction) => {
          setUpload({
            phase: "uploading",
            message: `正在上传… ${Math.round(fraction * 100)}%`,
            progress: fraction,
          });
        },
      );

      // Upload the extracted launcher icon alongside the APK, if we found one.
      let iconKey = form.icon_key;
      if (result?.icon) {
        try {
          const blob = new Blob([result.icon.bytes as unknown as BlobPart], { type: result.icon.mime });
          const extension = result.icon.path.split(".").pop()?.toLowerCase() || "png";
          const iconUpload = await uploadBlob(blob, `icon-${Date.now()}.${extension}`, "icon");
          iconKey = iconUpload.key;
        } catch {
          // A missing icon is recoverable: the admin can upload one manually.
        }
      }

      setForm((previous) => ({ ...previous, apk_key: uploaded.key, icon_key: iconKey }));

      if (!result) {
        setUpload({
          phase: "done",
          message: "文件已上传。请补充应用名称与图标后保存。",
          progress: 1,
        });
        return;
      }

      const warnings = result.metadata.warnings;
      setUpload({
        phase: "done",
        message: warnings.length
          ? `APK 已上传，但有 ${warnings.length} 项未能自动识别，请检查下方字段。`
          : "APK 已上传，信息已自动填入。",
        progress: 1,
      });
      if (warnings.length) setNotice(warnings.join("；"));
    } catch (error) {
      setUpload({
        phase: "error",
        message: error instanceof Error ? error.message : "上传失败。",
        progress: 0,
      });
    }
  }

  async function handleIconSelected(file: File) {
    setFormError(null);
    try {
      setIconPreview(URL.createObjectURL(file));
      const uploaded = await uploadBlob(file, file.name, "icon");
      set("icon_key", uploaded.key);
    } catch (error) {
      setFormError(error instanceof Error ? error.message : "图标上传失败。");
    }
  }

  async function handleScreenshotsSelected(files: FileList) {
    setFormError(null);
    try {
      const keys: string[] = [];
      const previews: Record<string, string> = {};
      for (const file of Array.from(files).slice(0, 10)) {
        const uploaded = await uploadBlob(file, file.name, "screenshot");
        keys.push(uploaded.key);
        // Keep a local preview so the thumbnail shows before the app is saved.
        previews[uploaded.key] = URL.createObjectURL(file);
      }
      setShotPreviews((previous) => ({ ...previous, ...previews }));
      setForm((previous) => ({
        ...previous,
        screenshots: [...previous.screenshots, ...keys],
      }));
    } catch (error) {
      setFormError(error instanceof Error ? error.message : "截图上传失败。");
    }
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    setFormError(null);

    try {
      const data = await postJsonWithRetry<{
        app?: AppRecord;
        pending?: boolean;
        error?: string;
      }>(
        "/api/apps",
        {
          ...form,
          version_code: form.version_code || null,
          min_sdk: form.min_sdk || null,
          target_sdk: form.target_sdk || null,
          sort_order: form.sort_order || "0",
          // Only an administrator may influence visibility; the server ignores
          // this field for everyone else.
          status: isAdmin ? form.status : undefined,
        },
        { label: "保存应用" },
      );

      if (!data.app) {
        setFormError(data.error || "保存失败：服务器未返回应用信息。");
        return;
      }

      setApps((previous) => {
        const others = previous.filter((item) => item.id !== data.app!.id);
        return [data.app!, ...others];
      });
      setNotice(
        data.app.status === "pending"
          ? `已提交：${data.app.name} —— 等待管理员审核，通过后会出现在应用库中。`
          : `已保存：${data.app.name}`,
      );
      resetForm();
      router.refresh();
    } catch (error) {
      setFormError(error instanceof Error ? error.message : "保存失败。");
    } finally {
      setSaving(false);
    }
  }

  async function remove(app: AppRecord) {
    if (!window.confirm(`确定要删除「${app.name}」吗？该操作会同时删除已上传的 APK 与图片，且不可撤销。`)) {
      return;
    }
    try {
      await deleteJsonWithRetry<{ ok?: boolean }>(
        "/api/apps",
        { id: app.id },
        { label: "删除应用" },
      );

      setApps((previous) => previous.filter((item) => item.id !== app.id));
      setNotice(`已删除：${app.name}`);
      if (form.id === app.id) resetForm();
      router.refresh();
    } catch (error) {
      setFormError(error instanceof Error ? error.message : "删除失败。");
    }
  }

  async function logout() {
    await fetch("/api/admin/logout", { method: "POST" });
    router.replace("/admin/login");
    router.refresh();
  }

  const permissionText = useMemo(() => form.permissions.join("\n"), [form.permissions]);

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            {isAdmin ? "管理后台" : "我的应用"}
          </h1>
          <p className="mt-1 text-sm text-slate-400">
            已登录为 <span className="text-slate-200">{username}</span> · 共 {apps.length} 个应用
            {editing ? ` · 正在编辑 #${form.id}` : ""}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {editing ? (
            <button
              type="button"
              onClick={resetForm}
              className="rounded-xl border border-white/10 px-4 py-2 text-sm text-slate-300 transition hover:border-white/20 hover:text-white"
            >
              取消编辑
            </button>
          ) : null}
          <button
            type="button"
            onClick={logout}
            className="rounded-xl border border-white/10 px-4 py-2 text-sm text-slate-300 transition hover:border-red-500/40 hover:text-red-200"
          >
            退出登录
          </button>
        </div>
      </header>

      {!databaseReady ? (
        <div className="rounded-2xl border border-amber-500/30 bg-amber-500/5 p-5 text-sm text-amber-100/90">
          <p className="font-semibold text-amber-200">未配置数据库</p>
          <p className="mt-1">
            请设置环境变量 <code className="rounded bg-black/30 px-1 font-mono text-xs">DATABASE_URL</code>
            （Neon / Vercel Postgres 连接串）后重新部署。
          </p>
        </div>
      ) : null}

      {!storageReady ? (
        <div className="rounded-2xl border border-amber-500/30 bg-amber-500/5 p-5 text-sm text-amber-100/90">
          <p className="font-semibold text-amber-200">未配置对象存储（R2）</p>
          <p className="mt-1">
            缺少 R2 环境变量时无法上传 APK 与图片。请设置
            <code className="mx-1 rounded bg-black/30 px-1 font-mono text-xs">R2_ACCOUNT_ID</code>、
            <code className="mx-1 rounded bg-black/30 px-1 font-mono text-xs">R2_ACCESS_KEY_ID</code>、
            <code className="mx-1 rounded bg-black/30 px-1 font-mono text-xs">R2_SECRET_ACCESS_KEY</code>、
            <code className="mx-1 rounded bg-black/30 px-1 font-mono text-xs">R2_BUCKET</code>。
          </p>
        </div>
      ) : null}

      {loadError ? (
        <div className="rounded-2xl border border-red-500/30 bg-red-500/5 p-5 text-sm text-red-200">
          <p className="font-semibold">读取应用列表失败</p>
          <p className="mt-1 break-anywhere opacity-80">{loadError}</p>
        </div>
      ) : null}

      {notice ? (
        <div className="rounded-2xl border border-brand-500/30 bg-brand-500/5 p-4 text-sm text-brand-100">
          <p className="break-anywhere">{notice}</p>
        </div>
      ) : null}

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_380px]">
        {/* ------------------------------------------------------------ form */}
        <form onSubmit={save} className="space-y-5 rounded-2xl border border-white/10 bg-ink-900/50 p-5">
          <h2 className="text-lg font-semibold">{editing ? "编辑应用" : "上传新应用"}</h2>

          {/* Payload picker */}
          <div className="rounded-xl border border-dashed border-white/15 bg-ink-950/40 p-4">
            <fieldset className="mb-4">
              <legend className="mb-2 text-sm text-slate-300">应用类型</legend>
              <div className="inline-flex rounded-xl border border-white/10 p-1">
                {(
                  [
                    { value: "apk", label: "Android 应用 (APK)" },
                    { value: "html", label: "Web 应用 (HTML/ZIP)" },
                  ] as const
                ).map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    onClick={() => set("kind", option.value)}
                    className={`rounded-lg px-3 py-1.5 text-sm transition ${
                      form.kind === option.value
                        ? "bg-brand-500 font-semibold text-ink-950"
                        : "text-slate-300 hover:text-white"
                    }`}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </fieldset>

            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={() => apkInput.current?.click()}
                disabled={!storageReady || upload.phase === "parsing" || upload.phase === "uploading"}
                className="rounded-xl bg-brand-500 px-4 py-2 text-sm font-semibold text-ink-950 transition hover:bg-brand-400 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {form.apk_key
                  ? "重新选择文件"
                  : form.kind === "apk"
                    ? "选择 APK 文件"
                    : "选择 HTML / ZIP 文件"}
              </button>
              <span className="text-sm text-slate-400">
                {form.apk_key
                  ? `已就绪 · ${formatBytes(form.apk_size)}`
                  : form.kind === "apk"
                    ? "上传后会自动解析包名、版本、权限与图标"
                    : "单个 .html 文件可直接在线运行；.zip 会作为压缩包下载"}
              </span>
            </div>

            <input
              ref={apkInput}
              type="file"
              accept={
                form.kind === "apk"
                  ? ".apk,.apks,.xapk,application/vnd.android.package-archive"
                  : ".html,.htm,.zip,text/html,application/zip"
              }
              className="hidden"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void handlePayloadSelected(file);
              }}
            />

            {upload.phase !== "idle" ? (
              <div className="mt-3 space-y-2">
                <div className="h-1.5 overflow-hidden rounded-full bg-white/10">
                  <div
                    className={`h-full rounded-full transition-all ${
                      upload.phase === "error" ? "bg-red-500" : "bg-brand-500"
                    }`}
                    style={{ width: `${Math.round(upload.progress * 100)}%` }}
                  />
                </div>
                <p
                  className={`text-xs ${
                    upload.phase === "error"
                      ? "text-red-300"
                      : upload.phase === "done"
                        ? "text-brand-300"
                        : "text-slate-400"
                  }`}
                >
                  {upload.message}
                </p>
              </div>
            ) : null}

            {apkInfo && apkInfo.metadata.warnings.length > 0 ? (
              <ul className="mt-3 space-y-1 text-xs text-amber-200/80">
                {apkInfo.metadata.warnings.map((warning, index) => (
                  <li key={index}>· {warning}</li>
                ))}
              </ul>
            ) : null}
          </div>

          {/* Core fields */}
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="应用名称 *">
              <input
                required
                value={form.name}
                onChange={(event) => set("name", event.target.value)}
                className={inputClass}
              />
            </Field>
            <Field label="自定义链接标识 (slug)">
              <input
                value={form.slug}
                onChange={(event) => set("slug", event.target.value)}
                placeholder="留空则按名称自动生成"
                className={inputClass}
              />
            </Field>
            <Field label="分类">
              <input
                value={form.category}
                onChange={(event) => set("category", event.target.value)}
                placeholder="例如：工具 / 游戏 / 社交"
                className={inputClass}
              />
            </Field>
            <Field label="版本名称">
              <input
                value={form.version_name}
                onChange={(event) => set("version_name", event.target.value)}
                className={inputClass}
              />
            </Field>
            {/* The remaining fields describe Android build metadata only. */}
            {form.kind === "apk" ? (
              <>
                <Field label="包名">
                  <input
                    value={form.package_name}
                    onChange={(event) => set("package_name", event.target.value)}
                    className={`${inputClass} font-mono text-xs`}
                  />
                </Field>
                <Field label="版本号 (versionCode)">
                  <input
                    value={form.version_code}
                    onChange={(event) => set("version_code", event.target.value)}
                    inputMode="numeric"
                    className={inputClass}
                  />
                </Field>
                <Field label="最低 Android API">
                  <input
                    value={form.min_sdk}
                    onChange={(event) => set("min_sdk", event.target.value)}
                    inputMode="numeric"
                    className={inputClass}
                  />
                </Field>
                <Field label="目标 Android API">
                  <input
                    value={form.target_sdk}
                    onChange={(event) => set("target_sdk", event.target.value)}
                    inputMode="numeric"
                    className={inputClass}
                  />
                </Field>
              </>
            ) : null}
            {isAdmin ? (
              <>
                <Field label="排序权重（越大越靠前）">
                  <input
                    value={form.sort_order}
                    onChange={(event) => set("sort_order", event.target.value)}
                    inputMode="numeric"
                    className={inputClass}
                  />
                </Field>
                <Field label="发布状态">
                  <select
                    value={form.status}
                    onChange={(event) => set("status", event.target.value as AppStatus)}
                    className={inputClass}
                  >
                    <option value="published">已发布（在应用库公开）</option>
                    <option value="pending">待审核</option>
                    <option value="rejected">已驳回</option>
                    <option value="draft">草稿（不公开）</option>
                  </select>
                </Field>
              </>
            ) : (
              <div className="sm:col-span-2 rounded-xl border border-amber-500/25 bg-amber-500/5 p-3 text-xs leading-relaxed text-amber-100/85">
                <p className="font-semibold text-amber-200">提交后需要管理员审核</p>
                <p className="mt-1">
                  你的应用会先进入<strong>待审核</strong>队列，管理员通过后才会出现在应用库中。
                  提交后你可以在这里查看审核状态和驳回理由。
                </p>
                {quota ? (
                  <p className="mt-1 opacity-80">当前账号最多可提交 {quota} 个应用。</p>
                ) : null}
              </div>
            )}
          </div>

          <Field label="一句话简介">
            <input
              value={form.summary}
              onChange={(event) => set("summary", event.target.value)}
              placeholder="列表页显示的一句话描述"
              className={inputClass}
            />
          </Field>

          <Field label="详细介绍">
            <textarea
              value={form.description}
              onChange={(event) => set("description", event.target.value)}
              rows={5}
              className={`${inputClass} resize-y`}
            />
          </Field>

          <Field label="权限（每行一个，通常无需手动修改）">
            <textarea
              value={permissionText}
              onChange={(event) =>
                set(
                  "permissions",
                  event.target.value
                    .split("\n")
                    .map((line) => line.trim())
                    .filter(Boolean),
                )
              }
              rows={4}
              className={`${inputClass} resize-y font-mono text-xs`}
            />
          </Field>

          {/* Icon */}
          <div className="rounded-xl border border-white/10 bg-ink-950/40 p-4">
            <p className="mb-3 text-sm text-slate-300">应用图标</p>
            <div className="flex items-center gap-4">
              <div className="h-16 w-16 shrink-0 overflow-hidden rounded-2xl border border-white/10 bg-ink-800">
                {form.icon_key ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={iconPreview || (savedSlug ? mediaUrl(savedSlug, "icon") : "")}
                    alt="图标预览"
                    className="h-full w-full object-cover"
                    onError={(event) => {
                      (event.currentTarget as HTMLImageElement).style.visibility = "hidden";
                    }}
                  />
                ) : (
                  <span className="grid h-full w-full place-items-center text-lg text-slate-500">
                    {form.name ? initialsFor(form.name) : "?"}
                  </span>
                )}
              </div>
              <div className="space-y-2">
                <button
                  type="button"
                  onClick={() => iconInput.current?.click()}
                  disabled={!storageReady}
                  className="rounded-lg border border-white/10 px-3 py-1.5 text-sm text-slate-300 transition hover:border-brand-500/40 hover:text-white disabled:opacity-50"
                >
                  手动上传图标
                </button>
                <p className="text-xs text-slate-500">
                  {form.icon_key ? "已设置（可覆盖）" : "未设置，将从 APK 中自动提取"}
                </p>
              </div>
            </div>
            <input
              ref={iconInput}
              type="file"
              accept="image/png,image/webp,image/jpeg"
              className="hidden"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void handleIconSelected(file);
              }}
            />
          </div>

          {/* Screenshots */}
          <div className="rounded-xl border border-white/10 bg-ink-950/40 p-4">
            <div className="mb-3 flex items-center justify-between gap-3">
              <p className="text-sm text-slate-300">
                应用截图
                <span className="ml-2 text-xs text-slate-500">{form.screenshots.length} 张</span>
              </p>
              <button
                type="button"
                onClick={() => shotInput.current?.click()}
                disabled={!storageReady}
                className="rounded-lg border border-white/10 px-3 py-1.5 text-sm text-slate-300 transition hover:border-brand-500/40 hover:text-white disabled:opacity-50"
              >
                上传截图
              </button>
            </div>

            {form.screenshots.length === 0 ? (
              <p className="text-xs text-slate-500">尚未上传截图</p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {form.screenshots.map((key, index) => {
                  const preview = shotPreviews[key];
                  return (
                    <div key={key} className="relative">
                      <div className="h-24 w-14 overflow-hidden rounded-lg border border-white/10 bg-ink-800">
                        {preview ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={preview}
                            alt={`截图 ${index + 1}`}
                            className="h-full w-full object-cover"
                          />
                        ) : savedSlug ? (
                          // Already-stored screenshot: resolve it through the media
                          // route, which maps array positions to object keys.
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={mediaUrl(savedSlug, `screenshot-${index}`)}
                            alt={`截图 ${index + 1}`}
                            className="h-full w-full object-cover"
                          />
                        ) : (
                          <span className="grid h-full w-full place-items-center text-[10px] text-slate-500">
                            待保存
                          </span>
                        )}
                      </div>
                      <button
                        type="button"
                        onClick={() => {
                          set(
                            "screenshots",
                            form.screenshots.filter((item) => item !== key),
                          );
                          setShotPreviews((previous) => {
                            const next = { ...previous };
                            delete next[key];
                            return next;
                          });
                        }}
                        className="absolute -right-1.5 -top-1.5 grid h-5 w-5 place-items-center rounded-full bg-red-500 text-xs text-white"
                        aria-label={`移除截图 ${index + 1}`}
                      >
                        ×
                      </button>
                    </div>
                  );
                })}
              </div>
            )}

            <input
              ref={shotInput}
              type="file"
              accept="image/png,image/webp,image/jpeg"
              multiple
              className="hidden"
              onChange={(event) => {
                const files = event.target.files;
                if (files && files.length > 0) void handleScreenshotsSelected(files);
                event.target.value = "";
              }}
            />
          </div>

          {policyIssues.length > 0 ? (
            <div className="rounded-xl border border-red-500/40 bg-red-500/10 p-4">
              <p className="text-sm font-semibold text-red-200">该文件不符合本站的上传规则</p>
              <ul className="mt-2 space-y-1 text-sm text-red-100/85">
                {policyIssues.map((issue, index) => (
                  <li key={index}>· {issue}</li>
                ))}
              </ul>
            </div>
          ) : null}

          {formError ? (
            <p className="break-anywhere rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-200">
              {formError}
            </p>
          ) : null}

          {!isAdmin ? (
            <label className="flex items-start gap-2 rounded-xl border border-white/10 bg-ink-950/40 p-3 text-xs leading-relaxed text-slate-300">
              <input
                type="checkbox"
                checked={form.termsAccepted}
                onChange={(event) => set("termsAccepted", event.target.checked)}
                className="mt-0.5 h-4 w-4 shrink-0 rounded border-white/20 bg-ink-950"
              />
              <span>
                我确认<strong>拥有该应用的合法权利或已获授权</strong>，内容不含病毒、木马等恶意代码，
                也不侵犯他人权益；因该应用产生的责任由我承担。我已阅读并同意
                <a href="/terms" target="_blank" rel="noreferrer" className="mx-1 text-brand-400 hover:underline">
                  免责声明与使用条款
                </a>
                。
              </span>
            </label>
          ) : null}

          <div className="flex items-center gap-3">
            <button
              type="submit"
              disabled={
                saving ||
                !databaseReady ||
                policyIssues.length > 0 ||
                (!isAdmin && !form.termsAccepted)
              }
              className="rounded-xl bg-brand-500 px-5 py-2.5 text-sm font-semibold text-ink-950 transition hover:bg-brand-400 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {saving ? "保存中…" : isAdmin ? (editing ? "保存修改" : "保存并发布") : "提交审核"}
            </button>
            <p className="text-xs text-slate-500">
              {isAdmin ? (
                <>
                  保存后应用会立即出现在
                  <a href="/" target="_blank" rel="noreferrer" className="mx-1 text-brand-400 hover:underline">
                    应用库
                  </a>
                  中。
                </>
              ) : (
                "提交后需等待管理员审核，通过后才会公开。"
              )}
            </p>
          </div>
        </form>

        {/* ------------------------------------------------------------ list */}
        <aside className="space-y-3">
          <h2 className="text-lg font-semibold">已有应用 ({apps.length})</h2>
          {apps.length === 0 ? (
            <p className="rounded-xl border border-white/10 bg-ink-900/40 p-4 text-sm text-slate-400">
              还没有任何应用，使用左侧表单上传第一个 APK。
            </p>
          ) : (
            <ul className="space-y-2">
              {apps.map((app) => (
                <li
                  key={app.id}
                  className={`flex items-center gap-3 rounded-xl border p-3 transition ${
                    form.id === app.id
                      ? "border-brand-500/50 bg-brand-500/5"
                      : "border-white/10 bg-ink-900/40"
                  }`}
                >
                  <div className="h-10 w-10 shrink-0 overflow-hidden rounded-lg border border-white/10 bg-ink-800">
                    {app.icon_key ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={mediaUrl(app.slug, "icon")}
                        alt=""
                        className="h-full w-full object-cover"
                        loading="lazy"
                      />
                    ) : (
                      <span className="grid h-full w-full place-items-center text-xs text-brand-400">
                        {initialsFor(app.name)}
                      </span>
                    )}
                  </div>

                  <div className="min-w-0 flex-1 space-y-1">
                    <p className="truncate text-sm font-medium text-white">{app.name}</p>
                    <StatusBadge status={app.status} />
                    <p className="truncate text-xs text-slate-500">
                      {app.apk_size ? formatBytes(app.apk_size) : "无文件"}
                      {app.version_name ? ` · v${app.version_name}` : ""}
                    </p>
                    {app.status === "rejected" && app.review_note ? (
                      <p className="break-anywhere text-xs text-red-300/90">
                        驳回理由：{app.review_note}
                      </p>
                    ) : null}
                  </div>

                  <div className="flex shrink-0 flex-col gap-1">
                    <button
                      type="button"
                      onClick={() => {
                        setForm(toForm(app));
                        setSavedSlug(app.slug);
                        setApkInfo(null);
                        setIconPreview(null);
                        setShotPreviews((previous) => {
                          for (const url of Object.values(previous)) URL.revokeObjectURL(url);
                          return {};
                        });
                        setUpload(IDLE_UPLOAD);
                        setFormError(null);
                        setNotice(null);
                        window.scrollTo({ top: 0, behavior: "smooth" });
                      }}
                      className="rounded-lg border border-white/10 px-2.5 py-1 text-xs text-slate-300 transition hover:border-brand-500/40 hover:text-white"
                    >
                      编辑
                    </button>
                    <button
                      type="button"
                      onClick={() => void remove(app)}
                      className="rounded-lg border border-white/10 px-2.5 py-1 text-xs text-slate-400 transition hover:border-red-500/40 hover:text-red-200"
                    >
                      删除
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </aside>
      </div>
    </div>
  );
}

const inputClass =
  "w-full rounded-xl border border-white/10 bg-ink-950/60 px-3 py-2 text-sm text-white placeholder:text-slate-600 outline-none transition focus:border-brand-500/50 focus:ring-2 focus:ring-brand-500/20";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-sm text-slate-300">{label}</span>
      {children}
    </label>
  );
}
