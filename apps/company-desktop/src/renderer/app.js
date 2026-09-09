function companyApi() {
  return window.forgeCompany;
}

async function openWorkbench(url) {
  const api = companyApi();
  if (!api?.openWorkbench) return;
  try {
    await api.openWorkbench(url);
  } catch (error) {
    console.error("[forge-company] openWorkbench failed", error);
  }
}

document.getElementById("openWorkbenchBtn")?.addEventListener("click", () => {
  void openWorkbench();
});

document.getElementById("openRunBtn")?.addEventListener("click", () => {
  void openWorkbench("forge://workbench/run/r_8f21");
});
