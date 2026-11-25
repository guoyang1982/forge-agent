import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ForgeStore } from "@forge/store";
import { InMemoryCredentialProvider } from "../credentials.js";
import { listPublishAccounts } from "./accounts.js";
import type { BrowserPublishPage, BrowserPublishSession } from "./xiaohongshu-browser.js";
import {
  ToutiaoBrowserAdapter,
  beginToutiaoLogin,
  confirmToutiaoLogin,
  toutiaoArticle,
  toutiaoLoginState,
} from "./toutiao-browser.js";

const migrationsDir = join(import.meta.dirname, "..", "..", "..", "..", "migrations");
const roots: string[] = [];
const stores: ForgeStore[] = [];
const subject = { kind: "human", id: "local" };
const article = "https://www.toutiao.com/item/7613329346194850310";

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function publishInput(payload: Record<string, unknown> = { title: "两字标题", content: "正文" }) {
  return {
    proposalId: "p1",
    connectorId: "toutiao-browser",
    connectorAccountId: "toutiao-browser-account",
    action: "publish" as const,
    payload,
    approvalId: "a1",
  };
}

function page(overrides: Partial<BrowserPublishPage> = {}): BrowserPublishPage {
  return {
    tabId: "tab-1",
    url: "https://mp.toutiao.com/profile_v4/index",
    title: "头条号",
    text: "创作首页 内容管理",
    elements: [],
    ...overrides,
  };
}

function confirmStep(label: "确认发布" | "立即发布" = "确认发布", url?: string): BrowserPublishPage {
  return page({
    ...(url ? { url } : {}),
    text: `${label} 返回编辑`,
    elements: [{ ref: "ok", role: "button", name: label }],
  });
}

function editor(text = "创作首页 预览并发布"): BrowserPublishPage {
  return page({
    url: "https://mp.toutiao.com/profile_v4/graphic/publish",
    text,
    elements: [
      { ref: "title", role: "textbox", name: "文章标题" },
      { ref: "body", role: "textbox", name: "正文" },
    ],
  });
}

function session(pages: BrowserPublishPage[], tabs: Array<{ tabId: string; url: string; title: string }> = []) {
  let cursor = 0;
  const opened: string[] = [];
  const typed: string[] = [];
  const clicked: string[] = [];
  const browser: BrowserPublishSession & { opened: string[]; typed: string[]; clicked: string[] } = {
    opened,
    typed,
    clicked,
    async listTabs() {
      return tabs;
    },
    async open(url) {
      opened.push(url);
      return pages[Math.min(cursor, pages.length - 1)]!;
    },
    async navigate(_tabId, url) {
      opened.push(url);
      return pages[Math.min(cursor, pages.length - 1)]!;
    },
    async snapshot() {
      const current = pages[Math.min(cursor, pages.length - 1)]!;
      cursor += 1;
      return current;
    },
    async clickText(_tabId, text) {
      clicked.push(text);
    },
    async type(_tabId, _ref, text) {
      typed.push(text);
    },
    async click() {},
  };
  return browser;
}

function openStore(prefix: string) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  const store = ForgeStore.open({ dbPath: join(root, "data.db"), migrationsDir, owner: "test" });
  stores.push(store);
  store.db
    .prepare(
      `INSERT INTO core_policy_versions (id, name, version, rules_json, is_active, created_at)
       VALUES ('policy-v1', 'default', 1, '{"rules":[]}', 1, ?)`,
    )
    .run(new Date().toISOString());
  return store;
}

