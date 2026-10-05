import Link from "next/link";

export const metadata = {
  title: "免责声明与使用条款",
  description: "本站的服务性质、内容责任划分与下架流程说明。",
};

const siteName = process.env.NEXT_PUBLIC_SITE_NAME?.trim() || "本站";

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <h2 className="text-lg font-semibold text-white">{title}</h2>
      <div className="space-y-2 text-sm leading-relaxed text-slate-300">{children}</div>
    </section>
  );
}

export default function TermsPage() {
  return (
    <div className="mx-auto max-w-3xl space-y-8">
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">免责声明与使用条款</h1>
        <p className="text-sm text-slate-400">
          最后更新：{new Date().toISOString().slice(0, 10)}
        </p>
      </header>

      <div className="rounded-2xl border border-amber-500/30 bg-amber-500/5 p-5 text-sm leading-relaxed text-amber-100/90">
        <p className="font-semibold text-amber-200">请先阅读这一段</p>
        <p className="mt-1">
          {siteName}是一个<strong>由用户自行上传内容的存储与分发平台</strong>。本站不开发、不修改、
          不担保任何上传的应用。所有应用的名称、图标、内容与安全性均由上传者负责。
          <strong>安装任何应用前，请自行判断其来源是否可信。</strong>
        </p>
      </div>

      <Section title="一、平台性质">
        <p>
          本站仅提供应用文件的存储与下载链接，不参与应用的开发、编译、签名或修改过程。
          本站对上传内容进行形式审查（例如文件格式、声明的权限），
          但<strong>该审查不构成安全担保，也不能替代专业的安全检测</strong>。
        </p>
      </Section>

      <Section title="二、内容责任">
        <p>上传者须保证其上传内容：</p>
        <ul className="list-inside list-disc space-y-1 pl-1">
          <li>为其本人开发，或已获得权利人的合法授权；</li>
          <li>不含计算机病毒、木马、后门、勒索软件等恶意代码；</li>
          <li>不含违反法律法规的内容，不侵犯他人的著作权、商标权或其他合法权益；</li>
          <li>不含窃取用户隐私、恶意扣费、诱导欺诈等功能。</li>
        </ul>
        <p>
          因上传内容引发的任何纠纷、索赔或法律责任，
          <strong>由上传者自行承担</strong>，与本站及本站运营者无关。
        </p>
      </Section>

      <Section title="三、责任限制">
        <p>
          本站按「现状」提供服务，不对以下情形承担责任：应用无法安装或运行、
          应用造成设备损坏或数据丢失、应用存在未发现的安全缺陷、
          因网络或服务中断导致的无法访问。
        </p>
        <p>
          在法律允许的最大范围内，本站运营者对因使用本服务产生的任何间接、
          附带或后果性损失不承担责任。
        </p>
      </Section>

      <Section title="四、侵权与违规内容的处理">
        <p>
          如果你认为本站的某个应用侵犯了你的合法权益，或发现其含有恶意代码，
          请通过下方联系方式告知，并提供：
        </p>
        <ul className="list-inside list-disc space-y-1 pl-1">
          <li>涉事应用的名称或链接；</li>
          <li>你的权利证明（如著作权登记、商标注册证明，或开发者身份证明）；</li>
          <li>具体说明与必要的证据。</li>
        </ul>
        <p>
          本站核实后将<strong>立即下架相关内容</strong>，并视情况封禁上传账号。
        </p>
      </Section>

      <Section title="五、隐私说明">
        <p>
          注册时本站收集你的邮箱地址与密码（密码以加盐哈希存储，本站无法还原）。
          上传应用时，本站在服务器端读取应用包内的应用名称、包名、版本与
          <strong>所声明的权限清单</strong>，用于内容审查与页面展示。
        </p>
        <p>
          本站不使用 Cookie 进行广告追踪。登录状态通过一个签名 Cookie 维持，
          有效期为 7 天，退出登录即失效。
        </p>
      </Section>

      <Section title="六、上传者承诺">
        <p>
          勾选「我已阅读并同意」并提交应用，即表示你确认拥有该应用的合法权利，
          且内容不含恶意代码；你同意对因该应用产生的一切后果承担责任，
          并同意本站在收到有效投诉后下架该应用。
        </p>
        <p className="text-slate-400">
          该确认会连同时间戳一并记录在案。
        </p>
      </Section>

      <Section title="七、联系方式">
        <p>
          侵权通知、安全问题报告或下架请求，请发送至本站管理员邮箱
          （可在页脚或管理员后台查到），或通过你注册时使用的邮箱联系管理员。
        </p>
      </Section>

      <div className="rounded-2xl border border-white/10 bg-ink-900/50 p-5">
        <p className="text-sm text-slate-400">
          继续使用本站即表示你已阅读并同意上述条款。
        </p>
        <div className="mt-3 flex gap-3 text-sm">
          <Link href="/" className="text-brand-400 hover:underline">
            返回应用库
          </Link>
          <Link href="/submit" className="text-brand-400 hover:underline">
            上传应用
          </Link>
        </div>
      </div>
    </div>
  );
}
