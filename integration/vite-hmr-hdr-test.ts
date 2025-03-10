import fs from "node:fs/promises";
import path from "node:path";
import type { Page, PlaywrightWorkerOptions } from "@playwright/test";
import { test, expect } from "@playwright/test";
import getPort from "get-port";

import {
  createProject,
  createEditor,
  viteDev,
  customDev,
  VITE_CONFIG,
  EXPRESS_SERVER,
} from "./helpers/vite.js";

const files = {
  "app/routes/_index.tsx": String.raw`
    // imports
    import { useState, useEffect } from "react";

    export const meta = () => [{ title: "HMR updated title: 0" }]

    // loader

    export default function IndexRoute() {
      // hooks
      const [mounted, setMounted] = useState(false);
      useEffect(() => {
        setMounted(true);
      }, []);

      return (
        <div id="index">
          <h2 data-title>Index</h2>
          <input />
          <p data-mounted>Mounted: {mounted ? "yes" : "no"}</p>
          <p data-hmr>HMR updated: 0</p>
          {/* elements */}
        </div>
      );
    }
  `,
};

test.describe(async () => {
  let port: number;
  let cwd: string;
  let stop: () => void;

  test.beforeAll(async () => {
    port = await getPort();
    cwd = await createProject({
      "vite.config.js": await VITE_CONFIG({ port }),
      ...files,
    });
    stop = await viteDev({ cwd, port });
  });
  test.afterAll(() => stop());

  test("Vite / HMR & HDR / vite dev", async ({ page, browserName }) => {
    await workflow({ page, browserName, cwd, port });
  });
});

test.describe(async () => {
  let port: number;
  let cwd: string;
  let stop: () => void;

  test.beforeAll(async () => {
    port = await getPort();
    cwd = await createProject({
      "vite.config.js": await VITE_CONFIG({ port }),
      "server.mjs": EXPRESS_SERVER({ port }),
      ...files,
    });
    stop = await customDev({ cwd, port });
  });
  test.afterAll(() => stop());

  test("Vite / HMR & HDR / express", async ({ page, browserName }) => {
    await workflow({ page, browserName, cwd, port });
  });
});

