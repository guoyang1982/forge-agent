import { parseForgeDeepLink } from "@forge/forge-links";

export function routeForgeDeepLink(raw: string): "workbench" | "company" {
  return parseForgeDeepLink(raw).app;
}

export function createProductShellMenuTemplate() {
  return [
    {
      label: "窗口",
      submenu: [
        { label: "工作台", accelerator: "CmdOrCtrl+1" },
        { label: "公司", accelerator: "CmdOrCtrl+2" },
      ],
    },
  ];
}
