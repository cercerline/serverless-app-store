/**
 * Round-trip test for the APK metadata parser.
 *
 * Builds synthetic APKs from hand-encoded AXML / ARSC / ZIP structures whose
 * expected values are known exactly, then asserts the parser recovers them. Also
 * covers the UTF-16 string-pool variant, sparse type chunks, and index gaps,
 * which are the encoding branches most likely to regress silently.
 *
 * Run with:  npm run test:apk
 */

import assert from "node:assert/strict";
import {
  encodeAxml,
  encodeResourceTable,
  encodeZip,
  encodeZipDeflated,
  type AxmlElementSpec,
} from "../src/lib/apk/__fixtures__/encoders.ts";
import { BufferByteSource, extractApkMetadata, readApkEntry } from "../src/lib/apk/manifest.ts";

const ANDROID_NS = "http://schemas.android.com/apk/res/android";

const APP_NAME_RES = 0x7f0e0001;
const APP_ICON_RES = 0x7f080002;
const ROUND_ICON_RES = 0x7f080003;

const ICON_PATH_HIGH = "res/mipmap-xxxhdpi-v4/ic_launcher.webp";
const ICON_PATH_LOW = "res/mipmap-mdpi-v4/ic_launcher.png";

const EXPECTED = {
  packageName: "com.example.demo",
  appName: "示例应用 Demo",
  versionName: "2.4.1-beta.3",
  versionCode: 2040137,
  minSdk: 24,
  targetSdk: 34,
  permissions: ["INTERNET", "CAMERA", "ACCESS_FINE_LOCATION"],
  icon: ICON_PATH_HIGH,
};

/** Builds the manifest tree used by every case. */
function manifestSpec(): AxmlElementSpec {
  const android = ANDROID_NS;
  return {
    name: "manifest",
    attributes: [
      { namespace: null, name: "package", stringValue: EXPECTED.packageName },
      { namespace: android, name: "versionCode", intValue: EXPECTED.versionCode },
      { namespace: android, name: "versionName", stringValue: EXPECTED.versionName },
    ],
    children: [
      {
        name: "uses-sdk",
        attributes: [
          { namespace: android, name: "minSdkVersion", intValue: EXPECTED.minSdk },
          { namespace: android, name: "targetSdkVersion", intValue: EXPECTED.targetSdk },
        ],
      },
      ...EXPECTED.permissions.map<AxmlElementSpec>((permission) => ({
        name: "uses-permission",
        attributes: [
          { namespace: android, name: "name", stringValue: `android.permission.${permission}` },
        ],
      })),
      {
        name: "application",
        attributes: [
          { namespace: android, name: "label", reference: APP_NAME_RES },
          { namespace: android, name: "icon", reference: APP_ICON_RES },
          { namespace: android, name: "roundIcon", reference: ROUND_ICON_RES },
          { namespace: android, name: "allowBackup", boolValue: true },
        ],
      },
    ],
  };
}

/** Builds a resource table resolving the label and both icon variants. */
function resourceSpec(options: { utf8: boolean; sparse: boolean; densityOrder?: "asc" | "desc" }) {
  const order = options.densityOrder ?? "asc";
  // Icon strings live in the global value pool; the low-density variant is
  // listed first so a naive "first match wins" parser would return the wrong one.
  const values = [ICON_PATH_LOW, ICON_PATH_HIGH, EXPECTED.appName];
  const densities = [160, 640]; // mdpi, xxxhdpi

  return {
    utf8: options.utf8,
    values,
    types: [
      // typeId 8 -> drawable (icons)
      {
        typeId: 8,
        density: order === "asc" ? densities[0] : densities[1],
        sparse: options.sparse,
        entries: [{ index: 2, stringValue: order === "asc" ? ICON_PATH_LOW : ICON_PATH_HIGH }],
      },
      {
        typeId: 8,
        density: order === "asc" ? densities[1] : densities[0],
        sparse: options.sparse,
        entries: [{ index: 2, stringValue: order === "asc" ? ICON_PATH_HIGH : ICON_PATH_LOW }],
      },
      {
        typeId: 8,
        density: 160,
        sparse: options.sparse,
        entries: [{ index: 3, stringValue: ICON_PATH_LOW }],
      },
      // typeId 14 (0x0e) -> string (labels)
      {
        typeId: 14,
        density: 0,
        sparse: options.sparse,
        entries: [
          { index: 1, stringValue: EXPECTED.appName },
          // index 2 intentionally absent: exercises the NO_ENTRY skip path
          { index: 5, stringValue: "unused" },
        ],
      },
    ],
  };
}

/** Builds a complete synthetic APK. */
async function buildApk(options: {
  utf8: boolean;
  sparse: boolean;
  deflate: boolean;
  densityOrder?: "asc" | "desc";
  format?: "deflate-raw" | "deflate";
}): Promise<Uint8Array> {
  const manifest = encodeAxml(manifestSpec(), { utf8: options.utf8 });
  const resources = encodeResourceTable(
    resourceSpec({ utf8: options.utf8, sparse: options.sparse, densityOrder: options.densityOrder }),
  );

  // A stand-in bitmap so the parser's "path must exist in the archive" check passes.
  const iconBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

  const entries = [
    { name: "AndroidManifest.xml", data: manifest },
    { name: "resources.arsc", data: resources },
    { name: ICON_PATH_HIGH, data: iconBytes },
    { name: ICON_PATH_LOW, data: iconBytes },
    { name: "classes.dex", data: new TextEncoder().encode("dex\n035\0fake") },
    { name: "META-INF/CERT.RSA", data: new Uint8Array([1, 2, 3]) },
  ];

  return options.deflate
    ? encodeZipDeflated(entries, options.format ?? "deflate-raw")
    : encodeZip(entries);
}