describe("Toutiao browser login", () => {
  it("opens the creator site without creating an account", async () => {
    const browser = session([page({ text: "扫码登录" })]);
    const started = await beginToutiaoLogin(browser);
    expect(started.loginUrl).toBe("https://mp.toutiao.com/profile_v4/index");
    expect(browser.opened).toEqual(["https://mp.toutiao.com/profile_v4/index"]);
  });

  it("refuses to connect while the login page is showing", async () => {
    const store = openStore("forge-toutiao-");
    await expect(
      confirmToutiaoLogin(
        session([page({ url: "https://mp.toutiao.com/auth/page/login", text: "扫码登录" })]),
        store.db,
        new InMemoryCredentialProvider(),
        subject,
      ),
    ).rejects.toThrow(/还没有登录/);
    expect(listPublishAccounts(store.db, subject)).toEqual([]);
  });

  it("connects after the creator home is visible and does not store a page token", async () => {
    const store = openStore("forge-toutiao-ok-");
    const credentials = new InMemoryCredentialProvider();
    const account = await confirmToutiaoLogin(session([page()]), store.db, credentials, subject);
    expect(account).toEqual({
      connectorId: "toutiao-browser",
      accountId: "toutiao-browser-account",
      name: "创作者账号",
    });
    const resolved = await credentials.resolve("cred://toutiao-browser");
    expect(new TextDecoder().decode(resolved.bytes)).toBe("browser-session");
    expect(JSON.stringify(account)).not.toContain("browser-session");
  });

  it("uses an already logged-in creator tab", async () => {
    const store = openStore("forge-toutiao-tab-");
    const home = page();
    const browser = session([home], [{ tabId: "tab-1", url: home.url, title: home.title }]);
    const account = await confirmToutiaoLogin(browser, store.db, new InMemoryCredentialProvider(), subject);
    expect(account.accountId).toBe("toutiao-browser-account");
    expect(browser.opened).toEqual([]);
  });
});

