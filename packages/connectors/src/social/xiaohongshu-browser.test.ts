import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ForgeStore } from "@forge/store";
import { InMemoryCredentialProvider } from "../credentials.js";
import { listPublishAccounts } from "./accounts.js";
import {
  XiaohongshuBrowserAdapter,
  beginXiaohongshuLogin,
  confirmXiaohongshuLogin,
  splitXiaohongshuNoteCards,
  xiaohongshuPublishText,
  type BrowserPublishPage,
  type BrowserPublishSession,
} from "./xiaohongshu-browser.js";

const migrationsDir = join(import.meta.dirname, "..", "..", "..", "..", "migrations");
const roots: string[] = [];
const stores: ForgeStore[] = [];
const subject = { kind: "human", id: "local" };

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function publishInput() {
  return {
    proposalId: "p1",
    connectorId: "xiaohongshu-browser",
    connectorAccountId: "xiaohongshu-browser-account",
    action: "publish" as const,
    payload: { note: "你好" },
    approvalId: "a1",
  };
}

function page(overrides: Partial<BrowserPublishPage> = {}): BrowserPublishPage {
  return {
    tabId: "tab-1",
    url: "https://creator.xiaohongshu.com/",
    title: "创作中心",
    text: "发布笔记 笔记管理",
    elements: [],
    ...overrides,
  };
}

function session(pages: BrowserPublishPage[], tabs: Array<{ tabId: string; url: string; title: string }> = []): BrowserPublishSession & { opened: string[]; typed: string[]; typedAt: string[]; clicked: string[]; clickedAt: string[] } {
  let cursor = 0;
  const opened: string[] = [];
  const typed: string[] = [];
  const typedAt: string[] = [];
  const clicked: string[] = [];
  const clickedAt: string[] = [];
  return {
    opened,
    typed,
    typedAt,
    clicked,
    clickedAt,
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
    async type(_tabId, ref, text) {
      typed.push(text);
      typedAt.push(ref);
    },
    async click(_tabId, ref) {
      clickedAt.push(ref);
    },
  };
}

describe("Xiaohongshu browser login", () => {
  it("opens the creator site without creating an account", async () => {
    const browser = session([page({ text: "扫码登录" })]);
    const started = await beginXiaohongshuLogin(browser);
    expect(started.loginUrl).toBe("https://creator.xiaohongshu.com/new/home");
    expect(browser.opened).toEqual(["https://creator.xiaohongshu.com/new/home"]);
  });

  it("refuses to connect while the login page is showing", async () => {
    const root = mkdtempSync(join(tmpdir(), "forge-xhs-"));
    roots.push(root);
    const store = ForgeStore.open({ dbPath: join(root, "data.db"), migrationsDir, owner: "test" });
    stores.push(store);
    store.db
      .prepare(
        `INSERT INTO core_policy_versions (id, name, version, rules_json, is_active, created_at)
         VALUES ('policy-v1', 'default', 1, '{"rules":[]}', 1, ?)`,
      )
      .run(new Date().toISOString());
    await expect(
      confirmXiaohongshuLogin(session([page({ text: "扫码登录" })]), store.db, new InMemoryCredentialProvider(), subject),
    ).rejects.toThrow(/还没有登录/);
    expect(listPublishAccounts(store.db, subject)).toEqual([]);
  });

  it("connects after the creator home is visible and does not store a page token", async () => {
    const root = mkdtempSync(join(tmpdir(), "forge-xhs-ok-"));
    roots.push(root);
    const store = ForgeStore.open({ dbPath: join(root, "data.db"), migrationsDir, owner: "test" });
    stores.push(store);
    store.db
      .prepare(
        `INSERT INTO core_policy_versions (id, name, version, rules_json, is_active, created_at)
         VALUES ('policy-v1', 'default', 1, '{"rules":[]}', 1, ?)`,
      )
      .run(new Date().toISOString());
    const credentials = new InMemoryCredentialProvider();
    const account = await confirmXiaohongshuLogin(session([page()]), store.db, credentials, subject);
    expect(account).toEqual({
      connectorId: "xiaohongshu-browser",
      accountId: "xiaohongshu-browser-account",
      name: "创作者账号",
    });
    const resolved = await credentials.resolve("cred://xiaohongshu-browser");
    expect(new TextDecoder().decode(resolved.bytes)).toBe("browser-session");
    expect(JSON.stringify(account)).not.toContain("browser-session");
  });

  it("uses an already logged-in creator tab", async () => {
    const root = mkdtempSync(join(tmpdir(), "forge-xhs-tab-"));
    roots.push(root);
    const store = ForgeStore.open({ dbPath: join(root, "data.db"), migrationsDir, owner: "test" });
    stores.push(store);
    store.db
      .prepare(
        `INSERT INTO core_policy_versions (id, name, version, rules_json, is_active, created_at)
         VALUES ('policy-v1', 'default', 1, '{"rules":[]}', 1, ?)`,
      )
      .run(new Date().toISOString());
    const home = page({ url: "https://creator.xiaohongshu.com/new/home", text: "发布笔记 笔记管理" });
    const browser = session([home], [{ tabId: "tab-1", url: home.url, title: home.title }]);
    const account = await confirmXiaohongshuLogin(browser, store.db, new InMemoryCredentialProvider(), subject);
    expect(account.accountId).toBe("xiaohongshu-browser-account");
    expect(browser.opened).toEqual([]);
  });
});

