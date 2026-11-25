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

export const XIAOHONGSHU_BROWSER_ACCOUNT = {
  connectorId: "xiaohongshu-browser",
  connectorName: "小红书",
  adapterKind: "xiaohongshu-browser",
  accountId: "xiaohongshu-browser-account",
  accountName: "创作者账号",
  credentialRef: "cred://xiaohongshu-browser",
  loginUrl: "https://creator.xiaohongshu.com/new/home",
  publishUrl: "https://creator.xiaohongshu.com/publish/publish",
} as const;

const SESSION_MARKER = "browser-session";
const IMAGE_STEP_ATTEMPTS = 90;
const IMAGE_RETRY_IDLE = 8;
const IMAGE_STEP_STUCK = "文字已经写进配图框，但生成图片没有进入下一步。这是配图页面没有往下走，不必改正文。";
const XIAOHONGSHU_IMAGE_NOTE_MAX = 500;

export interface BrowserPublishPage {
  tabId: string;
  url: string;
  title: string;
  text?: string;
  elements: Array<{ ref: string; role?: string; name?: string; href?: string }>;
}

export interface BrowserPublishTab {
  tabId: string;
  url: string;
  title: string;
}

export interface BrowserPublishSession {
  listTabs(): Promise<BrowserPublishTab[]>;
  open(url: string): Promise<BrowserPublishPage>;
  navigate(tabId: string, url: string): Promise<BrowserPublishPage>;
  snapshot(tabId: string): Promise<BrowserPublishPage>;
  type(tabId: string, ref: string, text: string): Promise<void>;
  click(tabId: string, ref: string): Promise<void>;
  clickText(tabId: string, text: string): Promise<void>;
}

export function xiaohongshuLoginState(page: Pick<BrowserPublishPage, "url" | "title" | "text">):
  | "logged_in"
  | "logged_out"
  | "unknown" {
  let url: URL;
  try {
    url = new URL(page.url);
  } catch {
    return "unknown";
  }
  if (url.protocol !== "https:" || url.hostname !== "creator.xiaohongshu.com") return "unknown";
  if (url.pathname.startsWith("/login")) return "logged_out";
  const hay = `${page.title ?? ""}\n${page.text ?? ""}`;
  if (/短信登录|扫码登录|手机号登录|验证码登录/.test(hay)) return "logged_out";
  if (/发布笔记|创作中心|内容管理|笔记管理/.test(hay)) return "logged_in";
  return "unknown";
}

export function xiaohongshuPublishText(payload: Record<string, unknown>): string | AdapterResult {
  if (Array.isArray(payload.images) && payload.images.length > 0) {
    return { ok: false, error: "创作者页面的图片上传还没有接上" };
  }
  let text = "";
  for (const key of ["note", "text", "body", "content"]) {
    const value = payload[key];
    if (typeof value === "string" && value.trim()) {
      text = value;
      break;
    }
  }
  if (!text) text = JSON.stringify(payload);
  return text;
}

export class XiaohongshuBrowserAdapter implements ConnectorAdapter {
  readonly kind = XIAOHONGSHU_BROWSER_ACCOUNT.adapterKind;

  constructor(
    private readonly browser: BrowserPublishSession,
    private readonly markNeedsAuth: (accountId: string) => void,
    private readonly waitMs = 400,
  ) {}

  async propose(input: ConnectorActionInput): Promise<ConnectorProposalPreview> {
    return { action: input.action, summary: "xiaohongshu browser publish", risk: "low" };
  }