describe("ToutiaoBrowserAdapter", () => {
  it("treats the article editor as logged in", () => {
    expect(toutiaoLoginState({
      url: "https://mp.toutiao.com/profile_v4/graphic/publish",
      title: "头条号",
      text: "发布文章 请输入正文 预览并发布 无封面",
    })).toBe("logged_in");
  });

  it("requires a title and a body", () => {
    expect(toutiaoArticle({ content: "只有正文" })).toMatchObject({ ok: false });
    expect(toutiaoArticle({ title: "好", content: "正文" })).toMatchObject({ ok: false });
    expect(toutiaoArticle({ title: "两字起", content: "正文" })).toEqual({ title: "两字起", body: "正文" });
  });

  it("rejects images before opening the editor", async () => {
    const browser = session([editor()]);
    const adapter = new ToutiaoBrowserAdapter(browser, () => {});
    const result = await adapter.execute(
      publishInput({ title: "两字起", content: "正文", images: ["cover.png"] }),
      { ref: "cred://toutiao-browser", bytes: new Uint8Array() },
    );
    expect(result).toMatchObject({ ok: false, error: "创作者页面的图片和封面上传还没有接上" });
    expect(browser.opened).toEqual([]);
  });

  it("marks the account for login when the publish page is logged out", async () => {
    const marked: string[] = [];
    const adapter = new ToutiaoBrowserAdapter(
      session([page({ url: "https://sso.toutiao.com/login", text: "扫码登录" })]),
      (accountId) => marked.push(accountId),
    );
    const result = await adapter.execute(publishInput(), { ref: "cred://toutiao-browser", bytes: new Uint8Array() });
    expect(result).toMatchObject({ ok: false, error: "创作者登录已失效" });
    expect(marked).toEqual(["toutiao-browser-account"]);
  });

  it("stops before publishing when the page still asks for a cover", async () => {
    const asking = editor("创作首页 预览并发布 请上传封面");
    const browser = session([asking, asking]);
    const adapter = new ToutiaoBrowserAdapter(browser, () => {});
    const result = await adapter.execute(publishInput(), { ref: "cred://toutiao-browser", bytes: new Uint8Array() });
    expect(result).toMatchObject({ ok: false, error: "文章还缺封面，封面上传还没有接上" });
    expect(browser.clicked).toEqual([]);
  });

  it("waits until the body editor appears after the title", async () => {
    const titleOnly = page({
      url: "https://mp.toutiao.com/profile_v4/graphic/publish",
      text: "发布文章 请输入文章标题 预览并发布",
      elements: [{ ref: "title", role: "textbox", name: "请输入文章标题（2～30个字）" }],
    });
    const draft = page({
      url: "https://mp.toutiao.com/profile_v4/graphic/publish",
      text: "发布文章 请输入正文 预览并发布",
      elements: [
        { ref: "title", role: "textbox", name: "请输入文章标题（2～30个字）" },
        { ref: "body", name: "请输入正文" },
      ],
    });
    const browser = session([
      titleOnly,
      draft,
      draft,
      confirmStep(),
      page({ url: "https://mp.toutiao.com/profile_v4/graphic/publish", text: `发布成功 ${article}` }),
    ]);
    const adapter = new ToutiaoBrowserAdapter(browser, () => {}, 0);
    const result = await adapter.execute(publishInput(), { ref: "cred://toutiao-browser", bytes: new Uint8Array() });
    expect(browser.typed).toEqual(["两字标题", "正文"]);
    expect(result).toMatchObject({ ok: true, url: article });
  });

  it("fills the editor that is already open and chooses no cover", async () => {
    const draft = page({
      url: "https://mp.toutiao.com/profile_v4/graphic/publish",
      text: "发布文章 请输入正文 预览并发布 无封面",
      elements: [
        { ref: "title", role: "textbox", name: "请输入文章标题（2～30个字）" },
        { ref: "body", name: "请输入正文" },
      ],
    });
    const browser = session([
      draft,
      draft,
      draft,
      confirmStep(),
      page({ url: "https://mp.toutiao.com/profile_v4/graphic/publish", text: `发布成功 ${article}` }),
    ]);
    const adapter = new ToutiaoBrowserAdapter(browser, () => {});
    const result = await adapter.execute(publishInput(), { ref: "cred://toutiao-browser", bytes: new Uint8Array() });
    expect(browser.typed).toEqual(["两字标题", "正文"]);
    expect(browser.clicked).toEqual(["无封面", "预览并发布", "确认发布"]);
    expect(result).toMatchObject({ ok: true, url: article });
  });

  it("publishes after preview and confirm, and returns the article url", async () => {
    const draft = editor();
    const browser = session([
      draft,
      draft,
      confirmStep("确认发布", "https://mp.toutiao.com/profile_v4/graphic/publish"),
      page({ url: "https://mp.toutiao.com/profile_v4/graphic/publish", text: `发布成功 ${article}` }),
    ]);
    const adapter = new ToutiaoBrowserAdapter(browser, () => {});
    const result = await adapter.execute(publishInput(), { ref: "cred://toutiao-browser", bytes: new Uint8Array() });
    expect(browser.typed).toEqual(["两字标题", "正文"]);
    expect(browser.clicked).toEqual(["预览并发布", "确认发布"]);
    expect(result).toMatchObject({ ok: true, url: article });
  });

  it("accepts the creator page once it says the article was published", async () => {
    const done = "https://mp.toutiao.com/profile_v4/manage/content";
    const draft = editor();
    const browser = session([
      draft,
      draft,
      confirmStep("立即发布"),
      page({ url: done, text: "发布成功" }),
    ]);
    const adapter = new ToutiaoBrowserAdapter(browser, () => {});
    const result = await adapter.execute(publishInput(), { ref: "cred://toutiao-browser", bytes: new Uint8Array() });
    expect(browser.clicked).toEqual(["预览并发布", "立即发布"]);
    expect(result).toMatchObject({ ok: true, url: done });
  });

  it("treats 提交成功 on the articles list as published", async () => {
    const done = "https://mp.toutiao.com/profile_v4/graphic/articles";
    const draft = editor();
    const browser = session([
      draft,
      draft,
      confirmStep(),
      page({ url: done, text: "审核中 作品管理" }),
    ]);
    const adapter = new ToutiaoBrowserAdapter(browser, () => {});
    const result = await adapter.execute(publishInput(), { ref: "cred://toutiao-browser", bytes: new Uint8Array() });
    expect(result).toMatchObject({ ok: true, url: done });
  });

  it("does not treat a publish page without a success signal as published", async () => {
    const draft = editor();
    const stalled = page({ url: "https://mp.toutiao.com/profile_v4/graphic/publish", text: "仍在编辑" });
    const browser = session([
      draft,
      draft,
      confirmStep(),
      stalled,
    ]);
    const adapter = new ToutiaoBrowserAdapter(browser, () => {}, 0);
    const result = await adapter.execute(publishInput(), { ref: "cred://toutiao-browser", bytes: new Uint8Array() });
    expect(browser.clicked).toEqual(["预览并发布", "确认发布"]);
    expect(result).toMatchObject({ ok: false, error: "发布后没有确认成功" });
  });
});