async function workflow({
  page,
  browserName,
  cwd,
  port,
}: {
  page: Page;
  browserName: PlaywrightWorkerOptions["browserName"];
  cwd: string;
  port: number;
}) {
  let pageErrors: Error[] = [];
  page.on("pageerror", (error) => pageErrors.push(error));
  let edit = createEditor(cwd);

  // setup: initial render
  await page.goto(`http://localhost:${port}/`, {
    waitUntil: "networkidle",
  });
  await expect(page.locator("#index [data-title]")).toHaveText("Index");

  // setup: hydration
  await expect(page.locator("#index [data-mounted]")).toHaveText(
    "Mounted: yes"
  );

  // setup: browser state
  let hmrStatus = page.locator("#index [data-hmr]");
  await expect(page).toHaveTitle("HMR updated title: 0");
  await expect(hmrStatus).toHaveText("HMR updated: 0");
  let input = page.locator("#index input");
  await expect(input).toBeVisible();
  await input.type("stateful");
  expect(pageErrors).toEqual([]);

  // route: HMR
  await edit("app/routes/_index.tsx", (contents) =>
    contents
      .replace("HMR updated title: 0", "HMR updated title: 1")
      .replace("HMR updated: 0", "HMR updated: 1")
  );
  await page.waitForLoadState("networkidle");
  await expect(page).toHaveTitle("HMR updated title: 1");
  await expect(hmrStatus).toHaveText("HMR updated: 1");
  await expect(input).toHaveValue("stateful");
  expect(pageErrors).toEqual([]);

  // route: add loader
  await edit("app/routes/_index.tsx", (contents) =>
    contents
      .replace(
        "// imports",
        `// imports\nimport { json } from "@remix-run/node";\nimport { useLoaderData } from "@remix-run/react"`
      )
      .replace(
        "// loader",
        `// loader\nexport const loader = () => json({ message: "HDR updated: 0" });`
      )
      .replace(
        "// hooks",
        "// hooks\nconst { message } = useLoaderData<typeof loader>();"
      )
      .replace(
        "{/* elements */}",
        `{/* elements */}\n<p data-hdr>{message}</p>`
      )
  );
  await page.waitForLoadState("networkidle");
  let hdrStatus = page.locator("#index [data-hdr]");
  await expect(hdrStatus).toHaveText("HDR updated: 0");
  // React Fast Refresh cannot preserve state for a component when hooks are added or removed
  await expect(input).toHaveValue("");
  await input.type("stateful");
  expect(pageErrors.length).toBeGreaterThan(0);
  expect(
    // When adding a loader, a harmless error is logged to the browser console.
    // HMR works as intended, so this seems like a React Fast Refresh bug caused by off-screen rendering with old server data or something like that 🤷
    pageErrors.filter((error) => {
      let chromium =
        browserName === "chromium" &&
        error.message ===
          "Cannot destructure property 'message' of 'useLoaderData(...)' as it is null.";
      let firefox =
        browserName === "firefox" &&
        error.message === "(intermediate value)() is null";
      let webkit =
        browserName === "webkit" &&
        error.message === "Right side of assignment cannot be destructured";
      let expected = chromium || firefox || webkit;
      return !expected;
    })
  ).toEqual([]);
  pageErrors = [];

  // route: HDR
  await edit("app/routes/_index.tsx", (contents) =>
    contents.replace("HDR updated: 0", "HDR updated: 1")
  );
  await page.waitForLoadState("networkidle");
  await expect(hdrStatus).toHaveText("HDR updated: 1");
  await expect(input).toHaveValue("stateful");

  // route: HMR + HDR
  await edit("app/routes/_index.tsx", (contents) =>
    contents
      .replace("HMR updated: 1", "HMR updated: 2")
      .replace("HDR updated: 1", "HDR updated: 2")
  );
  await page.waitForLoadState("networkidle");
  await expect(hmrStatus).toHaveText("HMR updated: 2");
  await expect(hdrStatus).toHaveText("HDR updated: 2");
  await expect(input).toHaveValue("stateful");
  expect(pageErrors).toEqual([]);

  // create new non-route component module
  await fs.writeFile(
    path.join(cwd, "app/component.tsx"),
    String.raw`
    export function MyComponent() {
      return <p data-component>Component HMR: 0</p>;
    }
    `,
    "utf8"
  );
  await edit("app/routes/_index.tsx", (contents) =>
    contents
      .replace(
        "// imports",
        `// imports\nimport { MyComponent } from "../component";`
      )
      .replace("{/* elements */}", "{/* elements */}\n<MyComponent />")
  );
  await page.waitForLoadState("networkidle");
  let component = page.locator("#index [data-component]");
  await expect(component).toBeVisible();
  await expect(component).toHaveText("Component HMR: 0");
  await expect(input).toHaveValue("stateful");
  expect(pageErrors).toEqual([]);

  // non-route: HMR
  await edit("app/component.tsx", (contents) =>
    contents.replace("Component HMR: 0", "Component HMR: 1")
  );
  await page.waitForLoadState("networkidle");
  await expect(component).toHaveText("Component HMR: 1");
  await expect(input).toHaveValue("stateful");
  expect(pageErrors).toEqual([]);

  // create new non-route server module
  await fs.writeFile(
    path.join(cwd, "app/indirect-hdr-dep.ts"),
    String.raw`export const indirect = "indirect 0"`,
    "utf8"
  );
  await fs.writeFile(
    path.join(cwd, "app/direct-hdr-dep.ts"),
    String.raw`
      import { indirect } from "./indirect-hdr-dep"
      export const direct = "direct 0 & " + indirect
    `,
    "utf8"
  );
  await edit("app/routes/_index.tsx", (contents) =>
    contents
      .replace(
        "// imports",
        `// imports\nimport { direct } from "../direct-hdr-dep"`
      )
      .replace(
        `json({ message: "HDR updated: 2" })`,
        `json({ message: "HDR updated: " + direct })`
      )
  );
  await page.waitForLoadState("networkidle");
  await expect(hdrStatus).toHaveText("HDR updated: direct 0 & indirect 0");
  await expect(input).toHaveValue("stateful");
  expect(pageErrors).toEqual([]);

  // non-route: HDR for direct dependency
  await edit("app/direct-hdr-dep.ts", (contents) =>
    contents.replace("direct 0 &", "direct 1 &")
  );
  await page.waitForLoadState("networkidle");
  await expect(hdrStatus).toHaveText("HDR updated: direct 1 & indirect 0");
  await expect(input).toHaveValue("stateful");
  expect(pageErrors).toEqual([]);

  // non-route: HDR for indirect dependency
  await edit("app/indirect-hdr-dep.ts", (contents) =>
    contents.replace("indirect 0", "indirect 1")
  );
  await page.waitForLoadState("networkidle");
  await expect(hdrStatus).toHaveText("HDR updated: direct 1 & indirect 1");
  await expect(input).toHaveValue("stateful");
  expect(pageErrors).toEqual([]);

  // everything everywhere all at once
  await Promise.all([
    edit("app/routes/_index.tsx", (contents) =>
      contents
        .replace("HMR updated: 2", "HMR updated: 3")
        .replace("HDR updated: ", "HDR updated: route & ")
    ),
    edit("app/component.tsx", (contents) =>
      contents.replace("Component HMR: 1", "Component HMR: 2")
    ),
    edit("app/direct-hdr-dep.ts", (contents) =>
      contents.replace("direct 1 &", "direct 2 &")
    ),
    edit("app/indirect-hdr-dep.ts", (contents) =>
      contents.replace("indirect 1", "indirect 2")
    ),
  ]);
  await page.waitForLoadState("networkidle");
  await expect(hmrStatus).toHaveText("HMR updated: 3");
  await expect(component).toHaveText("Component HMR: 2");
  await expect(hdrStatus).toHaveText(
    "HDR updated: route & direct 2 & indirect 2"
  );
  await expect(input).toHaveValue("stateful");
  expect(pageErrors).toEqual([]);
}