  async execute(
    input: ApprovedConnectorAction,
    _credential: ResolvedCredential,
  ): Promise<AdapterResult> {
    const text = xiaohongshuPublishText(input.payload);
    if (typeof text !== "string") return text;
    try {
      let page = await this.openPublishPage();
      const state = xiaohongshuLoginState(page);
      if (state !== "logged_in") {
        if (state === "logged_out") this.markNeedsAuth(input.connectorAccountId);
        return {
          ok: false,
          error: state === "logged_out" ? "创作者登录已失效" : "无法确认创作者页面已登录",
        };
      }
      const seenResults = new Set<string>();
      rememberPublishResult(page, seenResults);
      const sawSuccess = publishSucceeded(page);
      page = await this.ensureTextComposer(page);
      const filled = await this.fillNoteCards(page, text);
      if ("ok" in filled) return filled;
      page = await this.finishPublish(filled, seenResults, sawSuccess);
      const limited = noteLimitOnPage(page);
      if (limited) return { ok: false, error: limited };
      const url = freshPublishResult(page, seenResults);
      if (!url) {
        const stillComposing = (page.text ?? "").includes("生成图片");
        return {
          ok: false,
          error: stillComposing
            ? IMAGE_STEP_STUCK
            : publishSucceeded(page) && !sawSuccess
              ? "笔记已经发布，但页面上没有笔记链接。"
              : editorStillOpen(page)
                ? "正文已经写进编辑框，发布没有离开这一页，笔记还停在草稿里。"
                : seenResults.size > 0
                  ? "页面还停在上一篇的发布结果，这次没有点出新的笔记。"
                  : "发布后没有返回笔记链接",
        };
      }
      return { ok: true, externalId: url, url, summary: "published" };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("Browser element not found: 发布")) {
        return { ok: false, error: "发布页上还没有可点击的发布按钮" };
      }
      if (message.includes("再写一张")) {
        return { ok: false, error: "后面的文字还要再写一张，页面上这个按钮不可用。" };
      }
      return { ok: false, error: message };
    }
  }

  private async openPublishPage(): Promise<BrowserPublishPage> {
    const existing = await findLoggedInCreatorPage(this.browser);
    const opened = existing
      ? await this.browser.navigate(existing.tabId, XIAOHONGSHU_BROWSER_ACCOUNT.publishUrl)
      : await this.browser.open(XIAOHONGSHU_BROWSER_ACCOUNT.publishUrl);
    return this.poll(opened.tabId, publishSurfaceReady, 15);
  }

  private async ensureTextComposer(page: BrowserPublishPage): Promise<BrowserPublishPage> {
    if (creatorPublishedUrl(page) && !onComposer(page) && (page.text ?? "").includes("上传图文")) {
      await this.browser.clickText(page.tabId, "上传图文");
      page = await this.poll(
        page.tabId,
        (next) => onComposer(next) || (next.text ?? "").includes("文字配图"),
      );
    }
    if (onComposer(page) && bodyNoteField(page)) return page;
    if ((page.text ?? "").includes("文字配图")) {
      await this.browser.clickText(page.tabId, "文字配图");
      page = await this.poll(page.tabId, (next) => Boolean(noteField(next)));
    }
    if (!noteField(page) && (page.text ?? "").includes("上传图文")) {
      await this.browser.clickText(page.tabId, "上传图文");
      page = await this.poll(page.tabId, (next) => Boolean(noteField(next)) || (next.text ?? "").includes("文字配图"));
      if (!noteField(page) && (page.text ?? "").includes("文字配图")) {
        await this.browser.clickText(page.tabId, "文字配图");
        page = await this.poll(page.tabId, (next) => Boolean(noteField(next)));
      }
    }
    return page;
  }

  private async fillNoteCards(
    page: BrowserPublishPage,
    text: string,
  ): Promise<BrowserPublishPage | AdapterResult> {
    const cards = splitXiaohongshuNoteCards(text);
    if (!onComposer(page)) {
      return { ok: false, error: "发布页还停在上一篇的结果，没有进入新的正文。" };
    }
    const used = new Set<string>();
    for (let index = 0; index < cards.length; index += 1) {
      if (index > 0) {
        const before = noteBoxes(page).length;
        await this.browser.clickText(page.tabId, "再写一张");
        page = await this.poll(
          page.tabId,
          (next) => noteBoxes(next).length > before || noteBoxes(next).some((box) => !used.has(box.ref)),
          8,
        );
      }
      const field = unusedNoteField(page, used);
      if (!field) {
        return {
          ok: false,
          error: index === 0
            ? "创作者发布页上没有可填写的正文"
            : "文字配图没有新的输入框，后面的字写不进去。",
        };
      }
      await this.browser.type(page.tabId, field.ref, cards[index] ?? "");
      used.add(field.ref);
    }
    return page;
  }

  private async finishPublish(
    page: BrowserPublishPage,
    seenResults: Set<string>,
    sawSuccess: boolean,
  ): Promise<BrowserPublishPage> {
    if (publishButton(page) && !(page.text ?? "").includes("生成图片")) {
      return this.submitPublish(page, seenResults, sawSuccess);
    }
    if ((page.text ?? "").includes("生成图片")) {
      page = await this.advanceImageStep(page);
    }
    if (noteLimitOnPage(page)) return page;
    if ((page.text ?? "").includes("下一步") && !publishButton(page) && !freshPublishResult(page, seenResults)) {
      await this.browser.clickText(page.tabId, "下一步");
      page = await this.poll(
        page.tabId,
        (next) => Boolean(publishButton(next)) || Boolean(publishResultUrl(next)) || (next.text ?? "").includes("暂存离开"),
      );
    }
    if ((page.text ?? "").includes("我知道了")) {
      await this.browser.clickText(page.tabId, "我知道了");
      page = await this.browser.snapshot(page.tabId);
    }
    return this.submitPublish(page, seenResults, sawSuccess);
  }

  private async submitPublish(
    page: BrowserPublishPage,
    seenResults: Set<string>,
    sawSuccess: boolean,
  ): Promise<BrowserPublishPage> {
    const settled = (next: BrowserPublishPage) => publishSettled(next, seenResults, sawSuccess);
    if (freshPublishResult(page, seenResults)) return page;
    const button = publishButton(page);
    if (button) {
      await this.browser.click(page.tabId, button.ref);
      page = await this.poll(page.tabId, settled, 45);
    }
    if (!settled(page) && editorStillOpen(page) && !/发布中|正在发布/.test(page.text ?? "")) {
      await this.browser.clickText(page.tabId, "发布");
      page = await this.poll(page.tabId, settled, 45);
    }
    if ((page.text ?? "").includes("确认发布") && !freshPublishResult(page, seenResults)) {
      await this.browser.clickText(page.tabId, "确认发布");
      page = await this.poll(page.tabId, settled, 20);
    }
    if (publishSucceeded(page) && !sawSuccess && !noteUrl(page)) {
      try {
        await this.browser.clickText(page.tabId, "查看笔记");
        page = await this.poll(page.tabId, (next) => Boolean(noteUrl(next)), 15);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!message.includes("Browser element not found: 查看笔记")) throw error;
      }
    }
    return page;
  }

  private async advanceImageStep(page: BrowserPublishPage): Promise<BrowserPublishPage> {
    await this.browser.clickText(page.tabId, "生成图片");
    let current = await this.browser.snapshot(page.tabId);
    if (noteLimitOnPage(current)) return current;
    let idle = 0;
    let clicks = 1;
    let coverClicked = false;
    for (let attempt = 0; attempt < IMAGE_STEP_ATTEMPTS && !imageStepAdvanced(current); attempt += 1) {
      if (noteLimitOnPage(current)) return current;
      const cover = coverChoice(current);
      if (!coverClicked && cover) {
        coverClicked = true;
        await this.browser.click(current.tabId, cover.ref);
        current = await this.browser.snapshot(current.tabId);
        idle = 0;
        continue;
      }
      const text = current.text ?? "";
      if (
        clicks < 2
        && idle >= IMAGE_RETRY_IDLE
        && !imageGenerating(current)
        && text.includes("生成图片")
        && !text.includes("重新生成")
      ) {
        await this.browser.clickText(current.tabId, "生成图片");
        clicks += 1;
        idle = 0;
      }
      await delay(this.waitMs);
      current = await this.browser.snapshot(current.tabId);
      idle = imageStepAdvanced(current) || imageGenerating(current) ? 0 : idle + 1;
    }
    return current;
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

export async function beginXiaohongshuLogin(browser: BrowserPublishSession) {
  const existing = await findLoggedInCreatorPage(browser);
  if (!existing) await browser.open(XIAOHONGSHU_BROWSER_ACCOUNT.loginUrl);
  return { status: "needs_auth" as const, loginUrl: XIAOHONGSHU_BROWSER_ACCOUNT.loginUrl };
}

export async function confirmXiaohongshuLogin(
  browser: BrowserPublishSession,
  db: Database,
  credentials: InMemoryCredentialProvider,
  subject: SubjectRef,
) {
  const page = (await findLoggedInCreatorPage(browser)) ?? (await openAndRead(browser));
  const state = xiaohongshuLoginState(page);
  if (state !== "logged_in") {
    throw new Error(
      state === "logged_out"
        ? "还没有登录。请在创作者页面完成登录后再确认。"
        : "无法确认已经登录。请在创作者页面完成登录后再确认。",
    );
  }
  credentials.put(XIAOHONGSHU_BROWSER_ACCOUNT.credentialRef, SESSION_MARKER);
  connectPublishAccount(db, { ...XIAOHONGSHU_BROWSER_ACCOUNT, subject });
  return {
    connectorId: XIAOHONGSHU_BROWSER_ACCOUNT.connectorId,
    accountId: XIAOHONGSHU_BROWSER_ACCOUNT.accountId,
    name: XIAOHONGSHU_BROWSER_ACCOUNT.accountName,
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
    if (url.protocol !== "https:" || url.hostname !== "creator.xiaohongshu.com") continue;
    if (url.pathname.startsWith("/login")) continue;
    const page = await browser.snapshot(tab.tabId);
    if (xiaohongshuLoginState(page) === "logged_in") return page;
  }
  return null;
}

async function openAndRead(browser: BrowserPublishSession): Promise<BrowserPublishPage> {
  const opened = await browser.open(XIAOHONGSHU_BROWSER_ACCOUNT.loginUrl);
  return browser.snapshot(opened.tabId);
}

function publishSurfaceReady(page: BrowserPublishPage): boolean {
  const state = xiaohongshuLoginState(page);
  if (state === "logged_out") return true;
  if (state !== "logged_in") return false;
  const text = page.text ?? "";
  return Boolean(noteField(page)) || /上传图文|文字配图|生成图片|写文字/.test(text);
}

function noteCharCount(text: string): number {
  return Array.from(text).length;
}

export function splitXiaohongshuNoteCards(text: string, max = XIAOHONGSHU_IMAGE_NOTE_MAX): string[] {
  const chars = Array.from(text);
  const cards: string[] = [];
  let start = 0;
  while (start < chars.length) {
    let end = Math.min(start + max, chars.length);
    if (end < chars.length) {
      const window = chars.slice(start, end);
      let breakAt = -1;
      for (let index = window.length - 1; index >= Math.floor(max * 0.6); index -= 1) {
        if (/[。！？\n]/.test(window[index] ?? "")) {
          breakAt = index + 1;
          break;
        }
      }
      if (breakAt > 0) end = start + breakAt;
    }
    const card = chars.slice(start, end).join("").trim();
    if (card) cards.push(card);
    if (end <= start) break;
    start = end;
  }
  return cards.length ? cards : [text];
}

function noteTooLongError(length: number): string {
  return `小红书文字配图最多 ${XIAOHONGSHU_IMAGE_NOTE_MAX} 字，这篇有 ${length} 字。请缩短后再发。`;
}

function noteLimitOnPage(page: BrowserPublishPage): string | undefined {
  const text = page.text ?? "";
  if (!/最多\s*500\s*字/.test(text)) return undefined;
  const count = text.match(/(\d+)\s*\/\s*500/);
  return noteTooLongError(count ? Number(count[1]) : XIAOHONGSHU_IMAGE_NOTE_MAX + 1);
}

function noteBoxes(page: BrowserPublishPage) {
  return page.elements.filter((element) => element.role === "textbox");
}

function unusedNoteField(page: BrowserPublishPage, used: Set<string>) {
  const boxes = noteBoxes(page).filter((element) => !used.has(element.ref));
  const body = boxes.filter(
    (element) => /正文|笔记|写文字|输入文字/.test(element.name ?? "") && !/标题/.test(element.name ?? ""),
  );
  const other = boxes.filter((element) => !/标题/.test(element.name ?? ""));
  const pool = body.length ? body : other.length ? other : used.size === 0 ? boxes : [];
  return pool[pool.length - 1];
}

function bodyNoteField(page: BrowserPublishPage) {
  return noteBoxes(page).find(
    (element) => /正文|笔记|写文字|输入文字/.test(element.name ?? "") && !/标题/.test(element.name ?? ""),
  );
}

function onComposer(page: BrowserPublishPage): boolean {
  if (bodyNoteField(page)) return true;
  const text = page.text ?? "";
  return /写文字|生成图片|暂存离开|定时发布/.test(text);
}

function noteField(page: BrowserPublishPage) {
  return unusedNoteField(page, new Set());
}

function imageStepAdvanced(page: BrowserPublishPage): boolean {
  return Boolean(publishButton(page) || (page.text ?? "").includes("下一步"));
}

function imageGenerating(page: BrowserPublishPage): boolean {
  return /生成中|正在生成|请稍候|请稍后/.test(page.text ?? "");
}

function coverChoice(page: BrowserPublishPage) {
  const text = page.text ?? "";
  if (imageStepAdvanced(page) || !/重新生成|换一张|选择图片|选择封面/.test(text)) return undefined;
  return page.elements.find((element) => element.role === "img")
    ?? page.elements.find(
      (element) => element.role === "button"
        && /封面|配图|使用这张/.test(element.name ?? "")
        && !/生成/.test(element.name ?? ""),
    );
}

function publishSettled(
  page: BrowserPublishPage,
  seenResults: Set<string>,
  sawSuccess: boolean,
): boolean {
  return Boolean(freshPublishResult(page, seenResults) || (publishSucceeded(page) && !sawSuccess));
}

function rememberPublishResult(page: BrowserPublishPage, seenResults: Set<string>) {
  const note = noteUrl(page);
  const creator = creatorPublishedUrl(page);
  if (note) seenResults.add(note);
  if (creator) seenResults.add(creator);
}

function freshPublishResult(page: BrowserPublishPage, seenResults: Set<string>): string | undefined {
  const note = noteUrl(page);
  if (note && !seenResults.has(note)) return note;
  const creator = creatorPublishedUrl(page);
  if (creator && !seenResults.has(creator)) return creator;
  return undefined;
}

function publishSucceeded(page: BrowserPublishPage): boolean {
  return /发布成功/.test(page.text ?? "");
}

function editorStillOpen(page: BrowserPublishPage): boolean {
  if (publishSucceeded(page)) return false;
  const text = page.text ?? "";
  return text.includes("暂存离开") || text.includes("定时发布") || Boolean(publishButton(page));
}

function publishButton(page: BrowserPublishPage) {
  return page.elements.find(
    (element) => element.role === "button"
      && (element.name ?? "").includes("发布")
      && !/草稿|发布笔记/.test(element.name ?? ""),
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function creatorPublishedUrl(page: BrowserPublishPage): string | undefined {
  try {
    const url = new URL(page.url);
    if (url.protocol !== "https:" || url.hostname !== "creator.xiaohongshu.com") return undefined;
    if (url.searchParams.get("published") !== "true") return undefined;
    return url.href;
  } catch {
    return undefined;
  }
}

function publishResultUrl(page: BrowserPublishPage): string | undefined {
  return noteUrl(page) ?? creatorPublishedUrl(page);
}

function noteUrl(page: BrowserPublishPage): string | undefined {
  const candidates = [page.url, page.text ?? ""];
  for (const element of page.elements) {
    if (element.name) candidates.push(element.name);
    if (element.href) candidates.push(element.href);
  }
  for (const candidate of candidates) {
    const match = candidate.match(/https:\/\/(?:www\.xiaohongshu\.com|xhslink\.com)\/[^\s"'<>]+/);
    if (match) return match[0];
  }
  return undefined;
}
