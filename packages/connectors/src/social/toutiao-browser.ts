import type { SubjectRef } from "@forge/protocol";
import type { Database } from "@forge/store";
import type { InMemoryCredentialProvider } from "../credentials.js";
import type {
  AdapterResult,
  ApprovedConnectorAction,
  ConnectorActionInput,
  ConnectorActionRecord,
  ConnectorAdapter,
  ConnectorProposalPreview,
  ResolvedCredential,
} from "../types.js";
import { connectPublishAccount } from "./accounts.js";
import type { BrowserPublishPage, BrowserPublishSession } from "./xiaohongshu-browser.js";

export const TOUTIAO_BROWSER_ACCOUNT = {
  connectorId: "toutiao-browser",
  connectorName: "今日头条",
  adapterKind: "toutiao-browser",
  accountId: "toutiao-browser-account",
  accountName: "创作者账号",
  credentialRef: "cred://toutiao-browser",
  loginUrl: "https://mp.toutiao.com/profile_v4/index",
  publishUrl: "https://mp.toutiao.com/profile_v4/graphic/publish",
} as const;

const SESSION_MARKER = "browser-session";
const ARTICLE_URL = /https:\/\/www\.toutiao\.com\/(?:item|article|group|i|a)\/\d+/;

export function toutiaoLoginState(page: Pick<BrowserPublishPage, "url" | "title" | "text">):
  | "logged_in"
  | "logged_out"
  | "unknown" {
  let url: URL;
  try {
    url = new URL(page.url);
  } catch {
    return "unknown";
  }
  if (url.protocol !== "https:") return "unknown";
  if (url.hostname === "sso.toutiao.com") return "logged_out";
  if (url.hostname !== "mp.toutiao.com") return "unknown";
  if (url.pathname.startsWith("/auth") || url.pathname.includes("/login")) return "logged_out";
  const hay = `${page.title ?? ""}\n${page.text ?? ""}`;
  if (/扫码登录|短信登录|验证码登录|密码登录|手机号登录/.test(hay)) return "logged_out";
  if (/内容管理|创作首页|作品管理|头条号首页|发布文章|预览并发布|请输入正文|请输入文章标题/.test(hay)) {
    return "logged_in";
  }
  return "unknown";
}

export function toutiaoArticle(payload: Record<string, unknown>): { title: string; body: string } | AdapterResult {
  if (Array.isArray(payload.images) && payload.images.length > 0) {
    return { ok: false, error: "创作者页面的图片和封面上传还没有接上" };
  }
  const title = typeof payload.title === "string" ? payload.title.trim() : "";
  if ([...title].length < 2 || [...title].length > 30) {
    return { ok: false, error: "今日头条标题需要 2 到 30 个字" };
  }
  for (const key of ["content", "body", "text", "note"]) {
    const value = payload[key];
    if (typeof value === "string" && value.trim()) return { title, body: value };
  }
  return { ok: false, error: "今日头条文章需要正文" };
}

export class ToutiaoBrowserAdapter implements ConnectorAdapter {
  readonly kind = TOUTIAO_BROWSER_ACCOUNT.adapterKind;

  constructor(
    private readonly browser: BrowserPublishSession,
    private readonly markNeedsAuth: (accountId: string) => void,
    private readonly waitMs = 400,
  ) {}

  async propose(input: ConnectorActionInput): Promise<ConnectorProposalPreview> {
    return { action: input.action, summary: "toutiao browser publish", risk: "low" };
  }