interface Case {
  name: string;
  options: {
    utf8: boolean;
    sparse: boolean;
    deflate: boolean;
    densityOrder?: "asc" | "desc";
    format?: "deflate-raw" | "deflate";
  };
}

const CASES: Case[] = [
  { name: "UTF-8 字符串池 + 存储(未压缩)", options: { utf8: true, sparse: false, deflate: false } },
  { name: "UTF-16 字符串池 + 存储(未压缩)", options: { utf8: false, sparse: false, deflate: false } },
  // Raw deflate is what every real archiver writes into a ZIP. Getting this
  // wrong is invisible to a fixture that makes the same mistake, so the format is
  // asserted explicitly here.
  { name: "deflate 压缩（raw，真实 ZIP 格式）", options: { utf8: true, sparse: false, deflate: true, format: "deflate-raw" } },
  { name: "deflate 压缩（zlib 包装，非标准回退）", options: { utf8: true, sparse: false, deflate: true, format: "deflate" } },
  { name: "稀疏(sparse)资源类型块", options: { utf8: true, sparse: true, deflate: true } },
  { name: "密度顺序倒置(低密度在前)", options: { utf8: true, sparse: false, deflate: false, densityOrder: "desc" } },
];

let passed = 0;
const failures: string[] = [];

for (const testCase of CASES) {
  try {
    const apk = await buildApk(testCase.options);
    const metadata = await extractApkMetadata(new BufferByteSource(apk));

    assert.equal(metadata.packageName, EXPECTED.packageName, "packageName");
    assert.equal(metadata.appName, EXPECTED.appName, "appName");
    assert.equal(metadata.versionName, EXPECTED.versionName, "versionName");
    assert.equal(metadata.versionCode, EXPECTED.versionCode, "versionCode");
    assert.equal(metadata.minSdkVersion, EXPECTED.minSdk, "minSdkVersion");
    assert.equal(metadata.targetSdkVersion, EXPECTED.targetSdk, "targetSdkVersion");
    assert.deepEqual(metadata.permissions, EXPECTED.permissions, "permissions");
    assert.equal(metadata.iconPath, EXPECTED.icon, "iconPath (应选中最高密度图标)");

    // The icon must be retrievable as an actual archive member.
    const icon = await readApkEntry(new BufferByteSource(apk), metadata.iconPath!);
    assert.ok(icon && icon.length > 0, "应能从 APK 中读出图标字节");

    console.log(`  ✓ ${testCase.name}`);
    passed++;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`  ✗ ${testCase.name}\n      ${message}`);
    failures.push(`${testCase.name}: ${message}`);
  }
}

// ------------------------------------------------------------- negative cases

interface NegativeCase {
  name: string;
  bytes: Uint8Array;
  expect: RegExp;
}

const notAZip = new Uint8Array(64).fill(0x41);
const truncatedZip = (await buildApk({ utf8: true, sparse: false, deflate: false })).subarray(0, 40);
const zipWithoutManifest = encodeZip([
  { name: "classes.dex", data: new TextEncoder().encode("dex") },
]);

const NEGATIVE: NegativeCase[] = [
  { name: "非 ZIP 数据应报错", bytes: notAZip, expect: /ZIP|中央目录/ },
  { name: "截断文件应报错", bytes: truncatedZip, expect: /太小|ZIP|中央目录|越界/ },
  { name: "缺少 AndroidManifest.xml 应报错", bytes: zipWithoutManifest, expect: /AndroidManifest/ },
];

console.log("\n反向用例：");
for (const testCase of NEGATIVE) {
  try {
    await extractApkMetadata(new BufferByteSource(testCase.bytes));
    console.log(`  ✗ ${testCase.name}（本应失败但成功了）`);
    failures.push(`${testCase.name}: 未按预期抛出错误`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (testCase.expect.test(message)) {
      console.log(`  ✓ ${testCase.name}`);
      passed++;
    } else {
      console.log(`  ✗ ${testCase.name}\n      错误信息不匹配: ${message}`);
      failures.push(`${testCase.name}: 错误信息不匹配 -> ${message}`);
    }
  }
}

// ------------------------------------------------- partial-degradation check

{
  console.log("\n降级用例：");
  const manifest = encodeAxml(
    {
      name: "manifest",
      attributes: [{ namespace: null, name: "package", stringValue: "com.partial.app" }],
      children: [{ name: "application", attributes: [] }],
    },
    { utf8: true },
  );
  const apk = encodeZip([{ name: "AndroidManifest.xml", data: manifest }]);
  const metadata = await extractApkMetadata(new BufferByteSource(apk));

  const checks: Array<[string, boolean]> = [
    ["仍能读出包名", metadata.packageName === "com.partial.app"],
    ["缺少版本号时返回 null", metadata.versionName === null && metadata.versionCode === null],
    ["记录 resources.arsc 缺失警告", metadata.warnings.some((warning) => warning.includes("resources.arsc"))],
    ["记录图标缺失警告", metadata.warnings.some((warning) => warning.includes("图标"))],
  ];
  for (const [label, ok] of checks) {
    console.log(`  ${ok ? "✓" : "✗"} ${label}`);
    if (ok) passed++;
    else failures.push(label);
  }
}

console.log(`\n通过 ${passed} 项，失败 ${failures.length} 项。`);
if (failures.length > 0) {
  console.log("\n失败明细：");
  for (const failure of failures) console.log(`  - ${failure}`);
  process.exit(1);
}