describe("XiaohongshuBrowserAdapter", () => {
  it("reads a content string as the note", () => {
    expect(xiaohongshuPublishText({ content: "你好" })).toBe("你好");
  });

  it("keeps a long note and splits it into 500 character cards", () => {
    const note = `${"学".repeat(400)}。${"习".repeat(200)}。`;
    expect(xiaohongshuPublishText({ note })).toBe(note);
    const cards = splitXiaohongshuNoteCards(note);
    expect(cards).toHaveLength(2);
    expect(Array.from(cards[0] ?? "").length).toBeLessThanOrEqual(500);
    expect(cards[0]?.endsWith("。")).toBe(true);
    expect(cards.join("")).toBe(note);
  });

  it("marks the account for login when the publish page is logged out", async () => {
    const marked: string[] = [];
    const adapter = new XiaohongshuBrowserAdapter(
      session([page({ text: "扫码登录" })]),
      (accountId) => marked.push(accountId),
    );
    const result = await adapter.execute(
      {
        proposalId: "p1",
        connectorId: "xiaohongshu-browser",
        connectorAccountId: "xiaohongshu-browser-account",
        action: "publish",
        payload: { note: "你好" },
        approvalId: "a1",
      },
      { ref: "cred://xiaohongshu-browser", bytes: new Uint8Array() },
    );
    expect(result.ok).toBe(false);
    expect(marked).toEqual(["xiaohongshu-browser-account"]);
  });

  it("types the note and returns the note link", async () => {
    const composer = page({
      elements: [
        { ref: "e1", role: "textbox", name: "正文" },
        { ref: "e2", role: "button", name: "发布" },
      ],
    });
    const done = page({
      url: "https://creator.xiaohongshu.com/publish/publish",
      text: "已发布 https://www.xiaohongshu.com/explore/abc",
    });
    const browser = session([composer, done]);
    const adapter = new XiaohongshuBrowserAdapter(browser, () => {});
    const result = await adapter.execute(
      {
        proposalId: "p1",
        connectorId: "xiaohongshu-browser",
        connectorAccountId: "xiaohongshu-browser-account",
        action: "publish",
        payload: { note: "你好", images: [] },
        approvalId: "a1",
      },
      { ref: "cred://xiaohongshu-browser", bytes: new Uint8Array() },
    );
    expect(browser.typed).toEqual(["你好"]);
    expect(result).toMatchObject({ ok: true, url: "https://www.xiaohongshu.com/explore/abc" });
  });

  it("waits for the creator page to finish rendering", async () => {
    const browser = session([
      page({ url: "https://creator.xiaohongshu.com/publish/publish", title: "", text: "" }),
      page({
        url: "https://creator.xiaohongshu.com/publish/publish",
        elements: [
          { ref: "e1", role: "textbox", name: "正文" },
          { ref: "e2", role: "button", name: "发布" },
        ],
      }),
      page({ text: "已发布 https://www.xiaohongshu.com/explore/abc" }),
    ]);
    const adapter = new XiaohongshuBrowserAdapter(browser, () => {});
    const result = await adapter.execute(publishInput(), { ref: "cred://xiaohongshu-browser", bytes: new Uint8Array() });
    expect(result).toMatchObject({ ok: true, url: "https://www.xiaohongshu.com/explore/abc" });
  });

  it("reuses a logged-in creator tab and opens the text composer", async () => {
    const home = page({ url: "https://creator.xiaohongshu.com/new/home" });
    const browser = session([
      home,
      page({ url: "https://creator.xiaohongshu.com/publish/publish", text: "发布笔记 上传图文", elements: [] }),
      page({ text: "发布笔记 文字配图", elements: [{ ref: "e8", role: "button", name: "文字配图" }] }),
      page({ text: "发布笔记 写文字 生成图片", elements: [{ ref: "e9", role: "textbox", name: "" }] }),
      page({ text: "下一步", elements: [] }),
      page({ elements: [{ ref: "e20", role: "button", name: "发布" }] }),
      page({ text: "已发布 https://www.xiaohongshu.com/explore/abc" }),
    ], [{ tabId: "tab-1", url: home.url, title: home.title }]);
    const adapter = new XiaohongshuBrowserAdapter(browser, () => {});
    const result = await adapter.execute(publishInput(), { ref: "cred://xiaohongshu-browser", bytes: new Uint8Array() });
    expect(browser.opened).toEqual(["https://creator.xiaohongshu.com/publish/publish"]);
    expect(browser.clicked).toEqual(["上传图文", "文字配图", "生成图片", "下一步"]);
    expect(browser.typed).toEqual(["你好"]);
    expect(result).toMatchObject({ ok: true, url: "https://www.xiaohongshu.com/explore/abc" });
  });

  it("waits until the publish choices appear after the sidebar", async () => {
    const browser = session([
      page({ text: "发布笔记 笔记管理", elements: [] }),
      page({
        elements: [
          { ref: "e1", role: "textbox", name: "正文" },
          { ref: "e2", role: "button", name: "发布" },
        ],
      }),
      page({ text: "已发布 https://www.xiaohongshu.com/explore/abc" }),
    ]);
    const adapter = new XiaohongshuBrowserAdapter(browser, () => {});
    const result = await adapter.execute(publishInput(), { ref: "cred://xiaohongshu-browser", bytes: new Uint8Array() });
    expect(browser.typed).toEqual(["你好"]);
    expect(result).toMatchObject({ ok: true, url: "https://www.xiaohongshu.com/explore/abc" });
  });

  it("treats the creator published flag as success", async () => {
    const published = "https://creator.xiaohongshu.com/publish/publish?source=&published=true";
    const browser = session([
      page({
        elements: [
          { ref: "e1", role: "textbox", name: "正文" },
          { ref: "e2", role: "button", name: "发布" },
        ],
      }),
      page({ url: published, text: "上传视频 上传图文" }),
    ]);
    const adapter = new XiaohongshuBrowserAdapter(browser, () => {});
    const result = await adapter.execute(publishInput(), { ref: "cred://xiaohongshu-browser", bytes: new Uint8Array() });
    expect(result).toMatchObject({ ok: true, url: published });
  });

  it("does not publish when images are included", async () => {
    const adapter = new XiaohongshuBrowserAdapter(session([page()]), () => {});
    const result = await adapter.execute(
      {
        proposalId: "p1",
        connectorId: "xiaohongshu-browser",
        connectorAccountId: "xiaohongshu-browser-account",
        action: "publish",
        payload: { note: "你好", images: ["a.png"] },
        approvalId: "a1",
      },
      { ref: "cred://xiaohongshu-browser", bytes: new Uint8Array() },
    );
    expect(result).toMatchObject({ ok: false, error: "创作者页面的图片上传还没有接上" });
  });

  it("types the body instead of the title and clicks generate again when the first click stays put", async () => {
    const composer = page({
      text: "发布笔记 写文字 生成图片",
      elements: [
        { ref: "title", role: "textbox", name: "标题" },
        { ref: "body", role: "textbox", name: "正文" },
      ],
    });
    const stuck = page({ text: "发布笔记 写文字 生成图片", elements: [{ ref: "body", role: "textbox", name: "正文" }] });
    const browser = session([
      composer,
      ...Array.from({ length: 9 }, () => stuck),
      page({ text: "下一步" }),
      page({ elements: [{ ref: "go", role: "button", name: "发布" }] }),
      page({ text: "已发布 https://www.xiaohongshu.com/explore/abc" }),
    ]);
    const adapter = new XiaohongshuBrowserAdapter(browser, () => {}, 0);
    const result = await adapter.execute(publishInput(), { ref: "cred://xiaohongshu-browser", bytes: new Uint8Array() });
    expect(browser.typedAt).toEqual(["body"]);
    expect(browser.clicked.filter((label) => label === "生成图片")).toEqual(["生成图片", "生成图片"]);
    expect(result).toMatchObject({ ok: true, url: "https://www.xiaohongshu.com/explore/abc" });
  });

  it("does not click generate again while images are still generating", async () => {
    const composer = page({
      text: "发布笔记 写文字 生成图片",
      elements: [{ ref: "body", role: "textbox", name: "正文" }],
    });
    const browser = session([
      composer,
      page({ text: "正在生成图片" }),
      page({ text: "下一步" }),
      page({ elements: [{ ref: "go", role: "button", name: "发布" }] }),
      page({ text: "已发布 https://www.xiaohongshu.com/explore/abc" }),
    ]);
    const adapter = new XiaohongshuBrowserAdapter(browser, () => {}, 0);
    const result = await adapter.execute(publishInput(), { ref: "cred://xiaohongshu-browser", bytes: new Uint8Array() });
    expect(browser.clicked.filter((label) => label === "生成图片")).toEqual(["生成图片"]);
    expect(result).toMatchObject({ ok: true, url: "https://www.xiaohongshu.com/explore/abc" });
  });

  it("selects a generated cover before the next step", async () => {
    const composer = page({
      text: "发布笔记 写文字 生成图片",
      elements: [{ ref: "body", role: "textbox", name: "正文" }],
    });
    const browser = session([
      composer,
      page({ text: "重新生成 选择封面", elements: [{ ref: "cover", role: "img", name: "封面" }] }),
      page({ text: "下一步" }),
      page({ elements: [{ ref: "go", role: "button", name: "发布" }] }),
      page({ text: "已发布 https://www.xiaohongshu.com/explore/abc" }),
    ]);
    const adapter = new XiaohongshuBrowserAdapter(browser, () => {}, 0);
    const result = await adapter.execute(publishInput(), { ref: "cred://xiaohongshu-browser", bytes: new Uint8Array() });
    expect(browser.clickedAt).toContain("cover");
    expect(browser.clicked.filter((label) => label === "生成图片")).toEqual(["生成图片"]);
    expect(result).toMatchObject({ ok: true, url: "https://www.xiaohongshu.com/explore/abc" });
  });

  it("writes another card when the note is longer than 500 characters", async () => {
    const note = `${"学".repeat(400)}。${"习".repeat(200)}。`;
    const cards = splitXiaohongshuNoteCards(note);
    const composer = page({
      text: "发布笔记 写文字 生成图片",
      elements: [{ ref: "e1", role: "textbox", name: "正文" }],
    });
    const browser = session([
      composer,
      page({
        text: "发布笔记 写文字 生成图片 再写一张",
        elements: [
          { ref: "e1", role: "textbox", name: "正文" },
          { ref: "e2", role: "textbox", name: "正文" },
        ],
      }),
      page({ text: "下一步" }),
      page({ elements: [{ ref: "go", role: "button", name: "发布" }] }),
      page({ text: "已发布 https://www.xiaohongshu.com/explore/abc" }),
    ]);
    const adapter = new XiaohongshuBrowserAdapter(browser, () => {}, 0);
    const result = await adapter.execute(
      { ...publishInput(), payload: { note } },
      { ref: "cred://xiaohongshu-browser", bytes: new Uint8Array() },
    );
    expect(browser.typed).toEqual(cards);
    expect(browser.typedAt).toEqual(["e1", "e2"]);
    expect(browser.clicked).toContain("再写一张");
    expect(result).toMatchObject({ ok: true, url: "https://www.xiaohongshu.com/explore/abc" });
  });

  it("stops when the image page says the note is over 500 characters", async () => {
    const composer = page({
      text: "发布笔记 写文字 生成图片",
      elements: [{ ref: "body", role: "textbox", name: "正文" }],
    });
    const blocked = page({ text: "最多500字，请删除后重试 1489 / 500字 生成图片" });
    const browser = session([composer, blocked]);
    const adapter = new XiaohongshuBrowserAdapter(browser, () => {}, 0);
    const result = await adapter.execute(publishInput(), { ref: "cred://xiaohongshu-browser", bytes: new Uint8Array() });
    expect(browser.clicked.filter((label) => label === "生成图片")).toEqual(["生成图片"]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("这篇有 1489 字");
  });

  it("uses a real publish click and opens the note when the editor stays put", async () => {
    const editor = page({
      text: "暂存离开 定时发布",
      elements: [
        { ref: "body", role: "textbox", name: "正文" },
        { ref: "go", role: "button", name: "发布" },
      ],
    });
    const success = page({
      text: "发布成功",
      elements: [{ ref: "view", role: "link", name: "查看笔记", href: "https://www.xiaohongshu.com/explore/abc" }],
    });
    let stage: "editor" | "success" = "editor";
    const browser = session([editor]);
    const clickText = browser.clickText.bind(browser);
    browser.clickText = async (tabId, text) => {
      await clickText(tabId, text);
      if (text === "发布") stage = "success";
    };
    browser.snapshot = async () => (stage === "success" ? success : editor);
    const adapter = new XiaohongshuBrowserAdapter(browser, () => {}, 0);
    const result = await adapter.execute(publishInput(), { ref: "cred://xiaohongshu-browser", bytes: new Uint8Array() });
    expect(browser.clickedAt).toContain("go");
    expect(browser.clicked).toEqual(["发布"]);
    expect(result).toMatchObject({ ok: true, url: "https://www.xiaohongshu.com/explore/abc" });
  });

  it("says the note is already published when success has no note link", async () => {
    const editor = page({
      text: "暂存离开",
      elements: [
        { ref: "body", role: "textbox", name: "正文" },
        { ref: "go", role: "button", name: "发布" },
      ],
    });
    const success = page({ text: "发布成功" });
    let stage: "editor" | "success" = "editor";
    const browser = session([editor]);
    browser.clickText = async (_tabId, text) => {
      browser.clicked.push(text);
      if (text === "发布") stage = "success";
      if (text === "查看笔记") throw new Error("Browser element not found: 查看笔记");
    };
    browser.snapshot = async () => (stage === "success" ? success : editor);
    const adapter = new XiaohongshuBrowserAdapter(browser, () => {}, 0);
    const result = await adapter.execute(publishInput(), { ref: "cred://xiaohongshu-browser", bytes: new Uint8Array() });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("笔记已经发布");
  });

  it("does not treat the previous published flag as this note", async () => {
    const stale = "https://creator.xiaohongshu.com/publish/publish?source=&published=true";
    const browser = session([
      page({
        url: stale,
        text: "暂存离开",
        elements: [
          { ref: "e1", role: "textbox", name: "正文" },
          { ref: "e2", role: "button", name: "发布" },
        ],
      }),
      page({
        url: stale,
        text: "发布成功",
        elements: [{ ref: "view", role: "link", name: "查看笔记", href: "https://www.xiaohongshu.com/explore/new-note" }],
      }),
    ]);
    const adapter = new XiaohongshuBrowserAdapter(browser, () => {}, 0);
    const result = await adapter.execute(publishInput(), { ref: "cred://xiaohongshu-browser", bytes: new Uint8Array() });
    expect(browser.clickedAt).toContain("e2");
    expect(browser.typed).toEqual(["你好"]);
    expect(result).toMatchObject({ ok: true, url: "https://www.xiaohongshu.com/explore/new-note" });
  });

  it("reports the image step itself when generate never advances", async () => {
    const composer = page({
      text: "发布笔记 写文字 生成图片",
      elements: [{ ref: "body", role: "textbox", name: "正文" }],
    });
    const browser = session([composer]);
    const adapter = new XiaohongshuBrowserAdapter(browser, () => {}, 0);
    const result = await adapter.execute(publishInput(), { ref: "cred://xiaohongshu-browser", bytes: new Uint8Array() });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("配图页面没有往下走");
      expect(result.error).not.toContain("换一句更完整的正文");
    }
  });
});