  async execute(
    input: ApprovedConnectorAction,
    _credential: ResolvedCredential,
  ): Promise<AdapterResult> {
    const article = toutiaoArticle(input.payload);
    if (!("title" in article)) return article;
    try {
      let page = await this.openPublishPage();
      const state = toutiaoLoginState(page);
      if (state !== "logged_in") {
        if (state === "logged_out") this.markNeedsAuth(input.connectorAccountId);
        return {
          ok: false,
          error: state === "logged_out" ? "创作者登录已失效" : "无法确认创作者页面已登录",
        };
      }
      if ((page.text ?? "").includes("我知道了")) {
        await this.browser.clickText(page.tabId, "我知道了");
        page = await this.browser.snapshot(page.tabId);
      }
      const title = titleField(page);
      const body = bodyField(page);
      if (!title) return { ok: false, error: "创作者发布页上没有可填写的标题" };
      if (!body) return { ok: false, error: "创作者发布页上没有可填写的正文" };
      await this.browser.type(page.tabId, title.ref, article.title);
      await this.browser.type(page.tabId, body.ref, article.body);
      page = await this.browser.snapshot(page.tabId);
      if ((page.text ?? "").includes("无封面")) {
        try {
          await this.browser.clickText(page.tabId, "无封面");
          page = await this.browser.snapshot(page.tabId);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (!message.includes("Browser element not found: 无封面")) throw error;
        }
      }
      if (coverRequired(page)) {
        return { ok: false, error: "文章还缺封面，封面上传还没有接上" };
      }
      const submitted = await this.submit(page);
      page = submitted.page;
      const url = toutiaoResultUrl(page) ?? (submitted.confirmed ? articlesUrl(page) : undefined);
      if (!url) {
        return {
          ok: false,
          error: submitted.confirmed ? "发布后没有确认成功" : "预览后没有出现确认发布",
        };
      }
      return { ok: true, externalId: url, url, summary: "published" };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("Browser element is disabled")) {
        return { ok: false, error: "发布按钮还不能点。文章可能还缺封面或必填项。" };
      }
      if (message.includes("Browser element not found: 预览并发布")) {
        return { ok: false, error: "发布页上还没有可点击的预览并发布" };
      }
      return { ok: false, error: message };
    }
  }

  private async openPublishPage(): Promise<BrowserPublishPage> {
    const existing = await findLoggedInCreatorPage(this.browser);
    const opened = existing
      ? await this.browser.navigate(existing.tabId, TOUTIAO_BROWSER_ACCOUNT.publishUrl)
      : await this.browser.open(TOUTIAO_BROWSER_ACCOUNT.publishUrl);
    return this.poll(opened.tabId, publishSurfaceReady, 15);
  }

  private async submit(page: BrowserPublishPage): Promise<{ page: BrowserPublishPage; confirmed: boolean }> {
    await this.browser.clickText(page.tabId, "预览并发布");
    page = await this.poll(
      page.tabId,
      (next) => Boolean(confirmButton(next)) || Boolean(toutiaoResultUrl(next)),
      30,
    );
    const button = confirmButton(page);
    if (!button || toutiaoResultUrl(page)) return { page, confirmed: false };
    // The label shows up before the preview footer can take a click.
    await delay(this.waitMs * 2);
    await this.browser.clickText(page.tabId, button);
    return {
      page: await this.poll(page.tabId, (next) => Boolean(toutiaoResultUrl(next) || articlesUrl(next)), 45),
      confirmed: true,
    };
  }

  private async poll(
    tabId: string,
    ready: (page: BrowserPublishPage) => boolean,
    attempts = 12,
  ): Promise<BrowserPublishPage> {
    let page = await this.browser.snapshot(tabId);
    for (let attempt = 0; attempt < attempts && !ready(page); attempt += 1) {
      await delay(this.waitMs);
      page = await this.browser.snapshot(tabId);
    }
    return page;
  }

  async reconcile(
    input: ConnectorActionRecord,
    _credential: ResolvedCredential,
  ): Promise<AdapterResult | "unknown"> {
    if (input.state === "succeeded") return { ok: true, summary: "already succeeded" };
    return "unknown";
  }
}

export async function beginToutiaoLogin(browser: BrowserPublishSession) {
  const existing = await findLoggedInCreatorPage(browser);
  if (!existing) await browser.open(TOUTIAO_BROWSER_ACCOUNT.loginUrl);
  return { status: "needs_auth" as const, loginUrl: TOUTIAO_BROWSER_ACCOUNT.loginUrl };
}

export async function confirmToutiaoLogin(
  browser: BrowserPublishSession,
  db: Database,
  credentials: InMemoryCredentialProvider,
  subject: SubjectRef,
) {
  const page = (await findLoggedInCreatorPage(browser)) ?? (await openAndRead(browser));
  const state = toutiaoLoginState(page);
  if (state !== "logged_in") {
    throw new Error(
      state === "logged_out"
        ? "还没有登录。请在创作者页面完成登录后再确认。"
        : "无法确认已经登录。请在创作者页面完成登录后再确认。",
    );
  }
  credentials.put(TOUTIAO_BROWSER_ACCOUNT.credentialRef, SESSION_MARKER);
  connectPublishAccount(db, { ...TOUTIAO_BROWSER_ACCOUNT, subject });
  return {
    connectorId: TOUTIAO_BROWSER_ACCOUNT.connectorId,
    accountId: TOUTIAO_BROWSER_ACCOUNT.accountId,
    name: TOUTIAO_BROWSER_ACCOUNT.accountName,
  };
}

async function findLoggedInCreatorPage(browser: BrowserPublishSession): Promise<BrowserPublishPage | null> {
  const tabs = await browser.listTabs();
  for (const tab of tabs) {
    let url: URL;
    try {
      url = new URL(tab.url);
    } catch {
      continue;
    }
    if (url.protocol !== "https:" || url.hostname !== "mp.toutiao.com") continue;
    if (url.pathname.startsWith("/auth") || url.pathname.includes("/login")) continue;
    const page = await browser.snapshot(tab.tabId);
    if (toutiaoLoginState(page) === "logged_in") return page;
  }
  return null;
}

async function openAndRead(browser: BrowserPublishSession): Promise<BrowserPublishPage> {
  const opened = await browser.open(TOUTIAO_BROWSER_ACCOUNT.loginUrl);
  return browser.snapshot(opened.tabId);
}

function publishSurfaceReady(page: BrowserPublishPage): boolean {
  const state = toutiaoLoginState(page);
  if (state === "logged_out") return true;
  if (state !== "logged_in") return false;
  return Boolean(titleField(page) && bodyField(page));
}

function titleField(page: BrowserPublishPage) {
  return page.elements.find((element) => element.role === "textbox" && /标题/.test(element.name ?? ""));
}

function bodyField(page: BrowserPublishPage) {
  const candidates = page.elements.filter((element) => {
    const name = element.name ?? "";
    return /正文/.test(name) && !/标题/.test(name);
  });
  return candidates.find((element) => element.role === "textbox")
    ?? candidates.find((element) => !element.role && (element.name ?? "").length <= 40);
}

function confirmButton(page: BrowserPublishPage): "确认发布" | "立即发布" | null {
  const named = (label: "确认发布" | "立即发布") =>
    page.elements.some((element) => element.role === "button" && (element.name ?? "").trim() === label);
  if (named("确认发布")) return "确认发布";
  if (named("立即发布")) return "立即发布";
  return null;
}

function articlesUrl(page: BrowserPublishPage): string | undefined {
  try {
    const url = new URL(page.url);
    if (url.protocol !== "https:" || url.hostname !== "mp.toutiao.com") return undefined;
    if (!/\/graphic\/articles(?:\/|$)/.test(url.pathname)) return undefined;
    return url.href;
  } catch {
    return undefined;
  }
}

function coverRequired(page: BrowserPublishPage): boolean {
  return /请上传封面|请设置封面|封面不能为空|封面为必填|至少上传一张封面/.test(page.text ?? "");
}

function toutiaoResultUrl(page: BrowserPublishPage): string | undefined {
  for (const candidate of [page.url, page.text ?? ""]) {
    if (typeof candidate !== "string") continue;
    const match = candidate.match(ARTICLE_URL);
    if (match) return match[0];
  }
  const text = page.text ?? "";
  // 创作者后台常见成功文案是「提交成功」，不一定出现「发布成功」或文章外链。
  if (!/发布成功|提交成功/.test(text)) return undefined;
  try {
    const url = new URL(page.url);
    if (url.protocol !== "https:" || url.hostname !== "mp.toutiao.com") return undefined;
    if (url.pathname.includes("/publish")) return undefined;
    return url.href;
  } catch {
    return undefined;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
